import type { UiMessage, UiToolCallBlock } from "../../server/protocol.js";

export interface ChangeLine {
	marker: "+" | "-" | " ";
	oldLine?: number;
	newLine?: number;
	text: string;
}

export interface ChangeHunk {
	line: number;
	functionName?: string;
	lines: ChangeLine[];
}

export interface EditWriteChange {
	path: string;
	kind: "edit" | "write";
	added: number;
	removed: number;
	firstChangedLine: number;
	hunks: ChangeHunk[];
	error: boolean;
	errorText: string;
	output: string;
	empty: boolean;
}

const functionLine = /^\s*(?:(?:async\s+)?def\s+\w+|(?:export\s+)?(?:async\s+)?function\s+\w+|(?:public|private|protected)\s+\w+\s*\(|(?:async\s+)?\w+\s*\([^)]*\)\s*[:{])/;

/** SDK edit details contain one line number per row and ` ...` gaps. */
export function parseEditDiff(diff: string): ChangeHunk[] {
	const segments: ChangeLine[][] = [[]];
	let offset = 0;
	for (const raw of diff.replace(/\r\n/g, "\n").split("\n")) {
		if (/^\s*\.\.\.\s*$/.test(raw)) { if (segments.at(-1)?.length) segments.push([]); continue; }
		const match = /^([+\- ])\s*(\d+) (.*)$/.exec(raw);
		if (!match) continue;
		const marker = match[1] as ChangeLine["marker"];
		const number = Number(match[2]);
		const text = match[3];
		if (marker === "+") {
			segments.at(-1)!.push({ marker, newLine: number, text });
			offset++;
		} else if (marker === "-") {
			segments.at(-1)!.push({ marker, oldLine: number, text });
			offset--;
		} else segments.at(-1)!.push({ marker, oldLine: number, newLine: number + offset, text });
	}
	return segments.flatMap((segment) => {
		const changed = segment.flatMap((line, index) => line.marker === " " ? [] : [index]);
		if (!changed.length) return [];
		const ranges: Array<{ first: number; last: number }> = [];
		for (const index of changed) {
			const previous = ranges.at(-1);
			if (previous && index - previous.last <= 5) previous.last = index;
			else ranges.push({ first: index, last: index });
		}
		return ranges.map(({ first, last }) => {
			const visible = segment.slice(Math.max(0, first - 2), Math.min(segment.length, last + 3));
			const functionName = [...segment.slice(0, first)].reverse().find((line) => functionLine.test(line.text))?.text.trim();
			return { line: segment[first].newLine ?? segment[first].oldLine ?? 1, ...(functionName ? { functionName } : {}), lines: visible };
		});
	});
}

export function editWriteChange(block: UiToolCallBlock, result?: UiMessage): EditWriteChange | null {
	if (block.name !== "edit" && block.name !== "write") return null;
	let args: Record<string, unknown> = {};
	try { args = JSON.parse(block.argumentsText ?? "{}"); } catch { /* streamed arguments may be incomplete */ }
	const path = typeof args.path === "string" ? args.path : "";
	const output = result?.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n") ?? "";
	const error = !!result?.isError;
	if (block.name === "write") {
		const content = typeof args.content === "string" ? args.content : "";
		const lines = content ? content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
		return { path, kind: "write", added: error ? 0 : lines.length, removed: 0, firstChangedLine: 1, hunks: lines.length ? [{ line: 1, lines: lines.map((text, index) => ({ marker: "+", newLine: index + 1, text })) }] : [], error, errorText: error ? output : "", output, empty: !lines.length };
	}
	const details = result?.details as { diff?: unknown; firstChangedLine?: unknown } | undefined;
	const diff = !error && typeof details?.diff === "string" ? details.diff : "";
	const hunks = parseEditDiff(diff);
	const lines = hunks.flatMap((hunk) => hunk.lines);
	if (error) {
		const edits = Array.isArray(args.edits) ? args.edits : [args];
		const oldTexts = edits.map((edit) => typeof edit === "object" && edit && "oldText" in edit && typeof edit.oldText === "string" ? edit.oldText : "").filter(Boolean);
		const missing = oldTexts.join("\n\n");
		return { path, kind: "edit", added: 0, removed: 0, firstChangedLine: 1, hunks: missing ? [{ line: 1, lines: missing.replace(/\n$/, "").split("\n").map((text) => ({ marker: " ", text })) }] : [], error, errorText: output, output, empty: !missing };
	}
	return { path, kind: "edit", added: lines.filter((line) => line.marker === "+").length, removed: lines.filter((line) => line.marker === "-").length, firstChangedLine: typeof details?.firstChangedLine === "number" ? details.firstChangedLine : hunks[0]?.line ?? 1, hunks, error, errorText: "", output, empty: !hunks.length };
}

export function changeLineCount(block: UiToolCallBlock, result?: UiMessage): { added: number; removed: number } | null {
	const change = editWriteChange(block, result);
	return change ? { added: change.added, removed: change.removed } : null;
}

/** A later successful edit of the same file resolves earlier failed attempts. */
export function retriedEditIds(messages: UiMessage[], results: ReadonlyMap<string, UiMessage>): Set<string> {
	const failed = new Map<string, string[]>();
	const retried = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall" || (part as UiToolCallBlock).name !== "edit") continue;
			const call = part as UiToolCallBlock;
			const result = results.get(call.id);
			if (!result) continue;
			const path = editWriteChange(call, result)?.path;
			if (!path) continue;
			if (result.isError) failed.set(path, [...(failed.get(path) ?? []), call.id]);
			else { for (const id of failed.get(path) ?? []) retried.add(id); failed.delete(path); }
		}
	}
	return retried;
}
