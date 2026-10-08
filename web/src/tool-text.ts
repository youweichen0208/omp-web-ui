import type { UiMessage } from "../../server/protocol.js";
import { maskMarkdownCode } from "./leaked-thinking.js";

/** Presentation-only detection. Text is never promoted to an executable tool call. */
export function unexecutedToolText(text: string): { before: string; raw: string; tools: string[] } | null {
	const masked = maskMarkdownCode(text);
	const start = /(?:<(?:[｜|]DSML[｜|])?tool_calls>\s*)?<(?:[｜|]DSML[｜|])?invoke\s+name=["'][\w.-]+["']\s*>/.exec(masked);
	if (!start) return null;
	const tail = masked.slice(start.index);
	if (!/<\/(?:[｜|]DSML[｜|])?invoke>\s*(?:<\/(?:[｜|]DSML[｜|])?tool_calls>)?\s*$/.test(tail)) return null;
	const calls = [...tail.matchAll(/<(?:[｜|]DSML[｜|])?invoke\s+name=["']([\w.-]+)["']\s*>([\s\S]*?)<\/(?:[｜|]DSML[｜|])?invoke>/g)];
	if (!calls.length || calls.some(call => !/<(?:[｜|]DSML[｜|])?parameter\s+name=["'][\w.-]+["'][^>]*>[\s\S]*<\/(?:[｜|]DSML[｜|])?parameter>/.test(call[2]))) return null;
	return { before: text.slice(0, start.index).trimEnd(), raw: text.slice(start.index).trim(), tools: [...new Set(calls.map(call => call[1]))] };
}

/** Only the latest settled user turn can offer recovery; a new request clears it. */
export function latestToolTextFailure(messages: readonly UiMessage[], streaming = false) {
	if (streaming) return null;
	const userIndex = messages.findLastIndex(message => message.role === "user");
	if (userIndex < 0) return null;
	const assistant = messages.slice(userIndex + 1).findLast(message => message.role === "assistant");
	if (!assistant || assistant.content.some(block => block.type === "toolCall")) return null;
	return assistant.content.some(block => block.type === "text" && typeof block.text === "string" && unexecutedToolText(block.text)) ? { message: assistant, user: messages[userIndex] } : null;
}
