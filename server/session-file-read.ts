import { statSync, type Stats } from "node:fs";
import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { parseSessionEntries, type SessionManager } from "@earendil-works/pi-coding-agent";

type Source = Pick<SessionManager, "getEntry" | "getEntries" | "getHeader">;
const stamp = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const matches = (native: unknown, disk: unknown) => native !== undefined && isDeepStrictEqual(JSON.parse(JSON.stringify(native)), disk);

/** Verify the baseline once, then read only appended bytes except for equal-size stamp changes. */
export class SessionTailValidator {
	private previous?: Stats;
	private verified = new Set<string>();
	private invalid = false;
	private missing = false;
	private disposed = false;
	private pending?: Promise<boolean>;
	private worker?: Worker;
	get checking() { return !!this.pending; }
	private blockingCheck = false;
	get blocking() { return this.checking && this.blockingCheck; }
	dispose() { this.disposed = true; void this.worker?.terminate(); }
	async ready(): Promise<boolean> { return this.pending ?? !this.invalid; }
	async verify(source: Source): Promise<boolean> { return this.check(source) ?? this.ready(); }
	/** Includes baseline I/O; callers can measure subsequent reads by subtracting the initial value. */
	bytesRead = 0;
	constructor(private path: string, source: Source, private changed: () => void = () => {}) {
		this.check(source);
	}
	check(source: Source): boolean | undefined {
		if (this.invalid || this.disposed) return false;
		if (this.pending) return undefined;
		this.blockingCheck = true;
		try {
			const current = statSync(this.path);
			this.blockingCheck = !this.previous || current.size <= this.previous.size || current.ino !== this.previous.ino || current.dev !== this.previous.dev;
			if (this.previous && stamp(this.previous) === stamp(current)) return true;
		} catch (error) { if (this.missing && (error as NodeJS.ErrnoException).code === "ENOENT") return true; }
		const finish = (valid: boolean) => {
			this.pending = undefined;
			if (this.disposed) return false;
			this.invalid = !valid;
			if (this.blockingCheck || !valid) this.changed();
			return valid;
		};
		this.pending = this.validate(source).then(finish, () => finish(false));
		return undefined;
	}
	private compareInWorker(request: { text: string } | { native: unknown }): Promise<{ id?: unknown; equal?: boolean }> {
		const worker = this.worker ??= new Worker(new URL(import.meta.url.endsWith(".ts") ? "./session-record-worker.ts" : "./session-record-worker.js", import.meta.url), { execArgv: process.execArgv.filter(arg => !arg.startsWith("--watch")) });
		return new Promise((resolve, reject) => {
			const cleanup = () => { worker.off("message", message); worker.off("error", failed); worker.off("exit", exited); };
			const failed = (error: Error) => { cleanup(); reject(error); };
			const exited = () => failed(new Error("Record validation cancelled"));
			const message = (result: { id?: unknown; equal?: boolean; error?: boolean }) => { cleanup(); if (result.error) reject(new Error("Invalid session record")); else resolve(result); };
			worker.once("message", message); worker.once("error", failed); worker.once("exit", exited);
			worker.postMessage(request);
		});
	}
	private async validate(source: Source): Promise<boolean> {
		let handle: FileHandle | undefined;
		let observed = false;
		try {
			const current = await stat(this.path);
			observed = true;
			const previous = this.previous;
			if (previous && stamp(previous) === stamp(current)) return true;
			if (previous && (previous.ino !== current.ino || previous.dev !== current.dev || current.size < previous.size)) return false;
			const full = !previous || current.size === previous.size;
			const offset = full ? 0 : previous.size;
			const expected = full ? [source.getHeader(), ...source.getEntries()] : undefined;
			const added = new Set<string>();
			let index = 0;
			const accept = async (line: string): Promise<boolean> => {
				if (!line.trim()) return true;
				let id: unknown, equal: boolean;
				if (line.length > 256 * 1024) {
					({ id } = await this.compareInWorker({ text: line }));
					const native = full ? expected![index] : typeof id === "string" ? source.getEntry(id) : undefined;
					equal = (await this.compareInWorker({ native })).equal === true;
				} else {
					const entry = JSON.parse(line); id = entry?.id;
					equal = matches(full ? expected![index] : typeof id === "string" ? source.getEntry(id) : undefined, entry);
				}
				if (!equal || (!full && typeof id === "string" && this.verified.has(id))) return false;
				if (!(full && index === 0)) {
					if (typeof id !== "string" || added.has(id)) return false;
					added.add(id);
				}
				index++;
				return true;
			};
			handle = await open(this.path, "r");
			const opened = await handle.stat();
			if (stamp(opened) !== stamp(current)) {
				if (opened.ino !== current.ino || opened.dev !== current.dev || opened.size < current.size) return false;
				await handle.close(); handle = undefined;
				return this.disposed ? false : this.validate(source);
			}
			const buffer = Buffer.alloc(64 * 1024), decoder = new StringDecoder("utf8");
			let position = offset;
			let fragments: string[] = [];
			while (position < current.size) {
				if (this.disposed) return false;
				const { bytesRead: n } = await handle.read(buffer, 0, Math.min(buffer.length, current.size - position), position);
				if (!n) return false;
				position += n; this.bytesRead += n;
				const text = decoder.write(buffer.subarray(0, n));
				let start = 0, newline: number;
				while ((newline = text.indexOf("\n", start)) !== -1) {
					fragments.push(text.slice(start, newline));
					if (!await accept(fragments.join(""))) return false;
					fragments = [];
					start = newline + 1;
				}
				if (start < text.length) fragments.push(text.slice(start));
				await yieldLoop();
			}
			const after = await stat(this.path);
			if (stamp(await handle.stat()) !== stamp(current) || stamp(after) !== stamp(current)) {
				if (after.ino !== current.ino || after.dev !== current.dev || after.size < current.size) return false;
				await handle.close(); handle = undefined;
				// Native writes may continue during metadata verification. Retry against
				// the new snapshot instead of treating our own append as a conflict.
				return this.disposed ? false : this.validate(source);
			}
			if (decoder.end() || fragments.length || !index || (expected && index !== expected.length)) return false;
			if (full) this.verified = added;
			else for (const id of added) this.verified.add(id);
			this.previous = current;
			this.missing = false;
			return true;
		} catch (error) {
			this.missing = !observed && !this.previous && (error as NodeJS.ErrnoException).code === "ENOENT";
			return this.missing;
		} finally { await handle?.close(); if (this.worker) { const worker = this.worker; this.worker = undefined; await worker.terminate(); } }
	}
}

/** Listing must never instantiate a SessionManager: open() can migrate and rewrite files. */
export class SessionBranchCounts {
	private cache = new Map<string, { stamp: string; count: number }>();
	async getMany(paths: readonly string[]): Promise<(number | undefined)[]> {
		const results = new Array<number | undefined>(paths.length);
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(8, paths.length) }, async () => {
			while (next < paths.length) {
				const index = next++;
				results[index] = await this.get(paths[index]);
			}
		}));
		return results;
	}
	async get(path: string): Promise<number | undefined> {
		try {
			const before = await stat(path), key = stamp(before);
			const cached = this.cache.get(path);
			if (cached?.stamp === key) return cached.count;
			const entries = parseSessionEntries(await readFile(path, "utf8"));
			if (stamp(await stat(path)) !== key) return undefined;
			const parents = new Map<string, number>();
			for (const entry of entries) if ("parentId" in entry && entry.parentId) parents.set(entry.parentId, (parents.get(entry.parentId) ?? 0) + 1);
			const count = [...parents.values()].filter(n => n > 1).length;
			this.cache.delete(path); this.cache.set(path, { stamp: key, count });
			if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
			return count;
		} catch { this.cache.delete(path); return undefined; }
	}
}
