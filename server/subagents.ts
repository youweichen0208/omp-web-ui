import { fork, execFile, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync, readdirSync } from "node:fs";
import { appendFile, writeFile, rename, unlink, open } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { killPidTree } from "./process-utils.js";
import type { SubagentConfig, SubagentRole, SubagentSummary, SubagentRecord } from "./protocol.js";

export const READ_TOOLS = new Set(["read", "grep", "find", "ls", "web_subagent", "todo", "task_plan", "tool_search"]);
/** Deliberately narrow: shell composition and unknown commands remain mutating. */
export const readOnlyBash = (args: unknown): boolean => {
	const command = (args as { command?: unknown } | undefined)?.command;
	return typeof command === "string" && /^git --no-optional-locks status(?: (?:--short|--branch|--porcelain(?:=[12])?|--untracked-files(?:=(?:no|normal|all))?|-s|-b))*\s*$/.test(command);
};
export const unfinished = (t: SubagentSummary) => ["queued", "running", "stopping"].includes(t.status);
export const upstreamSubagent = (path: string) => /(?:^|[/\\])(?:pi-subagents|subagents)(?:[/\\]|$)/i.test(path) || path.includes("pi-subagents");
const role = (id: string, name: string, tools: string[]): SubagentRole => ({ id, name, description: name, prompt: "Complete only the assigned task. Respect project instructions and user approval/waiting requirements. Do not delegate.", tools, skills: [], extensions: [] });
export const defaultSubagentConfig = (): SubagentConfig => ({ enabled: true, timeoutMs: 1_200_000, roles: [role("analysis", "Analysis", ["read", "grep", "find", "ls"]), role("development", "Development", ["read", "grep", "find", "ls", "edit", "write", "bash"]), role("review", "Review", ["read", "grep", "find", "ls"])] });
interface Live { process: ChildProcess; timeout: NodeJS.Timeout; force?: NodeJS.Timeout; outcome?: { result: string; error?: string; usage?: SubagentSummary["usage"] }; stoppingStatus?: "cancelled" | "failed" | "interrupted"; ready: boolean; pending: Map<string, (error?: string) => void> }
export interface SubagentStart { clientId: string; conversationId: string; parentSessionId: string; parentRound: string; cwd: string; agentDir: string; model: { provider: string; id: string }; thinking: string; roleId: string; task: string; background?: string }

