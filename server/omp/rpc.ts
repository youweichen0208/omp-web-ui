import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Duplex } from "node:stream";
import { ompEnvironment, ompRuntimePaths } from "./paths.js";

export type Frame = Record<string, unknown> & { type: string; id?: string };
const MAX_FRAME = 1024 * 1024;
const MAX_MESSAGE = 64 * MAX_FRAME;

/** Bounded JSONL decoder. Chunk envelopes cannot allocate memory before validation. */
export class RpcDecoder {
	private decoder = new StringDecoder("utf8");
	private pending = "";
	private chunk?: { id: string; count: number; bytes: number; parts: Buffer[]; size: number };
	constructor(private readonly receive: (frame: Frame) => void) {}
	push(bytes: Buffer): void {
		this.pending += this.decoder.write(bytes);
		let newline: number;
		while ((newline = this.pending.indexOf("\n")) >= 0) {
			const line = this.pending.slice(0, newline);
			this.pending = this.pending.slice(newline + 1);
			if (Buffer.byteLength(line) > MAX_FRAME) throw new Error("OMP RPC frame exceeds limit");
			if (line.trim()) this.accept(JSON.parse(line));
		}
		if (Buffer.byteLength(this.pending) > MAX_FRAME) throw new Error("OMP RPC frame exceeds limit");
	}
	end(): void {
		this.pending += this.decoder.end();
		if (this.pending.trim() || this.chunk) throw new Error("OMP RPC ended with an incomplete frame");
	}
	private accept(value: unknown): void {
		if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") throw new Error("Invalid OMP RPC frame");
		const frame = value as Frame;
		if (frame.type !== "rpc_chunk") {
			if (this.chunk) throw new Error("Interrupted OMP RPC chunk sequence");
			this.receive(frame);
			return;
		}
		const { chunkId, index, count, byteLength, data } = frame;
		if (typeof chunkId !== "string" || typeof data !== "string" || !Number.isInteger(index) || !Number.isInteger(count) || !Number.isInteger(byteLength) ||
			Number(count) < 1 || Number(count) > MAX_MESSAGE || Number(byteLength) < 1 || Number(byteLength) > MAX_MESSAGE || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error("Invalid OMP RPC chunk");
		if (!this.chunk) {
			if (index !== 0) throw new Error("OMP RPC chunk sequence must start at zero");
			this.chunk = { id: chunkId, count: Number(count), bytes: Number(byteLength), parts: [], size: 0 };
		}
		const current = this.chunk;
		if (chunkId !== current.id || index !== current.parts.length || count !== current.count || byteLength !== current.bytes) throw new Error("Out-of-order OMP RPC chunk");
		const part = Buffer.from(data, "base64");
		current.size += part.length;
		if (!part.length || current.size > current.bytes) throw new Error("OMP RPC chunk size mismatch");
		current.parts.push(part);
		if (current.parts.length === current.count) {
			if (current.size !== current.bytes) throw new Error("OMP RPC chunk size mismatch");
			this.chunk = undefined;
			const decoded: unknown = JSON.parse(Buffer.concat(current.parts).toString("utf8"));
			if ((decoded as Frame)?.type === "rpc_chunk") throw new Error("Nested OMP RPC chunks");
			this.accept(decoded);
		}
	}
}

export function encodeFrame(frame: Frame): string[] {
	const payload = Buffer.from(JSON.stringify(frame));
	if (payload.length > MAX_MESSAGE) throw new Error("OMP RPC message exceeds limit");
	if (payload.length + 1 <= MAX_FRAME) return [payload.toString("utf8") + "\n"];
	const size = 700_000, count = Math.ceil(payload.length / size), chunkId = randomUUID();
	return Array.from({ length: count }, (_, index) => JSON.stringify({ type: "rpc_chunk", chunkId, index, count, byteLength: payload.length, data: payload.subarray(index * size, (index + 1) * size).toString("base64") }) + "\n");
}

export class OmpRpc {
	private child: ChildProcessWithoutNullStreams;
	private listeners = new Set<(frame: Frame) => void>();
	private requests = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private writes: Promise<void> = Promise.resolve();
	private closed = false;
	private stopping = false;
	private readyResolve!: () => void;
	private readyReject!: (error: Error) => void;
	private readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
	private readyTimer: ReturnType<typeof setTimeout>;
	private stderr = "";
	private exitPromise: Promise<void>;
	private control?: Duplex;
	private restricted = false;
	private failureKill?: ReturnType<typeof setTimeout>;

