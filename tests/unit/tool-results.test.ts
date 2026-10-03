import { expect, test } from "vitest";
import { serializeMessage, type AgentMessage } from "../../server/serialize.js";

test("tool history retains images and bounded native nested-call records", () => {
	const message: AgentMessage = {
		role: "toolResult", toolCallId: "parent", toolName: "codemode", isError: false, timestamp: 1,
		content: [{ type: "text", text: "generated" }, { type: "image", mimeType: "image/png", data: "fixture" }],
		nestedCalls: { complete: false, calls: [
			{ id: "child", name: "bash", arguments: { command: "false" }, status: "error", durationMs: 12, error: "exit 1" },
			{ id: "unfinished", name: "read", status: "unfinished", argumentsBytes: 50000 },
		] },
	};
	const result = serializeMessage(message, 1);
	expect(result?.content).toContainEqual({ type: "image", dataUrl: "data:image/png;base64,fixture", mimeType: "image/png" });
	expect(result?.nestedCalls?.calls[0]).toMatchObject({ id: "child", name: "bash", status: "error", argumentsText: '{"command":"false"}', durationMs: 12, error: "exit 1" });
	expect(result?.nestedCalls?.complete).toBe(false);
	expect(result?.nestedCalls?.calls[1]).toMatchObject({ status: "unfinished", argumentsBytes: 50000 });
});

test("the UI marks nested history incomplete when it truncates arguments", () => {
	const message: AgentMessage = { role: "toolResult", toolCallId: "parent", toolName: "codemode", isError: false, timestamp: 1, content: [], nestedCalls: { complete: true, calls: [{ id: "child", name: "write", arguments: { content: "x".repeat(25000) }, status: "ok" }] } };
	const result = serializeMessage(message, 1);
	expect(result?.nestedCalls?.complete).toBe(false);
	expect(result?.nestedCalls?.calls[0].argumentsText).toContain("[truncated]");
});
