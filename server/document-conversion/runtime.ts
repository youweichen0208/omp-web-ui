import { spawn } from "node:child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, access, writeFile, stat, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { killPidTree } from "../process-utils.js";
import { documentDataDir, getDocumentSettings } from "./settings.js";

export const DOCLING_VERSION = "2.136.0";
export const CONVERSION_PROFILE = "docling-cpu-zh-v1";
export interface RuntimeDoctor {
	ready: boolean;
	pythonPath?: string;
	parserVersion?: string;
	missing: string[];
	warnings: string[];
}
export interface RuntimeOptions { signal?: AbortSignal; onProgress?: (message: string) => void }
const ownedChildren = new Set<ChildProcess>();
let shuttingDown = false;
function trackChild(child: ChildProcess): void { ownedChildren.add(child); child.once("close", () => ownedChildren.delete(child)); }

export async function shutdownDocumentRuntime(): Promise<void> {
	shuttingDown = true;
	if (worker) closeWorker(worker);
	await Promise.all([...ownedChildren].map(child => new Promise<void>(resolve => {
		const done = () => { clearTimeout(timer); resolve(); };
		const timer = setTimeout(done, 5000);
		child.once("close", done);
		if (child.pid) killPidTree(child.pid); else done();
	})));
}

export async function waitDocumentQueue(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (!signal) return previous;
	await new Promise<void>((resolve, reject) => {
		const abort = () => reject(new DOMException("Document operation canceled", "AbortError"));
		signal.addEventListener("abort", abort, { once: true });
		previous.then(() => { signal.removeEventListener("abort", abort); resolve(); }, error => { signal.removeEventListener("abort", abort); reject(error); });
	});
}

export function runtimeDirectory(): string {
	return getDocumentSettings().runtimePath ?? join(documentDataDir(), "runtimes", CONVERSION_PROFILE);
}
export function runtimePython(): string {
	return join(runtimeDirectory(), "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}
export function bridgePath(): string { return fileURLToPath(new URL("./python/bridge.py", import.meta.url)); }

/** A separate process group lets cancellation remove only this conversion's children. */
export async function runDocumentProcess(command: string, args: string[], options: RuntimeOptions & { timeout?: number; offline?: boolean; input?: unknown } = {}): Promise<string> {
	if (shuttingDown) throw new Error("Document runtime is shutting down");
	options.signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
			env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1", ...(options.offline ? { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" } : {}) },
		});
		trackChild(child);
		let stdout = "", stderr = "", pending = "", failure: Error | undefined, lastProgress = 0;
		const stop = (error: Error) => { failure = error; if (child.pid) killPidTree(child.pid); };
		const abort = () => stop(new DOMException("Document operation canceled", "AbortError"));
		const timer = setTimeout(() => stop(new Error("Document operation timed out")), options.timeout ?? 30 * 60_000);
		options.signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (stdout.length > 4 * 1024 * 1024) stop(new Error("Parser response exceeds 4 MiB"));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8"); stderr = (stderr + text).slice(-32_768); pending += text;
			const lines = pending.split(/\r\n|\r|\n/); pending = lines.pop() ?? "";
			const latest = lines.map(line => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim()).filter(Boolean).at(-1);
			if (latest && Date.now() - lastProgress >= 400) { options.onProgress?.(latest.slice(0, 1000)); lastProgress = Date.now(); }
			if (pending.length > 2000) pending = pending.slice(-2000);
		});
		child.on("error", error => { failure = error; });
		child.on("close", code => {
			clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else if (code !== 0) reject(new Error(`Document process failed (${code}): ${stderr.trim().slice(-6000)}`));
			else resolve(stdout.trim());
		});
		child.stdin.on("error", () => { /* Child errors are reported by close. */ });
		child.stdin.end(options.input === undefined ? undefined : JSON.stringify(options.input));
		if (options.signal?.aborted) abort();
	});
}

export async function doctorRuntime(options: RuntimeOptions = {}): Promise<RuntimeDoctor> {
	const pythonPath = runtimePython();
	try {
		await access(pythonPath);
		const result: RuntimeDoctor = JSON.parse(await runDocumentProcess(pythonPath, [bridgePath(), "doctor", runtimeDirectory()], { ...options, timeout: 60_000, offline: true }));
		return { ...result, pythonPath };
	} catch (error) {
		options.signal?.throwIfAborted();
		return { ready: false, pythonPath, missing: [error instanceof Error ? error.message : String(error)], warnings: [] };
	}
}

