import { expect, test } from "vitest";
import type { TaskProgress, UiMessage } from "../../server/protocol.js";
import { taskOutputs } from "../../web/src/task-outputs.js";

function fixture() {
	const messages: UiMessage[] = [];
	const task: TaskProgress = { id: "task", conversationId: "c", sourceMessageId: "u", title: "task", status: "running", startedAt: 1, completed: 0, steps: [] };
	const add = (id: string, kind: string, path: string, error = false, completed = true) => {
		messages.push({ id: `a-${id}`, role: "assistant", content: [{ type: "toolCall", id, name: kind, argumentsText: JSON.stringify({ path, oldText: "old", newText: "new\nline", content: "replacement" }) }] });
		if (completed) messages.push({ id: `r-${id}`, role: "toolResult", toolCallId: id, isError: error, content: [] });
		task.steps.push({ id, messageId: `a-${id}`, title: kind, status: "done", startedAt: 1, artifacts: [{ toolCallId: id, kind, path, label: path }] });
	};
	return { task, messages, add };
}

test("empty and read-only tasks have no outputs", () => {
	const { task, messages, add } = fixture();
	expect(taskOutputs(null, messages, "/repo")).toEqual([]);
	add("read", "read", "file.ts"); add("bash", "bash", "file.ts");
	expect(taskOutputs(task, messages, "/repo")).toEqual([]);
});

test("successful edits merge path aliases and count each tool ID once", () => {
	const { task, messages, add } = fixture();
	add("one", "edit", "/repo/src/a.ts"); add("two", "edit", "./src/other/../a.ts");
	task.steps.push(task.steps[0]);
	add("failed", "edit", "src/a.ts", true); add("pending", "write", "pending.ts", false, false);
	add("outside-task", "write", "old.ts"); task.steps.pop();
	expect(taskOutputs(task, messages, "/repo")).toEqual([{ path: "src/a.ts", added: 4, removed: 2, counted: true }]);
});

test("writes are outputs but content length and truncated diffs are not reliable change totals", () => {
	const { task, messages, add } = fixture();
	add("write", "write", "a.ts"); add("edit", "edit", "b.ts");
	messages.at(-1)!.details = { diff: "+1 new", diffTruncated: true };
	expect(taskOutputs(task, messages, "/repo")).toEqual([
		{ path: "a.ts", added: 0, removed: 0, counted: false },
		{ path: "b.ts", added: 0, removed: 0, counted: false },
	]);
});
