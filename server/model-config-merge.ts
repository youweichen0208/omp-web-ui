import type { UiProviderConfig } from "./protocol.js";

export const isChatModelConfig = (model: Record<string, unknown>): boolean => model.type === undefined || model.type === "chat";

/** A chat editor owns chat fields only; keep provider operations and typed models intact. */
export function mergeChatProvider(previous: Record<string, unknown>, config: UiProviderConfig): Record<string, unknown> {
	const existing = Array.isArray(previous.models) ? previous.models as Record<string, unknown>[] : [];
	const typed = existing.filter(model => !isChatModelConfig(model));
	const ids = new Set<string>();
	const models = config.models.filter(model => model.id.trim()).map(model => {
		const id = model.id.trim();
		if (ids.has(id)) throw new Error(`Duplicate chat model ID: ${id}`);
		ids.add(id);
		const result: Record<string, unknown> = { ...existing.find(entry => entry.id === id && isChatModelConfig(entry)), id };
		for (const key of ["name", "reasoning", "input", "contextWindow", "maxTokens"] as const) {
			delete result[key];
			const value = model[key];
			if (value !== undefined && value !== "") result[key] = value;
		}
		return result;
	});
	const result: Record<string, unknown> = { ...previous, models: [...models, ...typed] };
	for (const key of ["name", "api", "baseUrl", "authHeader"] as const) {
		delete result[key];
		const value = config[key];
		if (value !== undefined && value !== "") result[key] = value;
	}
	// An empty key in an existing editor means retain the server-owned credential.
	if (config.apiKey?.trim()) result.apiKey = config.apiKey.trim();
	return result;
}