	constructor(options: { cwd: string; agentDir?: string; args?: string[]; executable?: string; entry?: string; init?: Record<string, unknown> }) {
		const paths = options.executable && options.entry ? { bun: options.executable, cli: options.entry } : ompRuntimePaths();
		this.child = spawn(paths.bun, [paths.cli, "--mode", "rpc-ui", ...(options.args ?? [])], {
			cwd: options.cwd, env: ompEnvironment(options.agentDir), stdio: options.init ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"], windowsHide: true,
		});
		this.readyTimer = setTimeout(() => this.fail(new Error("OMP startup timed out")), 60_000);
		const decoder = new RpcDecoder((frame) => this.receive(frame));
		this.child.stdout.on("data", (chunk: Buffer) => { try { decoder.push(chunk); } catch (error) { this.fail(error as Error); } });
		this.child.stdout.on("end", () => { try { decoder.end(); } catch (error) { if (!this.stopping) this.fail(error as Error); } });
		this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
		if (options.init) {
			this.restricted = options.init.restricted === true;
			this.control = this.child.stdio[3] as Duplex;
			const controlDecoder = new RpcDecoder((frame) => this.receive(frame));
			this.control.on("data", (chunk: Buffer) => { try { controlDecoder.push(chunk); } catch (error) { this.fail(error as Error); } });
			this.control.on("error", (error) => { if (!this.stopping) this.fail(error); });
			this.control.on("end", () => { try { controlDecoder.end(); } catch (error) { if (!this.stopping) this.fail(error as Error); } });
			void this.send({ type: "webui_init", ...options.init }).catch((error: Error) => this.fail(error));
		}
		this.child.stdin.on("error", (error) => { if (!this.stopping) this.fail(error); });
		this.child.on("error", (error) => this.fail(error));
		this.exitPromise = new Promise((resolve) => this.child.once("close", (code, signal) => {
			clearTimeout(this.failureKill);
			this.fail(new Error(`OMP exited (${signal ?? code})`));
			resolve();
		}));
		// A caller may dispose before awaiting start().
		void this.ready.catch(() => {});
	}
	async start(): Promise<void> {
		await this.ready;
		await this.request("negotiate_protocol", { protocolVersion: 2 });
	}
	subscribe(listener: (frame: Frame) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private receive(frame: Frame): void {
		if (frame.type === "ready") {
			if (!Array.isArray(frame.supportedProtocolVersions) || !frame.supportedProtocolVersions.includes(2)) { this.fail(new Error("OMP RPC protocol 2 is required")); return; }
			clearTimeout(this.readyTimer); this.readyResolve();
		} else if (frame.type === "response" && frame.id) {
			const pending = this.requests.get(frame.id);
			if (pending) {
				this.requests.delete(frame.id); clearTimeout(pending.timer);
				if (frame.success === true) pending.resolve(frame.data);
				else pending.reject(new Error(typeof frame.error === "string" ? frame.error : "OMP request failed"));
			}
		}
		for (const listener of this.listeners) listener(frame);
	}
	request<T = unknown>(type: string, fields: Record<string, unknown> = {}, timeoutMs = 60_000, id = randomUUID()): Promise<T> {
		if (this.closed || this.stopping) return Promise.reject(new Error("OMP process is closed"));
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => { this.requests.delete(id); reject(new Error(`OMP request timed out: ${type}`)); }, timeoutMs);
			this.requests.set(id, { resolve: (data) => resolve(data as T), reject, timer });
			void this.send({ ...fields, type, id }).catch((error: Error) => { clearTimeout(timer); this.requests.delete(id); reject(error); });
		});
	}
	send(frame: Frame): Promise<void> {
		if (this.closed || this.stopping) return Promise.reject(new Error("OMP process is closed"));
		const lines = encodeFrame(frame);
		const output = (frame.type.startsWith("webui_") || (this.restricted && frame.type.startsWith("host_tool_"))) && this.control ? this.control : this.child.stdin;
		const write = this.writes.then(async () => {
			if (this.closed || this.stopping) throw new Error("OMP process is closed");
			for (const line of lines) await new Promise<void>((resolve, reject) => output.write(line, (error) => error ? reject(error) : resolve()));
		});
		this.writes = write.catch(() => {});
		return write;
	}
	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.readyTimer);
		this.readyReject(error);
		for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
		this.requests.clear();
		if (!this.stopping) {
			for (const listener of this.listeners) listener({ type: "runtime_error", error: error.message });
			this.child.kill("SIGTERM");
			this.failureKill = setTimeout(() => this.child.kill("SIGKILL"), 2_000);
			this.failureKill.unref();
		}
	}
	async dispose(): Promise<void> {
		if (this.stopping) return this.exitPromise;
		this.stopping = true;
		this.fail(new Error("OMP process closed"));
		this.child.stdin.end();
		const terminate = setTimeout(() => this.child.kill("SIGTERM"), 2000);
		const force = setTimeout(() => this.child.kill("SIGKILL"), 5000);
		try { await this.exitPromise; } finally { clearTimeout(terminate); clearTimeout(force); this.listeners.clear(); }
	}
}
