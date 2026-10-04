import type { McpExposure } from "../../server/protocol.js";
export const MCP_EXPOSURES: McpExposure[] = ["codemode", "deferred", "direct", "hidden"];
export function effectiveMcpExposure(config: Record<string, unknown>, tool: string): { value: string; override: boolean } {
	const rules = config.toolExposure && typeof config.toolExposure === "object" ? config.toolExposure as Record<string, string> : {};
	const exact = rules[tool];
	const pattern = Object.entries(rules).find(([key]) => new RegExp(`^${key.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(tool));
	const value = exact ?? pattern?.[1] ?? String(config.exposure ?? "codemode");
	return { value: value === "codemode-deferred" ? "codemode" : value, override: exact !== undefined || pattern !== undefined };
}
/** Import JSON from common clients; validate again with Pi before persisting. */
export function importMcpJson(text: string, current: Record<string, unknown>): Record<string, unknown> {
	const source = JSON.parse(text);
	const entries = source.mcpServers ?? source.servers ?? source.mcp;
	if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("Expected mcpServers, servers, or mcp");
	const servers = { ...(current.mcpServers as Record<string, unknown> ?? {}) };
	for (const [name, value] of Object.entries(entries)) {
		if (Object.hasOwn(servers, name)) throw new Error(`Server already exists: ${name}`);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid server: ${name}`);
		const config = { ...value } as Record<string, unknown>;
		if (config.type === "local") { config.type = "stdio"; if (Array.isArray(config.command)) { const [command, ...args] = config.command; config.command = command; config.args = args; } if (config.environment) { config.env = config.environment; delete config.environment; } }
		if (config.type === "remote") config.type = "http";
		const encoded = JSON.stringify(config).replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}");
		if (/\$\{input:/.test(encoded)) throw new Error("Replace ${input:...} with ${ENV_NAME} before importing");
		servers[name] = JSON.parse(encoded);
	}
	return { ...current, mcpServers: servers };
}