let qualification: { root: string; signature: string; result: RuntimeDoctor } | undefined;
async function qualificationSignature(root: string): Promise<string> {
	const receipt = await readFile(join(root, "ready.json"), "utf8");
	const parsed: { models?: Record<string, unknown> } = JSON.parse(receipt);
	const assets = (await readdir(dirname(bridgePath()))).filter(name => name.endsWith(".py")).sort().map(name => join(dirname(bridgePath()), name));
	const paths = [join(root, "ready.json"), join(root, "requirements.lock"), runtimePython(), ...assets, ...Object.keys(parsed.models ?? {}).sort().map(path => join(root, "models", path))];
	const identities = await Promise.all(paths.map(async path => { const value = await stat(path); return [path, value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs]; }));
	return JSON.stringify([receipt, identities]);
}

/** Explicit doctor always hashes models; conversions reuse a successful check
 * until the receipt, dependency lock, Python executable or model files change. */
export async function ensureRuntimeReady(options: RuntimeOptions = {}): Promise<RuntimeDoctor> {
	options.signal?.throwIfAborted();
	const root = runtimeDirectory();
	let signature: string | undefined;
	try { signature = await qualificationSignature(root); } catch { /* Doctor gives actionable missing-runtime details. */ }
	if (signature !== undefined && qualification?.root === root && qualification.signature === signature) return qualification.result;
	const result = await doctorRuntime(options);
	if (result.ready && signature !== undefined) qualification = { root, signature, result };
	else qualification = undefined;
	return result;
}

