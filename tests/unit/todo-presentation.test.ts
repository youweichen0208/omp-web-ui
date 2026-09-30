import { expect, test } from "vitest";
import { serializeMessage, type AgentMessage } from "../../server/serialize.js";
import type { UiMessage, UiTodoSnapshot } from "../../server/protocol.js";
import { isAbsorbedTodoMessage, todoPresentation } from "../../web/src/todo-presentation.js";
import { buildCollapsedGroups } from "../../web/src/collapsed-groups.js";

const task = (id: number, status: UiTodoSnapshot["tasks"][number]["status"] = "pending") => ({ id, subject: `任务 ${id}`, status });
const call = (id: string): UiMessage => ({ id: `a-${id}`, role: "assistant", content: [{ type: "toolCall", id, name: "todo", argumentsText: "{}" }] });
const result = (id: string, tasks: UiTodoSnapshot["tasks"], action = "update", error?: string): UiMessage => ({ id: `r-${id}`, role: "toolResult", toolCallId: id, toolName: "todo", content: [], todoSnapshot: { tasks, action, error } });
const prose = (id: string, role = "assistant"): UiMessage => ({ id, role, content: [{ type: "text", text: "现在检查代码。" }] });
const project = (messages: UiMessage[]) => todoPresentation(messages, new Map(messages.filter((m) => m.toolCallId).map((m) => [m.toolCallId!, m])));

test("six sequential SDK calls merge into one expanded checklist, including thinking and read-only calls", () => {
	const messages: UiMessage[] = [];
	for (let i = 1; i <= 5; i++) messages.push(call(String(i)), result(String(i), Array.from({ length: i }, (_, n) => task(n + 1)), "create"));
	messages.push({ id: "think", role: "assistant", content: [{ type: "thinking", thinking: "check list" }] }, call("6"), result("6", Array.from({ length: 5 }, (_, n) => task(n + 1)), "list"));
	const views = project(messages);
	expect([...views.values()].map((v) => v.kind)).toEqual(["card", "hidden", "hidden", "hidden", "hidden", "hidden"]);
	expect(views.get("1")).toMatchObject({ tasks: Array.from({ length: 5 }, (_, n) => task(n + 1)) });
	expect(isAbsorbedTodoMessage(call("2"), views)).toBe(true);
	expect(isAbsorbedTodoMessage(messages.at(-3)!, views)).toBe(false);
});

test("updates across turns keep one card, merge adjacent changes, and link to stable item IDs", () => {
	const messages = [call("1"), result("1", [task(7), task(9)]), prose("body"), call("2"), result("2", [task(7, "completed"), task(9)]), call("3"), result("3", [task(7, "completed"), task(9, "in_progress")]), prose("next", "user"), call("4"), result("4", [task(7, "completed"), task(9, "completed")])];
	const views = project(messages);
	expect(views.get("2")).toEqual({ kind: "update", target: { messageId: "a-1", toolCallId: "1" }, changes: [{ id: 7, position: 1, kind: "completed" }, { id: 9, position: 2, kind: "in_progress" }] });
	expect(views.get("3")?.kind).toBe("hidden");
	expect(views.get("4")).toMatchObject({ kind: "update", changes: [{ id: 9, kind: "completed" }] });
	expect(views.get("1")).toMatchObject({ tasks: [task(7, "completed"), task(9, "completed")] });
});

test("other tools and prose split update runs even within one assistant message", () => {
	const message: UiMessage = { id: "batch", role: "assistant", content: [call("1").content[0], ...prose("p").content, call("2").content[0], { type: "toolCall", name: "read", id: "read" }, call("3").content[0]] };
	const views = project([message, result("1", [task(1)]), result("2", [task(1, "in_progress")]), result("3", [task(1, "completed")])]);
	expect([...views.values()].map((v) => v.kind)).toEqual(["card", "update", "update"]);
});

test("failed, missing and legacy results stay visible and cannot change a checklist", () => {
	const messages = [call("1"), result("1", [task(1)]), call("failed"), result("failed", [], "clear", "rejected"), call("pending"), call("legacy"), { ...result("legacy", []), todoSnapshot: undefined }, call("thrown"), { ...result("thrown", []), isError: true }, call("2"), result("2", [task(1, "in_progress")])];
	const views = project(messages);
	for (const id of ["failed", "pending", "legacy", "thrown"]) expect(views.has(id)).toBe(false);
	expect(views.get("2")?.kind).toBe("update");
	expect(views.get("1")).toMatchObject({ tasks: [task(1, "in_progress")] });
});

test("clear isolates reused IDs, preserves old cards, and read-only inspections do not create updates", () => {
	const views = project([call("1"), result("1", [task(1)]), prose("body"), call("read"), result("read", [task(1)], "get"), call("clear"), result("clear", [], "clear"), call("new"), result("new", [task(1)], "create"), prose("body2"), call("edit"), result("edit", [{ ...task(1), subject: "新任务" }, task(2)]), prose("body3"), call("delete"), result("delete", [{ ...task(1, "deleted"), subject: "新任务" }, task(2)])]);
	expect(views.get("read")?.kind).toBe("hidden");
	expect(views.get("clear")).toEqual({ kind: "update", cleared: true, changes: [] });
	expect(views.get("1")).toMatchObject({ tasks: [task(1)] });
	expect(views.get("edit")).toMatchObject({ target: { toolCallId: "new" }, changes: [{ kind: "updated" }, { kind: "added" }] });
	expect(views.get("delete")).toMatchObject({ changes: [{ id: 1, kind: "deleted" }] });
	expect(project([]).size).toBe(0);
});

test("absorbed old messages cannot swallow the next collapsed prose group", () => {
	const messages = [call("hidden"), prose("body")];
	const grouping = buildCollapsedGroups(messages, 2, new Set(), new Set(), new Set(["a-hidden"]));
	expect(grouping.groupAt.get(1)).toEqual([messages[1]]);
	expect(grouping.absorbed.has(0)).toBe(true);
});

test("todo serialization exposes only validated presentation fields, including in-band failures", () => {
	const message: AgentMessage = { role: "toolResult", toolCallId: "t", toolName: "todo", timestamp: 1, isError: false, content: [], details: { action: "update", error: "dependency unfinished", nextId: 2, tasks: [{ ...task(1), description: "private description", metadata: { secret: "private" } }], params: { metadata: "private" } } };
	const serialized = serializeMessage(message, 0);
	expect(serialized?.todoSnapshot).toEqual({ action: "update", error: "dependency unfinished", tasks: [task(1)] });
	expect(serialized?.details).toBeUndefined();
	expect(serializeMessage({ ...message, toolName: "other" }, 0)?.todoSnapshot).toBeUndefined();
	expect(serializeMessage({ ...message, details: { tasks: [null], nextId: 2 } }, 0)?.todoSnapshot).toBeUndefined();
});
