import { createPlanExtension } from "./plan/extension.js";
import { createPdfMarkdownExtension } from "./document-conversion/extension.js";
import { createOkfExtension } from "./okf/extension.js";
import { SettingsManager, createCodemodeExtension, createMcpExtension, createToolSearchExtension, type InlineExtension } from "@earendil-works/pi-coding-agent";

const runOverrides = new WeakMap<SettingsManager, { compaction?: { enabled: boolean }; retry?: { enabled: boolean } }>();
export function setConversationRunSettings(settings: SettingsManager, values: { autoCompaction?: boolean; autoRetry?: boolean }) {
	const overrides = { ...runOverrides.get(settings), ...(typeof values.autoCompaction === "boolean" ? { compaction: { enabled: values.autoCompaction } } : {}), ...(typeof values.autoRetry === "boolean" ? { retry: { enabled: values.autoRetry } } : {}) };
	runOverrides.set(settings, overrides);
}

/** A native manager with conversation-local overrides; native writes stay native. */
export function conversationSettings(cwd: string, agentDir: string): SettingsManager {
	const settings = SettingsManager.create(cwd, agentDir);
	const getCompactionEnabled = settings.getCompactionEnabled.bind(settings);
	const getRetryEnabled = settings.getRetryEnabled.bind(settings);
	const getDefaultTools = settings.getDefaultTools.bind(settings);
	const defaultTools = SettingsManager.inMemory({ defaultTools: ["+codemode", "+tool_search"] }).getDefaultTools()!;
	settings.getCompactionEnabled = () => runOverrides.get(settings)?.compaction?.enabled ?? getCompactionEnabled();
	settings.getRetryEnabled = () => runOverrides.get(settings)?.retry?.enabled ?? getRetryEnabled();
	settings.getDefaultTools = () => [...(getDefaultTools() ?? defaultTools)];
	return settings;
}

/** Same native extensions as the Pi CLI; activation follows the user's settings. */
export function nativeToolExtensions(): InlineExtension[] {
	return [
		{ name: "pi-harness-plan", replaceable: true, factory: createPlanExtension() },
		{ name: "pi-harness-pdf-markdown", replaceable: true, factory: createPdfMarkdownExtension() },
		{ name: "pi-harness-okf", replaceable: true, factory: createOkfExtension() },
		{ name: "codemode", builtin: true, replaceable: true, factory: createCodemodeExtension() },
		{ name: "tool-search", builtin: true, replaceable: true, factory: createToolSearchExtension() },
		{ name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension() },
	];
}

/** Stable settings aliases for the SDK's named inline extension paths. */
export function nativeExtensionPath(path: string): string {
	return /^builtin:(mcp|tool-search|codemode)$/.test(path) ? `<inline:${path.slice(8)}>` : path;
}
