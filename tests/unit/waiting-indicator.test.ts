import { expect, it } from "vitest";
import { conversationWait } from "../../web/src/waiting-indicator.js";
import type { UiMessage } from "../../server/protocol.js";
const user: UiMessage = { id: "u", role: "user", content: [] };
const tool: UiMessage = { id: "a", role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", argumentsText: '{"command":"npm test"}' }] };
const result: UiMessage = { id: "r", role: "toolResult", toolCallId: "t", toolName: "bash", content: [] };
const empty = new Map();
it("waits for a user request, distinguishes delivered steering, and ignores old turns", () => {
	expect(conversationWait([user], empty)).toEqual({ key: "u", label: "waitUnderstanding", delay: 300 });
	expect(conversationWait([user], empty, "u")?.label).toBe("waitSteer");
	expect(conversationWait([tool, result, user], empty)?.label).toBe("waitUnderstanding");
	expect(conversationWait([], empty)).toBeNull();
});
it("visible text and thinking end a wait, even while the turn continues", () => {
	for (const block of [{ type: "text", text: "Result" }, { type: "thinking", thinking: "Reasoning" }]) {
		expect(conversationWait([user, tool, result, { id: "next", role: "assistant", content: [block] }], empty)).toBeNull();
	}
	expect(conversationWait([user, { id: "next", role: "assistant", content: [{ type: "thinking", thinking: "" }] }], empty)?.label).toBe("waitThinking");
});
it("transitions from a long tool to reading its result without reviving old calls", () => {
	expect(conversationWait([user, tool], empty)).toEqual({ key: "t", label: "waitTests", delay: 4000 });
	expect(conversationWait([user, tool], new Map([["t", {}]]))?.label).toBe("waitResults");
	expect(conversationWait([user, tool, result], empty)?.key).toBe("t");
	expect(conversationWait([user, tool, {...result, toolName: "read"}], empty)?.label).toBe("waitFile");
});
it("does not mistake echo titles or filenames for tests and builds", () => {
	for (const command of ['echo "npm test"', 'echo "example; npm test"', 'cat build.ts', 'sed -n "1,4p" tests.ts']) {
		expect(conversationWait([user, {...tool, content: [{type: "toolCall", id: "t", name: "bash", argumentsText: JSON.stringify({command})}]}], empty)).toBeNull();
	}
	expect(conversationWait([user, {...tool, content: [{type: "toolCall", id: "t", name: "bash", argumentsText: '{"command":"npm run build"}'}]}], empty)?.label).toBe("waitBuild");
});
