import type { UiMessage } from "../../server/protocol.js";
import { TOOL_TEXT_CONTINUE_PROMPT, unexecutedToolText } from "../../server/tool-text.js";
export { TOOL_TEXT_CONTINUE_PROMPT, unexecutedToolText };

/** "text": the reply ends with a tool call written as text. "stopped": after the automatic
 *  request to re-issue it, the model again ended without calling any tool. */
export type ToolTextFailureKind = "text" | "stopped";

/** Only the latest settled user turn can offer recovery; a new request clears it. */
export function latestToolTextFailure(messages: readonly UiMessage[], streaming = false): { message: UiMessage; user: UiMessage; kind: ToolTextFailureKind } | null {
	if (streaming) return null;
	const userIndex = messages.findLastIndex(message => message.role === "user");
	if (userIndex < 0) return null;
	const after = messages.slice(userIndex + 1);
	const assistant = after.findLast(message => message.role === "assistant");
	if (!assistant || assistant.content.some(block => block.type === "toolCall")) return null;
	const user = messages[userIndex];
	if (assistant.content.some(block => block.type === "text" && typeof block.text === "string" && unexecutedToolText(block.text))) return { message: assistant, user, kind: "text" };
	// The automatic request did not help: nothing ran after it, so the task is stuck here.
	const automatic = user.content.some(block => block.type === "text" && block.text === TOOL_TEXT_CONTINUE_PROMPT);
	const acted = after.some(message => message.content.some(block => block.type === "toolCall"));
	return automatic && !acted ? { message: assistant, user, kind: "stopped" } : null;
}