let setupPromise: Promise<RuntimeDoctor> | undefined;
export async function setupRuntime(options: RuntimeOptions = {}): Promise<RuntimeDoctor> {
	if (setupPromise) throw new Error("Document runtime setup is already running");
	setupPromise = performSetup(options);
	try { return await setupPromise; } finally { setupPromise = undefined; }
}
async function performSetup(options: RuntimeOptions): Promise<RuntimeDoctor> {
	if (process.platform === "darwin" && process.arch === "x64") throw new Error("The current local Docling profile has not been qualified on Intel macOS. A separately tested runtime is required.");
	const root = runtimeDirectory(), pythonPath = runtimePython();
	await mkdir(root, { recursive: true });
	const release = await lockfile.lock(root, { realpath: false, stale: 120_000, retries: 0 });
	try {
		const existing = await doctorRuntime(options);
		if (existing.ready) { options.onProgress?.("The isolated document runtime is already qualified"); return existing; }
		if (worker?.root === root) closeWorker(worker);
	try { await access(pythonPath); } catch {
		const configured = getDocumentSettings().pythonPath;
		if (configured) {
			const version = await runDocumentProcess(configured, ["-c", "import sys; print('.'.join(map(str,sys.version_info[:2])))"], options);
			if (version !== "3.12") throw new Error(`Python 3.12 is required for this profile; found ${version}`);
			await runDocumentProcess(configured, ["-m", "venv", join(root, "venv")], options);
		} else {
			options.onProgress?.("Creating the isolated Python 3.12 runtime with uv");
			try { await runDocumentProcess("uv", ["venv", "--seed", "--python", "3.12", join(root, "venv")], options); }
			catch (error) { throw new Error(`Install uv or configure an absolute Python 3.12 executable path. ${error instanceof Error ? error.message : error}`); }
		}
	}
	options.onProgress?.(`Installing Docling ${DOCLING_VERSION} in the isolated runtime`);
	const lockPath = join(root, "requirements.lock");
	// The CPU Transformers backend is already a standard dependency. The broad
	// vlm extra additionally installs unrelated MLX/audio backends on Apple Silicon.
	let install = [`docling[rapidocr]==${DOCLING_VERSION}`, "transformers==5.19.0", "rapidocr==3.9.1"];
	try {
		const locked = await readFile(lockPath, "utf8");
		if (!locked.trim().split(/\r?\n/).every(line => /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+$/.test(line))) throw new Error("Invalid document runtime dependency lock");
		install = ["-r", lockPath];
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	try {
		await runDocumentProcess("uv", ["pip", "install", "--python", pythonPath, "--index-url", "https://pypi.org/simple", ...install], { ...options, timeout: 45 * 60_000 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await runDocumentProcess(pythonPath, ["-m", "pip", "install", "--index-url", "https://pypi.org/simple", ...install], { ...options, timeout: 45 * 60_000 });
	}
	const freeze = await runDocumentProcess(pythonPath, ["-m", "pip", "freeze"], options);
	if (!freeze.split(/\r?\n/).every(line => /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+$/.test(line))) throw new Error("Installed dependencies contain unexpected non-registry references");
	await writeFile(lockPath, freeze + "\n");
	options.onProgress?.("Downloading local models and verifying the offline conversion profile");
	await runDocumentProcess(pythonPath, [bridgePath(), "setup", root], { ...options, timeout: 60 * 60_000 });
	return doctorRuntime(options);
	} finally { await release(); }
}

export async function runtimeFingerprint(): Promise<string> {
	return readFile(join(runtimeDirectory(), "ready.json"), "utf8");
}

interface WorkerResponse { status: "complete" | "partial"; warnings: string[]; error?: string }
interface ParserWorker { child: ChildProcessWithoutNullStreams; root: string; idle?: NodeJS.Timeout; pending?: { resolve: (response: WorkerResponse) => void; reject: (error: Error) => void; progress?: (message: string) => void }; stdout: string }
let worker: ParserWorker | undefined;
let workerQueue = Promise.resolve();

function closeWorker(active: ParserWorker): void {
	if (active.idle) clearTimeout(active.idle);
	if (active.child.pid) killPidTree(active.child.pid);
	if (worker === active) worker = undefined;
}
function parserWorker(): ParserWorker {
	if (shuttingDown) throw new Error("Document runtime is shutting down");
	const root = runtimeDirectory();
	if (worker?.root === root) { if (worker.idle) clearTimeout(worker.idle); return worker; }
	if (worker) closeWorker(worker);
	const child = spawn(runtimePython(), [bridgePath(), "serve", root], { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" } });
	trackChild(child);
	const active: ParserWorker = { child, root, stdout: "" }; worker = active;
	child.stdout.on("data", (chunk: Buffer) => {
		active.stdout += chunk.toString("utf8");
		if (active.stdout.length > 4 * 1024 * 1024) { active.pending?.reject(new Error("Parser response exceeds 4 MiB")); closeWorker(active); return; }
		let end: number;
		while ((end = active.stdout.indexOf("\n")) >= 0) {
			const line = active.stdout.slice(0, end); active.stdout = active.stdout.slice(end + 1);
			try { const response: WorkerResponse = JSON.parse(line); if (response.error) active.pending?.reject(new Error(response.error)); else active.pending?.resolve(response); }
			catch { active.pending?.reject(new Error("Invalid parser response")); closeWorker(active); }
		}
	});
	let errorTail = "";
	child.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString("utf8"); errorTail = (errorTail + text).slice(-6000); for (const line of text.split(/\r?\n/)) if (line.trim()) active.pending?.progress?.(line.slice(0, 1000)); });
	child.on("error", error => { active.pending?.reject(error); if (worker === active) worker = undefined; });
	child.on("close", code => { active.pending?.reject(new Error(`Document worker exited (${code}): ${errorTail}`)); if (worker === active) worker = undefined; });
	child.stdin.on("error", error => active.pending?.reject(error));
	return active;
}

/** One queued local worker keeps model weights warm without parallel RAM spikes. */
export async function runConversionWorker(input: { inputPath: string; outputDir: string; sourceHash: string }, options: RuntimeOptions): Promise<WorkerResponse> {
	const previous = workerQueue;
	let release!: () => void;
	const gate = new Promise<void>(done => { release = done; });
	workerQueue = previous.then(() => gate);
	try {
		await waitDocumentQueue(previous, options.signal);
		options.signal?.throwIfAborted();
		const active = parserWorker();
		return await new Promise<WorkerResponse>((resolve, reject) => {
			const finish = (error?: Error, response?: WorkerResponse) => {
				if (!active.pending) return;
				active.pending = undefined; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
				if (error) { closeWorker(active); reject(error); }
				else { active.idle = setTimeout(() => closeWorker(active), 10_000); active.idle.unref(); resolve(response!); }
			};
			const abort = () => finish(new DOMException("Document operation canceled", "AbortError"));
			const timer = setTimeout(() => finish(new Error("Document conversion exceeded 30 minutes")), 30 * 60_000);
			active.pending = { resolve: response => finish(undefined, response), reject: error => finish(error), progress: options.onProgress };
			options.signal?.addEventListener("abort", abort, { once: true });
			active.child.stdin.write(JSON.stringify(input) + "\n");
			if (options.signal?.aborted) abort();
		});
	} finally { release(); }
}
