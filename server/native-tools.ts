import { SettingsManager, createCodemodeExtension, createMcpExtension, createToolSearchExtension, type InlineExtension } from "@earendil-works/pi-coding-agent";

const runOverrides = new WeakMap<SettingsManager, { compaction?: { enabled: boolean }; retry?: { enabled: boolean } }>();
export function setConversationRunSettings(settings: SettingsManager, values: { autoCompaction?: boolean; autoRetry?: boolean }) {
	const overrides = { ...runOverrides.get(settings), ...(typeof values.autoCompaction === "boolean" ? { compaction: { enabled: values.autoCompaction } } : {}), ...(typeof values.autoRetry === "boolean" ? { retry: { enabled: values.autoRetry } } : {}) };
	runOverrides.set(settings, overrides);
	settings.applyOverrides(overrides);
}

/** A native manager with conversation-local overrides; native writes stay native. */
export function conversationSettings(cwd: string, agentDir: string): SettingsManager {
	const settings = SettingsManager.create(cwd, agentDir);
	const apply = () => {
		settings.applyOverrides(runOverrides.get(settings) ?? {});
		if (settings.getSettings().defaultTools === undefined) settings.applyOverrides({ defaultTools: ["+codemode", "+tool_search"] });
	};
	const reload = settings.reload.bind(settings);
	settings.reload = async () => { await reload(); apply(); };
	const trust = settings.setProjectTrusted.bind(settings);
	settings.setProjectTrusted = value => { trust(value); apply(); };
	apply();
	return settings;
}

/** Same native extensions as the Pi CLI; activation follows the user's settings. */
export function nativeToolExtensions(): InlineExtension[] {
	return [
		{ name: "codemode", builtin: true, replaceable: true, factory: createCodemodeExtension() },
		{ name: "tool-search", builtin: true, replaceable: true, factory: createToolSearchExtension() },
		{ name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension() },
	];
}

/** Stable settings aliases for the SDK's named inline extension paths. */
export function nativeExtensionPath(path: string): string {
	return /^builtin:(mcp|tool-search|codemode)$/.test(path) ? `<inline:${path.slice(8)}>` : path;
}
