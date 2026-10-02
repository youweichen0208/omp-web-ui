import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, type InlineExtension } from "@earendil-works/pi-coding-agent";

/** Same native extensions as the Pi CLI; activation follows the user's settings. */
export function nativeToolExtensions(): InlineExtension[] {
	return [
		{ name: "codemode", builtin: true, factory: createCodemodeExtension() },
		{ name: "tool-search", builtin: true, factory: createToolSearchExtension() },
		{ name: "mcp", builtin: true, factory: createMcpExtension() },
	];
}

/** Stable settings aliases for the SDK's named inline extension paths. */
export function nativeExtensionPath(path: string): string {
	return /^builtin:(mcp|tool-search|codemode)$/.test(path) ? `<inline:${path.slice(8)}>` : path;
}
