import type { TaskProgress, UiMessage, UiToolCallBlock } from "../../server/protocol.js";
import { editWriteChange } from "./edit-write-presentation.js";

/** Normalize lexical aliases only; never infer filesystem changes from shell text. */
export function outputPath(path: string, cwd: string): string {
	const normalize = (value: string) => {
		const parts: string[] = [];
		for (const part of value.replace(/\\/g, "/").split("/")) {
			if (part === ".") continue;
			if (part === ".." && parts.length && parts.at(-1) !== ".." && parts.at(-1) !== "") parts.pop();
			else parts.push(part);
		}
		return parts.join("/");
	};
	const root = normalize(cwd).replace(/\/$/, "");
	const normalized = normalize(path);
	return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

export function taskOutputs(task: TaskProgress | null | undefined, messages: UiMessage[], cwd: string) {
	const files = new Map<string, { path: string; added: number; removed: number; counted: boolean }>();
	if (!task) return [];
	const results = new Map(messages.filter(message => message.role === "toolResult").map(message => [message.toolCallId, message]));
	const calls = new Map<string, UiToolCallBlock>();
	for (const message of messages) if (message.role === "assistant") for (const block of message.content) {
		if (block.type === "toolCall" && typeof block.id === "string") calls.set(block.id, block as UiToolCallBlock);
	}
	const seen = new Set<string>();
	for (const step of task.steps) for (const artifact of step.artifacts) {
		if (seen.has(artifact.toolCallId)) continue;
		seen.add(artifact.toolCallId);
		const result = results.get(artifact.toolCallId), call = calls.get(artifact.toolCallId);
		if (!artifact.path || !["write", "edit"].includes(artifact.kind) || !result || result.isError) continue;
		const path = outputPath(artifact.path, cwd);
		const file = files.get(path) ?? { path, added: 0, removed: 0, counted: false };
		const change = call && editWriteChange(call, result);
		// write reports the new content, not a diff against the previous file.
		if (change?.kind === "edit" && !change.error && !change.diffTruncated && !change.empty) {
			file.added += change.added;
			file.removed += change.removed;
			file.counted = true;
		}
		files.set(path, file);
	}
	return [...files.values()];
}
