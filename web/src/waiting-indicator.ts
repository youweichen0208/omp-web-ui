import type { UiMessage } from "../../server/protocol.js";
import { splitCommandChain } from "./bash-steps.js";
import { activeTool } from "./agent-activity.js";

export type WaitLabel = "waitUnderstanding" | "waitResults" | "waitFile" | "waitThinking" | "waitTests" | "waitBuild" | "waitSteer";
export interface WaitStage { key: string; label: WaitLabel; delay: number }

/** Presentation only: visible content wins; a completed tool starts a new wait. */
export function conversationWait(messages: readonly UiMessage[], completed: ReadonlyMap<string, unknown>, steeredUserId?: string): WaitStage | null {
	const userIndex = messages.findLastIndex(m => m.role === "user");
	const turn = messages.slice(userIndex + 1);
	const running = activeTool(messages, completed);
	if (running) {
		let command = "";
		try { command = JSON.parse(running.argumentsText ?? "{}").command ?? ""; } catch { /* Partial arguments. */ }
		if (running.name !== "bash" || typeof command !== "string") return null;
		// Match executable positions, not test/build words inside echo or filenames.
		const segments = splitCommandChain(command);
		const test = segments.some(s => /^(?:(?:npm|pnpm|yarn|bun) (?:run )?test(?:[:\s]|$)|(?:npx )?(?:vitest|pytest|jest)(?:\s|$)|python\d? -m pytest(?:\s|$))/.test(s));
		const build = segments.some(s => /^(?:(?:npm|pnpm|yarn|bun) (?:run )?build(?:[:\s]|$)|(?:npx )?(?:tsc|vite build|make|cargo build)(?:\s|$))/.test(s));
		return test || build ? { key: running.id, label: test ? "waitTests" : "waitBuild", delay: 4000 } : null;
	}
	for (let i = turn.length - 1; i >= 0; i--) {
		const message = turn[i];
		if (message.role === "toolResult") return { key: message.toolCallId ?? message.id, label: message.toolName === "read" ? "waitFile" : "waitResults", delay: 300 };
		if (message.role !== "assistant") continue;
		for (const block of [...message.content].reverse()) {
			if (block.type === "toolCall" && typeof block.id === "string") return completed.has(block.id) ? { key: block.id, label: block.name === "read" ? "waitFile" : "waitResults", delay: 300 } : null;
			if (block.type === "text" && ((typeof block.text === "string" && block.text.trim()) || block.truncated)) return null;
			if (block.type === "thinking") {
				if (typeof block.thinking === "string" && block.thinking.trim()) return null;
				if (message.content.some(b => b.type === "text" && (typeof b.text === "string" && b.text.trim() || b.truncated) || b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim())) return null;
				return { key: message.id, label: "waitThinking", delay: 300 };
			}
		}
	}
	const user = messages[userIndex];
	return user ? { key: user.id, label: user.id === steeredUserId ? "waitSteer" : "waitUnderstanding", delay: 300 } : null;
}
