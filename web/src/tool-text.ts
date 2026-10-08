import type { UiMessage } from "../../server/protocol.js";
import { unexecutedToolText } from "../../server/tool-text.js";
export { unexecutedToolText };

/** Only the latest settled user turn can offer recovery; a new request clears it. */
export function latestToolTextFailure(messages: readonly UiMessage[], streaming = false) {
	if (streaming) return null;
	const userIndex = messages.findLastIndex(message => message.role === "user");
	if (userIndex < 0) return null;
	const assistant = messages.slice(userIndex + 1).findLast(message => message.role === "assistant");
	if (!assistant || assistant.content.some(block => block.type === "toolCall")) return null;
	return assistant.content.some(block => block.type === "text" && typeof block.text === "string" && unexecutedToolText(block.text)) ? { message: assistant, user: messages[userIndex] } : null;
}
