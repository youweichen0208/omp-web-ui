import type { TaskProgress, UiMessage, UiToolCallBlock } from "../../server/protocol.js";
import { editWriteChange, type ChangeLine } from "./edit-write-presentation.js";
import { outputPath, taskOutputs } from "./task-outputs.js";

export interface ChangedFile {
	path: string;
	oldPath?: string;
	added: number;
	removed: number;
	counted: boolean;
	lines: ChangeLine[];
	binary?: boolean;
	unlocated?: boolean;
	truncated?: boolean;
	toolIds?: string[];
}

/** Both summary and task panel count the same successful, deduplicated tools. */
export function taskChanges(task: TaskProgress | null | undefined, messages: UiMessage[], cwd: string): ChangedFile[] {
	const files = taskOutputs(task, messages, cwd).map(file => ({ ...file, lines: [] as ChangeLine[], toolIds: [] as string[], unlocated: false, truncated: false }));
	const byPath = new Map(files.map(file => [file.path, file]));
	const ids = new Set(task?.steps.flatMap(step => step.artifacts.map(item => item.toolCallId)) ?? []);
	const results = new Map(messages.filter(message => message.role === "toolResult").map(message => [message.toolCallId, message]));
	for (const message of messages) if (message.role === "assistant") for (const block of message.content) {
		if (block.type !== "toolCall" || !ids.delete(String(block.id))) continue;
		const call = block as UiToolCallBlock, result = results.get(call.id);
		if (!result || result.isError) continue;
		const change = editWriteChange(call, result, 3);
		if (!change) continue;
		const file = byPath.get(outputPath(change.path, cwd));
		if (!file) continue;
		file.lines.push(...change.hunks.flatMap(hunk => hunk.lines));
		file.toolIds.push(call.id);
		file.unlocated ||= !!change.fromArguments;
		file.truncated ||= !!change.diffTruncated;
	}
	return files;
}

