import { expect, test } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { deriveTaskProgress } from "../../server/task-progress.js";

const user = (id: string, text: string): UiMessage => ({ id, role: "user", timestamp: 100, content: [{ type: "text", text }] });
const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, argumentsText: JSON.stringify(args) });

test("server groups narrative and adjacent tools into a stable current step", () => {
	const messages: UiMessage[] = [user("u1", "搭建 API、worker 和 budget 模块"),
		{ id: "a1", role: "assistant", timestamp: 110, content: [{ type: "text", text: "开始搭建三个模块的入口。" }, call("w1", "write", { path: "api/main.py", content: "a" }), call("w2", "write", { path: "worker/main.py", content: "b" })] },
		{ id: "r1", role: "toolResult", toolCallId: "w1", content: [{ type: "text", text: "done" }] },
	];
	const running = deriveTaskProgress("c1", messages, null, true);
	expect(running?.title).toBe("搭建 API、worker 和 budget 模块");
	expect(running?.steps[0]).toMatchObject({ id: "a1:0", title: "开始搭建三个模块的入口", status: "running" });
	expect(running?.steps[0].artifacts.map((item) => item.label)).toEqual(["api/main.py", "worker/main.py"]);
	const done = deriveTaskProgress("c1", [...messages, { id: "r2", role: "toolResult", toolCallId: "w2", content: [{ type: "text", text: "done" }] }], null, false);
	expect(done?.completed).toBe(1);
	expect(done?.status).toBe("done");
});

test("failed tool, cancellation and a new user turn have distinct outcomes", () => {
	const messages: UiMessage[] = [user("u1", "旧任务"), { id: "a1", role: "assistant", content: [call("b1", "bash", { command: "npm test" })] }, { id: "r1", role: "toolResult", toolCallId: "b1", isError: true, content: [{ type: "text", text: "exit 1" }] }];
	expect(deriveTaskProgress("c1", messages, null, false)?.status).toBe("failed");
	expect(deriveTaskProgress("c1", [...messages, user("u2", "新任务")], null, true)?.sourceMessageId).toBe("u2");
	expect(deriveTaskProgress("c1", [...messages, { id: "a2", role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "stopped" }] }], null, false)?.status).toBe("cancelled");
});

test("a running turn keeps a pending step between completed tools and the next model response", () => {
	const messages: UiMessage[] = [user("u1", "生成文件"), { id: "a1", role: "assistant", content: [call("w1", "write", { path: "a.txt", content: "a" })] }, { id: "r1", role: "toolResult", toolCallId: "w1", content: [{ type: "text", text: "done" }] }];
	const progress = deriveTaskProgress("c1", messages, null, true);
	expect(progress?.steps.map((step) => step.status)).toEqual(["done", "running"]);
	expect(progress?.steps[1].messageId).toBe("a1");
});
