import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { documentDataDir } from "../document-extension-settings.js";

const queues = new Map<string, Promise<unknown>>();
export const digest = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");
export const jsonText = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

export function within(root: string, path: string): boolean {
	const part = relative(root, path);
	return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}

/** Reject links at every component, including existing output parents. */
export function assertPlainPath(path: string): void {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
		current = join(current, part);
		try {
			if (lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export function workspacePath(cwd: string): string {
	const result = realpathSync(cwd);
	if (!lstatSync(result).isDirectory()) throw new Error("Workspace must be a directory");
	return result;
}

export function safePath(root: string, child: string): string {
	const path = resolve(root, child);
	if (!within(root, path) || path === root) throw new Error(`Path escapes its managed root: ${child}`);
	assertPlainPath(path);
	return path;
}

export function privateDirectory(cwd: string): string {
	// realpath resolves platform-owned aliases such as macOS /var before checking our subtree.
	const configured = documentDataDir();
	mkdirSync(configured, { recursive: true, mode: 0o700 });
	const root = join(realpathSync(configured), "document-jobs", digest(cwd).slice(0, 24));
	assertPlainPath(root);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	return root;
}

export function readJson<T>(path: string, limit = 16 * 1024 * 1024): T {
	assertPlainPath(path);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > limit) throw new Error(`Invalid or oversized state file: ${path}`);
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function fileHash(path: string): string | null {
	assertPlainPath(path);
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error(`Expected a bounded regular file: ${path}`);
		return digest(readFileSync(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function atomicWrite(path: string, contents: string): void {
	assertPlainPath(path);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
		assertPlainPath(path);
		renameSync(temporary, path);
	} finally { rmSync(temporary, { force: true }); }
}

export interface PendingWrite { path: string; expectedHash: string | null; contents: string }
interface Transaction { version: 1; cwd: string; outputDirectory: string; writes: PendingWrite[] }

/** Manifest is the final write. Replay accepts only the old content or our exact new content. */
export async function recoverTransaction(cwd: string): Promise<void> {
	const journal = join(privateDirectory(cwd), "transaction.json");
	if (!existsSync(journal)) return;
	const transaction = readJson<Transaction>(journal, 64 * 1024 * 1024);
	if (transaction.version !== 1 || transaction.cwd !== cwd || !Array.isArray(transaction.writes)) throw new Error("Invalid ingestion recovery journal");
	if (!within(cwd, transaction.outputDirectory) || cwd === transaction.outputDirectory) throw new Error("Recovery output is outside the workspace");
	for (const item of transaction.writes) {
		const path = safePath(transaction.outputDirectory, item.path);
		await withFileMutationQueue(path, async () => {
			const current = fileHash(path);
			if (current === digest(item.contents)) return;
			if (current !== item.expectedHash) throw new Error(`Recovery preserved an externally modified file: ${item.path}. Restore the expected version or resolve this ingestion transaction before retrying.`);
			atomicWrite(path, item.contents);
		});
	}
	rmSync(journal);
}

export async function commitTransaction(cwd: string, writes: PendingWrite[], outputDirectory = join(cwd, "knowledge")): Promise<void> {
	if (!writes.length) return;
	const journal = join(privateDirectory(cwd), "transaction.json");
	if (existsSync(journal)) throw new Error("An ingestion transaction already needs recovery");
	const contents = jsonText({ version: 1, cwd, outputDirectory, writes } satisfies Transaction);
	if (Buffer.byteLength(contents) > 64 * 1024 * 1024) throw new Error("Ingestion transaction exceeds 64 MiB; publish a smaller batch. Previous state was preserved.");
	atomicWrite(journal, contents);
	await recoverTransaction(cwd);
}

function waitWithSignal<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return task;
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Ingestion cancelled"));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Ingestion cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		task.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
	});
}

export async function withKnowledgeLock<T>(inputCwd: string, action: (cwd: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	const cwd = workspacePath(inputCwd);
	const prior = queues.get(cwd) ?? Promise.resolve();
	const task = prior.catch(() => undefined).then(async () => {
		signal?.throwIfAborted();
		const folder = privateDirectory(cwd);
		let release: (() => Promise<void>) | undefined;
		for (let attempt = 0; !release; attempt++) {
			signal?.throwIfAborted();
			try { release = await lockfile.lock(folder, { realpath: false, stale: 120_000, retries: 0 }); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= 40) throw error;
				await delay(100, undefined, { signal });
			}
		}
		try {
			signal?.throwIfAborted();
			await recoverTransaction(cwd);
			return await action(cwd);
		} finally { await release(); }
	});
	queues.set(cwd, task);
	void task.finally(() => { if (queues.get(cwd) === task) queues.delete(cwd); }).catch(() => undefined);
	return waitWithSignal(task, signal);
}
