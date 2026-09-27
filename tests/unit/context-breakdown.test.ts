import { expect, test } from "vitest";
import { estimateContextParts } from "../../server/context-breakdown.js";
import type { AgentMessage } from "../../server/serialize.js";

test("estimated context categories conserve the SDK total and treat image bytes as one image", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "question" }, { type: "image", data: "x".repeat(100_000), mimeType: "image/png" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer" }, { type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } }] },
		{ role: "toolResult", content: [{ type: "text", text: "result" }] },
	] as unknown as AgentMessage[];
	const parts = estimateContextParts(messages, "system prompt and skills", 20_000)!;
	expect(Object.values(parts).reduce((sum, value) => sum + value, 0)).toBe(20_000);
	expect(parts.attachments).toBeGreaterThan(parts.conversation);
	expect(parts.tools).toBeGreaterThan(0);
	expect(estimateContextParts(messages, "", null)).toBeNull();
});
