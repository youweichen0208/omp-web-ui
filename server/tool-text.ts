import type { UiMessage } from "./protocol.js";

export const TOOL_TEXT_CONTINUE_PROMPT = "你上一条回复里的工具调用是以普通文本输出的，没有被执行。请通过工具调用（不要写成文本）重新发起它，然后继续完成任务。";

/**
 * Detection of tool calls a model wrote as plain text instead of calling the
 * tool (DSML or `<invoke>` markup on the text channel). Pure: shared by the
 * server (auto-continue) and the web UI (recovery card). Detection only: text
 * is never promoted to an executable call.
 */

/** Match protocol markers outside Markdown code, retaining offsets into the original. */
export function maskMarkdownCode(text: string): string {
	let fence: { marker: string; length: number } | undefined;
	const masked = text.split("\n").map(line => {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		const inCode = !!fence || !!marker;
		if (marker) {
			if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
			else if (marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
		}
		return inCode ? line.replace(/</g, "\0") : line;
	}).join("\n");
	return masked.replace(/(`+)([\s\S]*?)\1(?!`)/g, code => code.replace(/</g, "\0"));
}

const D = "(?:[｜|]DSML[｜|])?";
const INVOKE_OPEN = new RegExp(`<${D}invoke\\s+name=["']([\\w.-]+)["']\\s*>`, "g");
const PARAMETER = `<${D}parameter\\s+name=["'][\\w.-]+["'][^>]*>[\\s\\S]*?<\\/${D}parameter>`;
const WRAPPER_CLOSE = `(?:<\\/${D}(?:tool_calls|function_calls)>\\s*)?`;
/**
 * The text ENDS with one or more parameters closed by </invoke>. Anchored at the
 * end, so a call inside a closed code block (text ends with ```) or inline code
 * (ends with `) never matches, and neither does a call followed by prose.
 */
const CALL_TAIL = new RegExp(`(?:${PARAMETER}\\s*)+<\\/${D}invoke>\\s*${WRAPPER_CLOSE}$`);
const STRICT_START = new RegExp(`(?:<${D}(?:tool_calls|function_calls)>\\s*)?<${D}invoke\\s+name=["'][\\w.-]+["']\\s*>`);

export interface UnexecutedToolText {
	/** Prose before the markup. */
	before: string;
	/** The markup as the model wrote it. */
	raw: string;
	/** Tool names from the opening tags; empty when only the tail survived. */
	tools: string[];
}

export function unexecutedToolText(text: string): UnexecutedToolText | null {
	const masked = maskMarkdownCode(text);
	const start = STRICT_START.exec(masked);
	if (start) {
		const tail = masked.slice(start.index);
		const closed = new RegExp(`<\\/${D}invoke>\\s*${WRAPPER_CLOSE}$`).test(tail);
		const calls = [...tail.matchAll(new RegExp(`<${D}invoke\\s+name=["']([\\w.-]+)["']\\s*>([\\s\\S]*?)<\\/${D}invoke>`, "g"))];
		if (closed && calls.length && calls.every(call => new RegExp(PARAMETER).test(call[2]))) {
			return { before: text.slice(0, start.index).trimEnd(), raw: text.slice(start.index).trim(), tools: [...new Set(calls.map(call => call[1]))] };
		}
	}
	// Fallback on the raw text: the call can still be recognised from its closing
	// tail when the opening tag is masked (an unclosed ``` earlier in the reply) or
	// was emitted elsewhere (inside leaked reasoning, or a separate thinking block).
	const tail = CALL_TAIL.exec(text);
	if (!tail) return null;
	const opens = [...text.matchAll(INVOKE_OPEN)];
	const first = opens.find(open => open.index !== undefined && open.index < tail.index)?.index ?? tail.index;
	const begin = Math.min(first, tail.index);
	return { before: text.slice(0, begin).trimEnd(), raw: text.slice(begin).trim(), tools: [...new Set(opens.map(open => open[1]))] };
}

/** Recognize the persisted recovery exchange, including pre-fix sessions. This
 * only preserves task projection; it never grants execution authorization. */
export function isToolTextContinuation(messages: readonly UiMessage[], index: number): boolean {
	const message = messages[index], previous = messages[index - 1];
	if (message?.role !== "user" || message.content.length !== 1 || message.content[0].type !== "text" || message.content[0].text !== TOOL_TEXT_CONTINUE_PROMPT) return false;
	if (previous?.role !== "assistant" || previous.stopReason === "aborted" || previous.stopReason === "error" || previous.content.some(block => block.type === "toolCall")) return false;
	const text = previous.content.map(block => block.type === "text" ? block.text : "").join("\n");
	return !!unexecutedToolText(text);
}
