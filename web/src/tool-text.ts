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
