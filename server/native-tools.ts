import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, type InlineExtension } from "@earendil-works/pi-coding-agent";

/** Seed the standard Pi settings file; existing native tool choices remain authoritative. */
export function ensureNativeToolDefaults(agentDir: string): void {
	const path = join(agentDir, "settings.json");
	const source = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Invalid native Pi settings.json");
	if (Object.hasOwn(source, "defaultTools")) return;
	mkdirSync(agentDir, { recursive: true });
	const temporary = `${path}.webui-${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify({ ...source, defaultTools: ["+codemode", "+tool_search"] }, null, "\t") + "\n", { mode: 0o600 });
	renameSync(temporary, path);
}

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
