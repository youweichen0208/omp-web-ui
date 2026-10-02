import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentManager, defaultSubagentConfig, readOnlyBash } from "../../server/subagents.js";
import { nativeExtensionPath } from "../../server/native-tools.js";
import { modelResult } from "../../server/subagent-tools.js";
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function queuedTask() {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-regression-")); roots.push(root);
	const manager = new SubagentManager(); manager.initialize(root); manager.configure({ ...defaultSubagentConfig(), enabled: true });
	manager.enter(root, "parent", "edit", "edit");
	const task = manager.spawn({ clientId: "client", conversationId: "original", parentSessionId: "session", parentRound: "round", cwd: root, agentDir: root, model: { provider: "fixture", id: "local" }, thinking: "off", roleId: "development", task: "Queued writing task" });
	return { manager, task, root };
}
describe("subagent review regressions", () => {
	it("bounded wait returns queued state without cancelling the task or parent", async () => {
		vi.useFakeTimers(); const { manager, task } = queuedTask(); const abort = new AbortController();
		let result: { status: string } | undefined;
		const waiting: Promise<unknown> = Reflect.apply(manager.wait, manager, [task.id, "client", "original", abort.signal, 25]);
		void waiting.then(value => { result = value as { status: string }; }).catch(() => {});
		try { await vi.advanceTimersByTimeAsync(26); expect(result?.status).toBe("queued"); expect(task.status).toBe("queued"); }
		finally { abort.abort(); await waiting.catch(() => {}); await manager.shutdown(); }
	});
	it("a repeated stop does not erase its original reason", async () => {
		const { manager, task } = queuedTask();
		manager.stop(task.id, "client", "failed", "original timeout"); manager.stop(task.id, "client");
		expect(task.error).toBe("original timeout"); await manager.shutdown();
	});
	it("keeps parent write priority between edits and permits known read-only tools", async () => {
		const { manager, task, root } = queuedTask();
		manager.leave(root, "parent", "edit"); expect(task.status).toBe("queued"); await manager.whenLaunched(task); expect(task.queueReason).toBe("write_lock");
		expect(manager.enter(root, "parent", "next", "write")).toBeUndefined();
		const locks: Map<string, string> = Reflect.get(manager, "locks"); locks.set(realpathSync(root), "writer");
		for (const tool of ["read", "todo", "task_plan", "tool_search"]) expect(manager.enter(root, "other", tool, tool)).toBeUndefined();
		expect(manager.enter(root, "other", "git", "bash", { command: "git --no-optional-locks status --short" })).toBeUndefined();
		expect(manager.enter(root, "other", "evil", "bash", { command: "git status; rm file" })).toMatch(/write lock/);
		manager.stop(task.id, "client"); locks.clear(); manager.leave(root, "parent"); await manager.shutdown();
	});
	it("skips disabled guards and reports missing directories without throwing", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagent-disabled-")); roots.push(root);
		const manager = new SubagentManager(); manager.initialize(root); manager.configure({ ...defaultSubagentConfig(), enabled: false });
		expect(manager.enter(join(root, "deleted"), "host", "write", "write")).toBeUndefined();
		manager.configure({ ...defaultSubagentConfig(), enabled: true });
		expect(manager.enter(join(root, "deleted"), "host", "write", "write")).toBe("Project directory is unavailable");
		expect(() => manager.leave(join(root, "deleted"), "host")).not.toThrow(); await manager.shutdown();
	});
	it("reruns in the rebound conversation and saves inputs without duplicate task text", async () => {
		const { manager, task, root } = queuedTask(); manager.stop(task.id, "client");
		manager.rebind("client", "session", "new-conversation");
		const rerun = manager.rerun(task.id, "client", "new-conversation", "session", "new-round");
		expect(rerun.conversationId).toBe("new-conversation"); expect(rerun.id).not.toBe(task.id);
		await manager.flush(); const disk = JSON.parse(readFileSync(join(root, "subagents", "tasks", rerun.id + ".json"), "utf8"));
		expect(Object.keys(disk).sort()).toEqual(["agentDir", "task"]);
		await manager.shutdown();
	});
	it("reads detail pages at UTF-8 byte offsets and detects appended records", async () => {
		const { manager, task, root } = queuedTask(); manager.stop(task.id, "client"); await manager.flush();
		const records = Array.from({ length: 205 }, (_, i) => ({ type: "message", timestamp: i, text: JSON.stringify({ text: `记录 ${i} 😀` }) }));
		writeFileSync(join(root, "subagents", task.id + ".jsonl"), records.map(r => JSON.stringify(r) + "\n").join(""));
		const first = await manager.detail(task.id, "client", "original"); expect(first.records).toEqual(records.slice(0, 100)); expect(first.hasMore).toBe(true); expect(first.nextOffset).toBeGreaterThan(100);
		const second = await manager.detail(task.id, "client", "original", first.nextOffset); expect(second.records).toEqual(records.slice(100, 200));
		const last = await manager.detail(task.id, "client", "original", second.nextOffset); expect(last.records).toEqual(records.slice(200)); expect(last.hasMore).toBe(false);
		await expect(manager.detail(task.id, "client", "original", last.nextOffset + 1)).rejects.toThrow(/Offset/); await manager.shutdown();
	});
	it("normalizes all three native aliases and limits model-visible metadata", async () => {
		for (const name of ["mcp", "tool-search", "codemode"]) expect(nativeExtensionPath(`builtin:${name}`)).toBe(`<inline:${name}>`);
		const { manager, task } = queuedTask();
		expect(Object.keys(modelResult(task)).sort()).toEqual(["error", "id", "result", "role", "status", "usage"]);
		expect(manager.state("client").tasks[0]).not.toHaveProperty("background");
		expect(manager.state("client").tasks[0].role).not.toHaveProperty("prompt"); await manager.shutdown();
	});
	it("treats unknown shell syntax as mutating", () => {
		expect(readOnlyBash({ command: "git --no-optional-locks status --porcelain=2" })).toBe(true);
		for (const command of ["git status", "git status --short", "git status > output", "git -c alias.status=x status", "git status && touch x", "git diff", "echo hi"]) expect(readOnlyBash({ command })).toBe(false);
	});

	it("bounds terminal history and removes its metadata and process logs", async () => {
		const { manager, task, root } = queuedTask(); manager.stop(task.id, "client"); await manager.shutdown();
		const history = Array.from({ length: 202 }, (_, i) => ({ ...task, id: `history-${i}`, endedAt: Date.now() - i }));
		writeFileSync(join(root, "subagents", "tasks.json"), JSON.stringify({ tasks: history, inputs: history.map(t => [t.id, { agentDir: root }]) }));
		writeFileSync(join(root, "subagents", "history-201.jsonl"), "old log");
		const restored = new SubagentManager(); restored.initialize(root); await restored.flush();
		expect(restored.state("client").tasks).toHaveLength(200);
		expect(existsSync(join(root, "subagents", "history-201.jsonl"))).toBe(false);
		expect(existsSync(join(root, "subagents", "tasks", "history-201.json"))).toBe(false);
		await restored.shutdown();
	});

	it("isolates a failed launch write and recovers after the disk is writable again", async () => {
		const { manager, task, root } = queuedTask(); await manager.flush(); manager.stop(task.id, "client"); await manager.flush();
		const tasksDir = join(root, "subagents", "tasks"), backup = tasksDir + "-backup";
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const input = { clientId: "client", conversationId: "original", parentSessionId: "session", parentRound: "failure", cwd: root, agentDir: root, model: { provider: "fixture", id: "local" }, thinking: "off", roleId: "development", task: "A cannot be saved" };
		try {
			// A real filesystem failure, portable even when CI runs as root.
			renameSync(tasksDir, backup); writeFileSync(tasksDir, "temporarily unavailable");
			const a = manager.spawn(input); await manager.flush().catch(() => {});
			expect(a.status).toBe("failed"); expect(a.delivered).toBe(true); expect(manager.has("client")).toBe(false);
			rmSync(tasksDir); renameSync(backup, tasksDir);
			manager.onResult = vi.fn(); await manager.replay("client"); expect(manager.onResult).not.toHaveBeenCalled();
			const b = manager.spawn({ ...input, parentRound: "recovered", task: "B can be saved" });
			await expect(manager.flush()).resolves.toBeUndefined();
			await expect(manager.detail(b.id, "client", "original")).resolves.toHaveProperty("task.id", b.id);
			manager.leave(root, "parent"); await manager.wait(b.id, "client", "original", undefined, 2000);
			expect(b.startedAt).toBeTypeOf("number"); // Worker fails on its isolated missing model, not persistence.
		} finally {
			if (existsSync(backup)) { rmSync(tasksDir, { force: true, recursive: true }); renameSync(backup, tasksDir); }
			await manager.shutdown().catch(() => {}); log.mockRestore();
		}
	});

	it("a failed rename rejects only its launch and later saves still succeed", async () => {
		const { manager, task, root } = queuedTask(); await manager.flush(); manager.stop(task.id, "client"); await manager.flush();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const input = { clientId: "client", conversationId: "original", parentSessionId: "session", parentRound: "rename", cwd: root, agentDir: root, model: { provider: "fixture", id: "local" }, thinking: "off", roleId: "development", task: "A rename fails" };
		try {
			const a = manager.spawn(input); const target = join(root, "subagents", "tasks", a.id + ".json"); mkdirSync(target);
			await expect(manager.whenLaunched(a)).rejects.toThrow(); expect(a.status).toBe("failed"); expect(a.error).toMatch(/rename/); expect(manager.has("client")).toBe(false);
			rmSync(target, { recursive: true }); const b = manager.spawn({ ...input, parentRound: "rename-recovered", task: "B after rename recovers" });
			await expect(manager.whenLaunched(b)).resolves.toBeUndefined();
			expect(JSON.parse(readFileSync(join(root, "subagents", "tasks", b.id + ".json"), "utf8")).task.id).toBe(b.id);
		} finally { await manager.shutdown(); log.mockRestore(); }
	});
	it("does not acknowledge delivery until its own save succeeds", async () => {
		const { manager, task, root } = queuedTask(); manager.stop(task.id, "client"); await manager.flush(); task.status = "completed"; task.result = "keep this result";
		const target = join(root, "subagents", "tasks", task.id + ".json"), backup = target + ".backup";
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			renameSync(target, backup); mkdirSync(target);
			await expect(manager.markDelivered(task)).rejects.toThrow(); expect(task.delivered).not.toBe(true);
			rmSync(target, { recursive: true }); renameSync(backup, target);
			await manager.markDelivered(task); expect(task.delivered).toBe(true);
			expect(JSON.parse(readFileSync(target, "utf8")).task.delivered).toBe(true);
		} finally { if (existsSync(backup)) { rmSync(target, { recursive: true, force: true }); renameSync(backup, target); } await manager.shutdown(); log.mockRestore(); }
	});
	it("protects recent undelivered results but expires orphaned results after 30 days", async () => {
		const { manager, task, root } = queuedTask(); manager.stop(task.id, "client"); await manager.shutdown();
		const history = Array.from({ length: 202 }, (_, i) => ({ ...task, id: `delivered-${i}`, status: "completed", delivered: true, endedAt: Date.now() - i }));
		rmSync(join(root, "subagents", "tasks", task.id + ".json"));
		const pending = { ...task, id: "undelivered", status: "completed", delivered: false, result: "must reach the parent", endedAt: Date.now() - 29 * 86400000 };
		const expired = { ...pending, id: "expired-undelivered", endedAt: Date.now() - 31 * 86400000 };
		writeFileSync(join(root, "subagents", expired.id + ".jsonl"), "{}\n");
		writeFileSync(join(root, "subagents", "tasks.json"), JSON.stringify({ tasks: [...history, pending, expired], inputs: [...history, pending, expired].map(t => [t.id, { agentDir: root }]) }));
		const restored = new SubagentManager(); restored.initialize(root); await restored.flush();
		expect(restored.state("client").tasks.filter(t => t.id.startsWith("delivered-"))).toHaveLength(200);
		expect(() => restored.get(expired.id, "client")).toThrow();
		expect(existsSync(join(root, "subagents", "tasks", expired.id + ".json"))).toBe(false);
		expect(existsSync(join(root, "subagents", expired.id + ".jsonl"))).toBe(false);
		const result = restored.get("undelivered", "client"); expect(result.result).toBe(pending.result);
		await restored.markDelivered(result); await restored.flush();
		expect(() => restored.get("undelivered", "client")).toThrow(); await restored.shutdown();
	});

});