function pathName(value: string, stripPrefix = true): string {
	let path = value.replace(/\t.*$/, "");
	if (path.startsWith('"')) try { path = JSON.parse(path); } catch { /* Preserve malformed metadata as text. */ }
	return stripPrefix ? path.replace(/^[ab]\//, "") : path;
}

/** Parse Git patches without treating header-looking source lines as metadata. */
export function parseUnifiedDiff(text: string): ChangedFile[] {
	const files: ChangedFile[] = [];
	let file: ChangedFile | undefined, oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
	for (const raw of text.split("\n")) {
		if (raw.startsWith("diff --git ")) {
			file = { path: "", added: 0, removed: 0, counted: true, lines: [] };
			files.push(file); oldRemaining = newRemaining = 0;
			const match = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(raw);
			if (match) { file.oldPath = pathName(match[1]); file.path = pathName(match[2]); }
			continue;
		}
		if (!file) continue;
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
		if (hunk) { oldLine = +hunk[1]; oldRemaining = hunk[2] === undefined ? 1 : +hunk[2]; newLine = +hunk[3]; newRemaining = hunk[4] === undefined ? 1 : +hunk[4]; continue; }
		if (oldRemaining || newRemaining) {
			if (raw.startsWith("+")) { file.lines.push({ marker: "+", newLine: newLine++, text: raw.slice(1) }); newRemaining--; file.added++; }
			else if (raw.startsWith("-")) { file.lines.push({ marker: "-", oldLine: oldLine++, text: raw.slice(1) }); oldRemaining--; file.removed++; }
			else if (raw.startsWith(" ")) { file.lines.push({ marker: " ", oldLine: oldLine++, newLine: newLine++, text: raw.slice(1) }); oldRemaining--; newRemaining--; }
			continue;
		}
		if (raw.startsWith("+++ ") && raw !== "+++ /dev/null") file.path = pathName(raw.slice(4));
		else if (raw.startsWith("--- ") && raw !== "--- /dev/null") file.oldPath = pathName(raw.slice(4));
		else if (raw.startsWith("rename from ")) file.oldPath = pathName(raw.slice(12), false);
		else if (raw.startsWith("rename to ")) file.path = pathName(raw.slice(10), false);
		else if (raw.startsWith("Binary files ") || raw === "GIT binary patch") file.binary = true;
		else if (raw === "\\ Preview truncated") file.truncated = true;
	}
	return files.filter(file => file.path);
}

/** Word LCS with a bounded matrix; huge lines use the shared prefix/suffix. */
export function changedWords(text: string, peer: string): { text: string; changed: boolean }[] {
	const words = text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
	const other = peer.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
	const shared = new Set<number>();
	if (words.length * other.length <= 250000) {
		const width = other.length + 1;
		const matrix = new Uint32Array((words.length + 1) * width);
		for (let i = words.length - 1; i >= 0; i--) for (let j = other.length - 1; j >= 0; j--) {
			matrix[i * width + j] = words[i] === other[j] ? matrix[(i + 1) * width + j + 1] + 1 : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
		}
		for (let i = 0, j = 0; i < words.length && j < other.length;) {
			if (words[i] === other[j]) { shared.add(i++); j++; }
			else if (matrix[(i + 1) * width + j] >= matrix[i * width + j + 1]) i++;
			else j++;
		}
	} else {
		let start = 0, end = 0;
		while (start < words.length && start < other.length && words[start] === other[start]) shared.add(start++);
		while (end < words.length - start && end < other.length - start && words.at(-end - 1) === other.at(-end - 1)) { shared.add(words.length - end - 1); end++; }
	}
	const parts: { text: string; changed: boolean }[] = [];
	words.forEach((word, index) => { const changed = !shared.has(index), last = parts.at(-1); if (last?.changed === changed) last.text += word; else parts.push({ text: word, changed }); });
	return parts;
}

export type VisibleDiff = { kind: "line"; index: number } | { kind: "gap"; start: number; end: number };
export function foldDiff(lines: ChangeLine[]): VisibleDiff[] {
	const rows: VisibleDiff[] = [];
	for (let index = 0; index < lines.length;) {
		if (lines[index].marker !== " ") { rows.push({ kind: "line", index: index++ }); continue; }
		let end = index;
		while (end < lines.length && lines[end].marker === " ") end++;
		const startHidden = index === 0 ? index : Math.min(index + 3, end);
		const endHidden = end === lines.length ? end : Math.max(startHidden, end - 3);
		if (endHidden - startHidden > 4) {
			for (let n = index; n < startHidden; n++) rows.push({ kind: "line", index: n });
			rows.push({ kind: "gap", start: startHidden, end: endHidden });
			for (let n = endHidden; n < end; n++) rows.push({ kind: "line", index: n });
		} else for (let n = index; n < end; n++) rows.push({ kind: "line", index: n });
		index = end;
	}
	return rows;
}

/** Summaries belong to completed user turns; automatic reminders stay in the
 * original turn. Current task uses the server's artifact boundary verbatim. */
export function turnChangeSummaries(messages: UiMessage[], current: TaskProgress | null | undefined, cwd: string, streaming: boolean): Map<string, ChangedFile[]> {
	const summaries = new Map<string, ChangedFile[]>();
	const starts = messages.flatMap((message, index) => message.role === "user" && message.origin !== "auto-reminder" ? [index] : []);
	for (let n = 0; n < starts.length; n++) {
		if (streaming && n === starts.length - 1) continue;
		const turn = messages.slice(starts[n], starts[n + 1] ?? messages.length);
		const last = turn.findLast(message => message.role === "assistant");
		if (!last) continue;
		const task: TaskProgress = current?.sourceMessageId === turn[0].id ? current : {
			id: turn[0].id, sourceMessageId: turn[0].id, conversationId: "", title: "", status: "done", startedAt: 0, completed: 0,
			steps: turn.filter(message => message.role === "assistant").map(message => ({ id: message.id, messageId: message.id, title: "", status: "done", startedAt: 0, artifacts: message.content.flatMap(block => {
				if (block.type !== "toolCall") return [];
				const call = block as UiToolCallBlock;
				const change = editWriteChange(call);
				return change ? [{ toolCallId: call.id, kind: change.kind, path: change.path, label: change.path }] : [];
			}) })),
		};
		const files = taskChanges(task, current === task ? messages : turn, cwd);
		if (files.length) summaries.set(last.id, files);
	}
	return summaries;
}
