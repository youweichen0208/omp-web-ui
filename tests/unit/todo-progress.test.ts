import { expect, test } from "vitest";
import { deriveTaskProgress } from "../../server/task-progress.js";
import { todoPlanFromTranscript, todoSnapshot } from "../../server/todo-progress.js";
import type { UiMessage } from "../../server/protocol.js";

const user = (id: string): UiMessage => ({ id, role: "user", timestamp: 10, content: [{ type: "text", text: "实现任务" }] });
const snapshot = (id: string, tasks: unknown[], action = "update", error?: string): UiMessage => ({ id, role: "toolResult", toolName: "todo", toolCallId: id, timestamp: Number(id.replace(/\D/g, "")) * 10, details: { tasks, nextId: 3, action, error }, content: [] });
const first = { id: 1, subject: "确认需求", status: "in_progress", metadata: { title: "实现导出", completionCriteria: "导出通过验证" } };
const second = { id: 2, subject: "实现导出", status: "pending", blockedBy: [1] };
const call: UiMessage = { id: "a", role: "assistant", timestamp: 35, content: [{ type: "toolCall", id: "read1", name: "read", argumentsText: '{"path":"README.md"}' }] };

test("todo persists across user turns without completing when the agent pauses", () => {
	const history = [user("u1"), snapshot("r2", [first, second]), call, user("u2")];
	const task = deriveTaskProgress("c", history, null, false);
	expect(task).toMatchObject({ status: "waiting", title: "实现导出", sourceMessageId: "u1" });
	expect(task?.plan?.items[0]).toMatchObject({ status: "running", toolCallIds: ["read1"] });
	expect(task?.plan?.items[1].blockedBy).toEqual(["1"]);
	const next = [...history, snapshot("r4", [{ ...first, status: "completed" }, { ...second, status: "in_progress" }])];
	expect(deriveTaskProgress("c", next, null, true)?.plan?.items[1].blockedBy).toEqual([]);
	expect(deriveTaskProgress("c", next, null, true)?.id).toBe(task?.id);
	const done = [...next, snapshot("r5", [{ ...first, status: "completed" }, { ...second, status: "completed" }])];
	expect(deriveTaskProgress("c", done, null, false)?.status).toBe("done");
});

test("clear separates task ids and artifacts, and /new has no plan", () => {
	const messages = [user("u1"), snapshot("r2", [first]), call, user("u2"), snapshot("r4", [], "clear")];
	expect(deriveTaskProgress("c", messages, null, false)).toBeNull();
	const next = deriveTaskProgress("c", [...messages, snapshot("r5", [first], "create")], null, false);
	expect(next?.sourceMessageId).toBe("u2");
	expect(next?.plan?.items[0].toolCallIds).toEqual([]);
	expect(deriveTaskProgress("new", [user("new")], null, false)).toBeNull();
});

test("in-band errors cannot revise state; deleted tasks and change explanation survive updates", () => {
	const changed = { ...second, status: "deleted", metadata: { changeSummary: "合并实现步骤" } };
	const messages = [user("u1"), snapshot("r2", [first, second]), snapshot("r3", [first, changed]), snapshot("r4", [{ ...first, status: "completed" }, changed]), snapshot("r5", [], "clear", "rejected")];
	const plan = todoPlanFromTranscript(messages)?.plan;
	expect(plan?.changeSummary).toBe("合并实现步骤");
	expect(plan?.items.map((item) => item.status)).toEqual(["done", "removed"]);
	expect(todoSnapshot({ tasks: [null], nextId: 1 })).toBeUndefined();
});

test("tools following a todo update in the same assistant message belong to the new step", () => {
	const assistant: UiMessage = { id: "a2", role: "assistant", content: [{ type: "toolCall", id: "update", name: "todo", argumentsText: '{"action":"update","id":2,"status":"in_progress"}' }, ...call.content] };
	const result = { ...snapshot("r3", [{ ...first, status: "completed" }, { ...second, status: "in_progress" }]), toolCallId: "update" };
	const plan = todoPlanFromTranscript([user("u1"), snapshot("r2", [first, second]), assistant, result])?.plan;
	expect(plan?.items[0].toolCallIds).toEqual([]);
	expect(plan?.items[1].toolCallIds).toEqual(["read1"]);
});

test("completed list leaves the panel on a subsequent plain question", () => {
	const messages = [user("u1"), snapshot("r2", [{ ...first, status: "completed" }]), user("u2")];
	expect(deriveTaskProgress("c", messages, null, false)).toBeNull();
});
