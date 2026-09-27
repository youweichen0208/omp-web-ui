export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface UsageMessage { role: string; usage?: TokenUsage; timestamp?: number }

/** Cache read divided by all prompt input reported by the model. */
export function cacheHitPercent(usage: Pick<TokenUsage, "input" | "cacheRead" | "cacheWrite">): number | null {
	const total = usage.input + usage.cacheRead + usage.cacheWrite;
	return total > 0 ? Math.round(usage.cacheRead / total * 100) : null;
}

export function recentModelUsages(messages: readonly UsageMessage[], limit = 12): TokenUsage[] {
	return messages.filter((message) => message.role === "assistant" && message.usage &&
		message.usage.input + message.usage.cacheRead + message.usage.cacheWrite > 0)
		.slice(-limit).map((message) => message.usage!);
}

/** Usage alone cannot identify a provider's cache invalidation cause. */
export function cacheObservation(usage: TokenUsage): "new-write" | "fresh-input" | "no-read" | "unknown" {
	const total = usage.input + usage.cacheRead + usage.cacheWrite;
	if (total === 0) return "unknown";
	if (usage.cacheWrite > 0 && usage.cacheWrite / total >= 0.25) return "new-write";
	if (usage.input / total >= 0.5) return "fresh-input";
	if (usage.cacheRead === 0) return "no-read";
	return "unknown";
}