/** Service-wide scheduler. Locks and execution slots survive until child exit. */
export class SubagentManager {
	config = defaultSubagentConfig();
	private tasks = new Map<string, SubagentSummary>();
	private inputs = new Map<string, Pick<SubagentStart, "agentDir">>();
	private durable = new Set<string>();
	private live = new Map<string, Live>();
	private locks = new Map<string, string>();
	private mutations = new Map<string, Set<string>>();
	private listeners = new Set<(task?: SubagentSummary, removed?: string[]) => void>();
	private priorities = new Map<string, Set<string>>();
	private writes: Promise<void> = Promise.resolve();
	private taskWrites = new Map<string, Promise<void>>();
	private launches = new Map<string, Promise<void>>();
	private logSizes = new Map<string, number>();
	private roundCounts = new Map<string, number>();
	private receivers = new Map<string, (task: SubagentSummary) => Promise<void>>();
	private version = Date.now();
	private closing = false;
	private dir = "";
	configuring = false;
	isQuiesced: () => boolean = () => false;
	onResult?: (task: SubagentSummary) => Promise<void>;
	initialize(dataDir: string): void {
		this.dir = join(dataDir, "subagents"); mkdirSync(this.dir, { recursive: true });
		try { this.config = this.validate(JSON.parse(readFileSync(join(this.dir, "config.json"), "utf8"))); } catch { /* first launch */ }
		try {
			const saved = JSON.parse(readFileSync(join(this.dir, "tasks.json"), "utf8")) as { tasks: SubagentSummary[]; inputs: [string, SubagentStart][] };
			this.inputs = new Map(saved.inputs);
			for (const task of saved.tasks) { if (unfinished(task)) { task.status = "interrupted"; task.error = "Service restarted"; task.endedAt = Date.now(); task.version++; } this.tasks.set(task.id, task); this.version = Math.max(this.version, task.version); }
		} catch { /* first launch */ }
		// Migrate the previous aggregate format; subsequent writes touch one task only.
		try { for (const name of readdirSync(join(this.dir, "tasks"))) {
			if (!name.endsWith(".json")) continue;
			try { const { task, agentDir } = JSON.parse(readFileSync(join(this.dir, "tasks", name), "utf8"));
			if (unfinished(task)) { task.status = "interrupted"; task.error = "Service restarted"; task.endedAt = Date.now(); task.version++; }
			this.tasks.set(task.id, task); this.inputs.set(task.id, { agentDir }); this.version = Math.max(this.version, task.version); } catch (error) { console.error(`Invalid subagent record ${name}:`, error); }
		} } catch { /* first launch */ }
		mkdirSync(join(this.dir, "tasks"), { recursive: true });
		const migration = [...this.tasks.values()].map(task => this.save(task));
		// Never delete the aggregate source if any migrated task failed to save.
		void Promise.all(migration).then(() => this.enqueue(() => this.removeFile(join(this.dir, "tasks.json")))).catch(() => {});
		this.prune();
	}
	validate(value: SubagentConfig): SubagentConfig {
		if (typeof value.enabled !== "boolean" || !Number.isFinite(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 86_400_000 || !Array.isArray(value.roles) || value.roles.length < 1 || value.roles.length > 32) throw new Error("Invalid subagent configuration");
		const ids = new Set<string>();
		for (const r of value.roles) {
			if (!r.id || ids.has(r.id) || !r.name || typeof r.prompt !== "string" || typeof r.description !== "string") throw new Error("Invalid role identity"); ids.add(r.id);
			for (const a of [r.tools, r.skills, r.extensions]) if (!Array.isArray(a) || a.some(x => typeof x !== "string" || !x)) throw new Error("Invalid role capabilities");
			if (r.tools.some(x => /subagent|spawn_agent|delegate_agent/.test(x))) throw new Error("Recursive delegation is disabled");
			if (r.model && (!r.model.provider || !r.model.id)) throw new Error("Invalid model");
			if (r.thinking && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(r.thinking)) throw new Error("Invalid thinking level");
		}
		return structuredClone(value);
	}
	configure(config: SubagentConfig): void { this.config = this.validate(config); this.atomic("config.json", this.config); this.changed(); }
	private atomic(file: string, value: unknown): void { if (!this.dir) return; writeFileSync(join(this.dir, file + ".tmp"), JSON.stringify(value)); renameSync(join(this.dir, file + ".tmp"), join(this.dir, file)); }
	/** The tail recovers; callers still receive their own operation's rejection. */
	private enqueue(op: () => Promise<void>): Promise<void> {
		const next = this.writes.then(op);
		this.writes = next.catch(error => console.error("Subagent persistence failed:", error));
		return next;
	}
	private save(task: SubagentSummary): Promise<void> {
		const data = JSON.stringify({ task, agentDir: this.inputs.get(task.id)?.agentDir });
		const path = join(this.dir, "tasks", task.id + ".json");
		const saved = this.enqueue(async () => { await writeFile(path + ".tmp", data); await rename(path + ".tmp", path); });
		this.taskWrites.set(task.id, saved);
		return saved;
	}
	private async removeFile(path: string): Promise<void> {
		try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	/** Flush drains the queue; it does not report another task's previous failure. */
	async flush(): Promise<void> { await this.writes; }
	registerReceiver(clientId: string, fn: (task: SubagentSummary) => Promise<void>): () => void { this.receivers.set(clientId, fn); return () => { if (this.receivers.get(clientId) === fn) this.receivers.delete(clientId); }; }
	private prune(): string[] {
		const cutoff = Date.now() - 30 * 86400000;
		const terminal = [...this.tasks.values()].filter(t => !unfinished(t) && (t.delivered || ["cancelled", "interrupted"].includes(t.status) || (t.endedAt ?? t.createdAt) < cutoff)).sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
		const removed: string[] = [];
		for (const [index, task] of terminal.entries()) if (index >= 200 || (task.endedAt ?? task.createdAt) < cutoff) {
			removed.push(task.id); this.tasks.delete(task.id); this.inputs.delete(task.id); this.logSizes.delete(task.id); this.durable.delete(task.id); this.taskWrites.delete(task.id); this.launches.delete(task.id);
			void this.enqueue(() => this.removeFile(join(this.dir, "tasks", task.id + ".json")));
			void this.enqueue(() => this.removeFile(join(this.dir, task.id + ".jsonl")));
		}
		return removed;
	}
	subscribe(fn: (task?: SubagentSummary, removed?: string[]) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
	state(clientId: string) { return { type: "subagent_state" as const, version: this.version, config: structuredClone(this.config), tasks: [...this.tasks.values()].filter(t => t.clientId === clientId).sort((a, b) => a.createdAt - b.createdAt).map(t => this.listItem(t)) }; }
	listItem(t: SubagentSummary) { const { id, conversationId, model, thinking, status, createdAt, startedAt, endedAt, version, usage, queueReason } = t; return { queueReason, id, conversationId, model, thinking, status, createdAt, startedAt, endedAt, version, usage, role: { id: t.role.id, name: t.role.name }, task: t.task.slice(0, 240) }; }
	private changed(task?: SubagentSummary, persist = true): Promise<void> { this.version++; if (task) task.version = this.version; const saved = task && persist ? this.save(task) : Promise.resolve(); const removed = this.prune(); for (const fn of this.listeners) fn(task, removed); return saved; }
	get(id: string, clientId: string, conversationId?: string): SubagentSummary { const t = this.tasks.get(id); if (!t || t.clientId !== clientId || (conversationId && t.conversationId !== conversationId)) throw new Error("Task does not belong to this conversation"); return t; }
	rebind(clientId: string, parentSessionId: string, conversationId: string): void {
		for (const task of this.tasks.values()) if (task.clientId === clientId && task.parentSessionId === parentSessionId && task.conversationId !== conversationId) { task.conversationId = conversationId; this.changed(task); }
	}
	has(clientId: string, conversationId?: string): boolean { return [...this.tasks.values()].some(t => t.clientId === clientId && (!conversationId || t.conversationId === conversationId) && unfinished(t)); }
	beginRound(clientId: string, sessionId: string, round: string): void { this.roundCounts.set(JSON.stringify([clientId, sessionId, round]), 0); }
	endRound(clientId: string, sessionId: string, round: string): void { this.roundCounts.delete(JSON.stringify([clientId, sessionId, round])); }
	spawn(input: SubagentStart): SubagentSummary {
		if (!this.config.enabled || this.closing || this.configuring || this.isQuiesced()) throw new Error("Built-in subagents are disabled or admission is paused");
		if (!input.task.trim() || input.task.length > 100_000 || (input.background?.length ?? 0) > 100_000) throw new Error("Invalid task/background");
		if ([...this.tasks.values()].filter(unfinished).length >= 256) throw new Error("Maximum 256 unfinished subagents across the service");
		const roundKey = JSON.stringify([input.clientId, input.parentSessionId, input.parentRound]);
		const count = this.roundCounts.get(roundKey) ?? [...this.tasks.values()].filter(t => t.clientId === input.clientId && t.parentSessionId === input.parentSessionId && t.parentRound === input.parentRound).length;
		if (count >= 16) throw new Error("Maximum 16 subagents per parent round");
		const selected = this.config.roles.find(r => r.id === input.roleId); if (!selected) throw new Error("Unknown subagent role");
		const snapshot = structuredClone(selected);
		const t: SubagentSummary = { ...input, background: input.background ?? "", id: randomUUID(), cwd: realpathSync(input.cwd), role: snapshot, model: snapshot.model ?? input.model, thinking: snapshot.thinking ?? input.thinking, timeoutMs: this.config.timeoutMs, status: "queued", createdAt: Date.now(), version: 0 };
		if (this.roundCounts.has(roundKey)) this.roundCounts.set(roundKey, count + 1);
		this.tasks.set(t.id, t); this.inputs.set(t.id, { agentDir: input.agentDir });
		const saved = this.changed(t);
		const launched = saved.then(() => { if (t.status === "queued") { this.durable.add(t.id); this.pump(); } }, error => {
			if (t.status === "queued") { t.status = "failed"; t.delivered = true; t.error = `Unable to save launch: ${String(error)}`; t.endedAt = Date.now(); this.changed(t); }
			throw error;
		});
		this.launches.set(t.id, launched);
		void launched.catch(() => {});
		return t;
	}
	async whenLaunched(task: SubagentSummary): Promise<void> { await this.launches.get(task.id); }
	rerun(id: string, clientId: string, conversationId: string, parentSessionId: string, parentRound: string): SubagentSummary { const t = this.get(id, clientId, conversationId); if (unfinished(t)) throw new Error("Task is still active"); const i = this.inputs.get(id); if (!i) throw new Error("No saved launch configuration"); return this.spawn({ clientId, conversationId, parentSessionId, parentRound, cwd: t.cwd, agentDir: i.agentDir, model: t.model, thinking: t.thinking, roleId: t.role.id, task: t.task, background: t.background }); }
	/** Unknown tools are potentially mutating, including terminal and MCP tools. */
	enter(cwd: string, owner: string, toolId: string, toolName: string, args?: unknown): string | undefined {
		if (READ_TOOLS.has(toolName) || (toolName === "bash" && readOnlyBash(args))) return;
		if (!this.config.enabled && !this.locks.size && ![...this.tasks.values()].some(t => unfinished(t))) return;
		let key: string; try { key = realpathSync(cwd); } catch { return "Project directory is unavailable"; }
		const lock = this.locks.get(key); if (lock && lock !== owner) return `Project write lock held by subagent ${lock}`;
		let set = this.mutations.get(key); if (!set) this.mutations.set(key, set = new Set()); set.add(owner + ":" + toolId);
		let priority = this.priorities.get(key); if (!priority) this.priorities.set(key, priority = new Set()); priority.add(owner);
	}
	yield(owner: string): void { for (const [key, set] of this.priorities) { set.delete(owner); if (!set.size) this.priorities.delete(key); } this.pump(); }
	leave(_cwd: string, owner: string, toolId?: string): void {
		for (const [key, set] of this.mutations) { for (const id of set) if (toolId ? id === owner + ":" + toolId : id.startsWith(owner + ":")) set.delete(id); if (!set.size) this.mutations.delete(key); }
		if (!toolId) for (const [key, set] of this.priorities) { set.delete(owner); if (!set.size) this.priorities.delete(key); }
		this.pump();
	}
	private pump(): void {
		if (this.closing) return;
		for (const t of this.tasks.values()) {
			if (t.status !== "queued" || !this.durable.has(t.id)) continue;
			const writing = t.role.tools.some(n => !READ_TOOLS.has(n));
			const locked = writing && (this.locks.has(t.cwd) || this.mutations.get(t.cwd)?.size || this.priorities.get(t.cwd)?.size);
			const reason = locked ? "write_lock" : this.live.size >= 4 ? "capacity" : undefined;
			if (t.queueReason !== reason) { t.queueReason = reason; this.changed(t); }
			if (reason) continue;
			if (writing) this.locks.set(t.cwd, t.id);
			this.start(t);
		}
	}
	private start(t: SubagentSummary): void {
		t.status = "running"; t.queueReason = undefined; t.startedAt = Date.now(); this.changed(t);
		const worker = fileURLToPath(new URL(`./subagent-worker${extname(import.meta.url) === ".ts" ? ".ts" : ".js"}`, import.meta.url));
		let child: ChildProcess;
		try { child = fork(worker, [], { execPath: process.execPath, execArgv: worker.endsWith(".ts") ? ["--import", "tsx"] : [], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe", "ipc"] }); }
		catch (e) { this.locks.delete(t.cwd); t.status = "failed"; t.error = String(e); t.endedAt = Date.now(); this.changed(t); void this.deliver(t); return; }
		const live: Live = { process: child, ready: false, pending: new Map(), timeout: setTimeout(() => this.stop(t.id, t.clientId, "failed", "Task timed out"), t.timeoutMs) };
		this.live.set(t.id, live);
		let stderr = ""; child.stderr?.on("data", data => { stderr = (stderr + String(data)).slice(-8000); });
		child.on("message", (raw: unknown) => {
			const msg = raw as { type: string; record?: SubagentRecord; result?: string; error?: string; usage?: SubagentSummary["usage"]; requestId?: string };
			if (msg.type === "ready") live.ready = true;
			if (msg.type === "record" && msg.record) {
				let line = JSON.stringify(msg.record) + "\n";
				if (Buffer.byteLength(line) > 384 * 1024) line = JSON.stringify({ ...msg.record, text: JSON.stringify({ truncated: true, preview: msg.record.text.slice(0, 30000) }) }) + "\n";
				const size = this.logSizes.get(t.id) ?? 0;
				if (size + Buffer.byteLength(line) <= 16 * 1024 * 1024) { this.logSizes.set(t.id, size + Buffer.byteLength(line)); void this.enqueue(() => appendFile(join(this.dir, t.id + ".jsonl"), line)); }
				else if (size <= 16 * 1024 * 1024) { this.logSizes.set(t.id, 16 * 1024 * 1024 + 1); const notice = JSON.stringify({ type: "record_limit", timestamp: Date.now(), text: "Process record limit reached (16 MiB); final result remains available." }) + "\n"; void this.enqueue(() => appendFile(join(this.dir, t.id + ".jsonl"), notice)); }
			}
			if (msg.type === "settled") live.outcome = { result: msg.result ?? "", error: msg.error, usage: msg.usage };
			if (msg.type === "ack" && msg.requestId) { live.pending.get(msg.requestId)?.(msg.error); live.pending.delete(msg.requestId); }
		});
		child.once("error", e => { t.error = String(e); });
		child.once("close", (code, signal) => {
			clearTimeout(live.timeout); if (live.force) clearTimeout(live.force);
			for (const ack of live.pending.values()) ack("Task exited before accepting message");
			this.live.delete(t.id); if (this.locks.get(t.cwd) === t.id) this.locks.delete(t.cwd);
			if (live.stoppingStatus) { t.status = live.stoppingStatus; if (live.outcome) { t.result = live.outcome.result; t.usage = live.outcome.usage; } }
			else if (live.outcome) { t.result = live.outcome.result; t.usage = live.outcome.usage; t.error = live.outcome.error; t.status = t.error ? "failed" : "completed"; }
			else { t.status = "failed"; t.error ||= `Worker exited (${code ?? signal}): ${stderr}`; }
			t.endedAt = Date.now(); this.changed(t); void this.deliver(t); this.pump();
		});
		child.send({ type: "start", task: t, agentDir: this.inputs.get(t.id)!.agentDir });
	}
	private async deliver(t: SubagentSummary): Promise<void> {
		if (t.delivered || ["cancelled", "interrupted"].includes(t.status)) return;
		try {
			try { await this.taskWrites.get(t.id); } catch { await this.save(t); }
			await (this.receivers.get(t.clientId) ?? this.onResult)?.(t);
		} catch { /* Retain the result for a later replay after disk/parent recovery. */ }
	}
	async markDelivered(t: SubagentSummary): Promise<void> {
		if (t.delivered) return;
		// Keep the in-memory result protected until this specific acknowledgement is durable.
		await this.save({ ...t, delivered: true });
		t.delivered = true; this.changed(t, false);
	}
	async replay(clientId: string): Promise<void> { for (const t of this.tasks.values()) if (t.clientId === clientId && !unfinished(t)) await this.deliver(t); }
	stop(id: string, clientId: string, status: "cancelled" | "failed" | "interrupted" = "cancelled", reason?: string): void {
		const t = this.get(id, clientId); if (!unfinished(t)) return;
		const live = this.live.get(id); if (!live) { t.error = reason; t.status = status; t.endedAt = Date.now(); this.changed(t); this.pump(); return; }
		if (live.stoppingStatus) return; t.error = reason; live.stoppingStatus = status; t.status = "stopping"; this.changed(t);
		if (live.process.connected) live.process.send({ type: "stop" });
		live.force = setTimeout(() => {
			if (!live.process.pid) return;
			// Wait for taskkill to enumerate descendants before killing the root.
			// The shared helper schedules taskkill asynchronously on Windows.
			const killRoot = () => { try { live.process.kill("SIGKILL"); } catch { /* exited */ } };
			if (process.platform === "win32") execFile("taskkill", ["/F", "/T", "/PID", String(live.process.pid)], { windowsHide: true, timeout: 5000 }, killRoot);
			else { killPidTree(live.process.pid); killRoot(); }
		}, 5000);
	}
	cancel(clientId: string, conversationId?: string): void { for (const t of this.tasks.values()) if (t.clientId === clientId && (!conversationId || t.conversationId === conversationId) && unfinished(t)) this.stop(t.id, clientId); }
	async message(id: string, clientId: string, conversationId: string, text: string, mode: "steer" | "followUp"): Promise<void> {
		this.get(id, clientId, conversationId); const live = this.live.get(id); if (!live || !live.ready || live.stoppingStatus) throw new Error("Task is not ready for messages"); if (!text.trim() || text.length > 100_000) throw new Error("Invalid message");
		const requestId = randomUUID(); await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { live.pending.delete(requestId); reject(new Error("Message acknowledgement timed out")); }, 5000); live.pending.set(requestId, error => { clearTimeout(timer); error ? reject(new Error(error)) : resolve(); }); live.process.send({ type: "message", requestId, text, mode }); });
	}
	async wait(id: string, clientId: string, conversationId: string, signal?: AbortSignal, timeoutMs = 300_000): Promise<SubagentSummary> {
		const t = this.get(id, clientId, conversationId); if (!unfinished(t)) return structuredClone(t);
		return new Promise((resolve, reject) => {
			const cleanup = () => { off(); clearTimeout(timer); signal?.removeEventListener("abort", abort); };
			const finish = () => { cleanup(); resolve(structuredClone(t)); };
			const abort = () => { cleanup(); reject(new Error("Wait aborted")); };
			const off = this.subscribe(() => { if (!unfinished(t)) finish(); });
			const timer = setTimeout(finish, Math.max(1, Math.min(300_000, timeoutMs)));
			if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
		});
	}
	async detail(id: string, clientId: string, conversationId: string, offset = 0): Promise<{ records: SubagentRecord[]; nextOffset: number; hasMore: boolean; task: SubagentSummary }> {
		const task = this.get(id, clientId, conversationId); if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
		await this.flush();
		const records: SubagentRecord[] = []; let nextOffset = offset, hasMore = false;
		let file; try { file = await open(join(this.dir, id + ".jsonl"), "r"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { records, nextOffset, hasMore, task: structuredClone(task) }; }
		try {
			const size = (await file.stat()).size; if (offset > size) throw new Error("Offset exceeds task log");
			const buffer = Buffer.alloc(512 * 1024); const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
			let start = 0;
			while (records.length < 100) { const end = buffer.indexOf(10, start); if (end < 0 || end >= bytesRead) break; records.push(JSON.parse(buffer.toString("utf8", start, end))); start = end + 1; }
			nextOffset += start; hasMore = nextOffset < size;
			if (!start && bytesRead === buffer.length) throw new Error("Task record exceeds detail page size");
			if (hasMore && bytesRead < buffer.length && buffer.indexOf(10, start) < 0) hasMore = false;
		} finally { await file.close(); }
		return { records, nextOffset, hasMore, task: structuredClone(task) };
	}
	async shutdown(): Promise<void> { this.closing = true; for (const t of this.tasks.values()) if (unfinished(t)) this.stop(t.id, t.clientId, "interrupted", "Service shutting down"); await Promise.all([...this.live.values()].map(l => new Promise<void>(resolve => l.process.once("close", () => resolve())))); await this.flush(); }
}
export const subagents = new SubagentManager();
