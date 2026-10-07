import type { UiMessage, UiToolCallBlock } from "../../server/protocol.js";

/** Tool-result records belong to the preceding assistant step, not a new reply. */
export function assistantPredecessors(messages: readonly UiMessage[]) {
	const previous = new Map<string, string>();
	let assistant: UiMessage | undefined;
	for (const message of messages) {
		if (message.role === "toolResult") continue;
		if (message.role !== "assistant") { assistant = undefined; continue; }
		if (assistant && assistant.model === message.model) previous.set(message.id, assistant.id);
		assistant = message;
	}
	return previous;
}
export function activeTool(messages: readonly UiMessage[], completed: ReadonlyMap<string, unknown>): UiToolCallBlock | undefined {
	const results = new Set(messages.filter(m => m.role === "toolResult").map(m => m.toolCallId));
	// Only the current user turn can be working; old interrupted tool calls stay old.
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user") break;
		for (const block of [...message.content].reverse()) {
			if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string" && !results.has(block.id) && !completed.has(block.id)) return block as UiToolCallBlock;
		}
		// A later assistant tool batch supersedes missing results from an older attempt.
		if (message.role === "assistant" && message.content.some(block => block.type === "toolCall")) return undefined;
	}
}
export function toolTarget(block: UiToolCallBlock) {
	try {
		const args = JSON.parse(block.argumentsText ?? "{}");
		const path = args.path ?? args.file_path;
		return typeof path === "string" ? path.split(/[\\/]/).at(-1) ?? path : block.name;
	} catch { return block.name; }
}
