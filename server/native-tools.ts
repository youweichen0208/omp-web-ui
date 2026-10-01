import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, type InlineExtension } from "@earendil-works/pi-coding-agent";

/** Same native extensions as the Pi CLI; activation follows the user's settings. */
export function nativeToolExtensions(): InlineExtension[] {
	return [
		{ name: "codemode", builtin: true, factory: createCodemodeExtension() },
		{ name: "tool-search", builtin: true, factory: createToolSearchExtension() },
		{ name: "mcp", builtin: true, factory: createMcpExtension() },
	];
}
