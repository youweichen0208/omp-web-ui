import type { AgentMessage } from "./serialize.js";

export interface ContextParts { system: number; tools: number; conversation: number; attachments: number }

/** Provider APIs report one context total, not a breakdown by content origin.
 * Allocate that total using the SDK's chars/4 heuristic (images ≈1200 tokens).
 * The UI must label these four values as estimates. */
export function estimateContextParts(messages: readonly AgentMessage[], systemPrompt: string, totalTokens: number | null): ContextParts | null {
	if (totalTokens === null || !Number.isFinite(totalTokens) || totalTokens < 0) return null;
	const raw: ContextParts = { system: systemPrompt.length / 4, tools: 0, conversation: 0, attachments: 0 };
	const content = (value: unknown, category: "tools" | "conversation") => {
		if (typeof value === "string") { raw[category] += value.length / 4; return; }
		if (!Array.isArray(value)) return;
		for (const block of value) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "image") { raw.attachments += 1200; continue; }
			if (block.type === "toolCall") { raw.tools += (String(block.name ?? "").length + JSON.stringify(block.arguments ?? {}).length) / 4; continue; }
			if (typeof block.text === "string") raw[category] += block.text.length / 4;
			if (typeof block.thinking === "string") raw[category] += block.thinking.length / 4;
		}
	};
	for (const message of messages) {
		if (message.role === "assistant" || message.role === "user") content(message.content, "conversation");
		else if (message.role === "toolResult" || message.role === "custom") content(message.content, "tools");
		else if (message.role === "bashExecution") raw.tools += (message.command.length + message.output.length) / 4;
		else if (message.role === "branchSummary" || message.role === "compactionSummary") raw.conversation += message.summary.length / 4;
	}
	const keys = ["system", "tools", "conversation", "attachments"] as const;
	const rawTotal = keys.reduce((sum, key) => sum + raw[key], 0);
	if (rawTotal <= 0) return { system: 0, tools: 0, conversation: Math.round(totalTokens), attachments: 0 };
	const target = Math.round(totalTokens);
	const exact = keys.map((key) => raw[key] * target / rawTotal);
	const values = exact.map(Math.floor);
	let remaining = target - values.reduce((sum, value) => sum + value, 0);
	for (const index of keys.map((_, index) => index).sort((a, b) => exact[b] % 1 - exact[a] % 1)) {
		if (remaining-- <= 0) break;
		values[index]++;
	}
	return { system: values[0], tools: values[1], conversation: values[2], attachments: values[3] };
}
