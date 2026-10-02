import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
const sdkDirectory = createRequire(import.meta.url).resolve.paths("@earendil-works/pi-coding-agent")?.map(path => join(path, "@earendil-works/pi-coding-agent/dist/core/mcp-servers.js")).find(path => existsSync(path));
if (!sdkDirectory) throw new Error("Pi MCP configuration validator missing");
const { validateMcpServerConfig } = await import(pathToFileURL(sdkDirectory).href) as { validateMcpServerConfig: (name: string, raw: unknown) => object | string };
import type { NativeMcpConfigState } from "./protocol.js";

const MASK = "••••••••";
type Document = { mcpServers?: Record<string, Record<string, unknown>>; [key: string]: unknown };
function read(path: string): string { try { return readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}"; throw error; } }
function version(raw: string) { return createHash("sha256").update(raw).digest("hex"); }
function transform(value: unknown, old: unknown, mask: boolean, secret = false): unknown {
	if (Array.isArray(value)) return value.map((v,i) => transform(v, Array.isArray(old) ? old[i] : undefined, mask, secret));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, transform(v, old && typeof old === "object" ? (old as Record<string,unknown>)[k] : undefined, mask, secret || /secret|token|password|apiKey|headers|env/i.test(k))]));
	if (secret && typeof value === "string") {
		if (mask) return value ? MASK : "";
		if (value === MASK) { if (typeof old !== "string") throw new Error("Masked value has no existing secret"); return old; }
	}
	return value;
}
export class NativeMcpConfigService {
	isTrusted(cwd: string): boolean { return new ProjectTrustStore(getAgentDir()).get(cwd) === true; }
	path(cwd: string, scope: "global" | "project") { if (scope !== "global" && scope !== "project") throw new Error("Invalid MCP configuration scope"); return scope === "global" ? join(getAgentDir(), "mcp.json") : join(cwd, ".pi", "mcp.json"); }
	get(cwd: string, scope: "global" | "project"): NativeMcpConfigState {
		const path = this.path(cwd,scope), raw = read(path), document = JSON.parse(raw) as Document;
		if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("MCP configuration must be an object");
		return { path, scope, version: version(raw), document: transform(document, undefined, true) as Record<string,unknown>, trusted: this.isTrusted(cwd) };
	}
	save(cwd: string, scope: "global" | "project", expected: string, incoming: Record<string,unknown>) {
		if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) throw new Error("MCP configuration must be an object");
		const path = this.path(cwd,scope), raw = read(path);
		if (version(raw) !== expected) throw new Error("MCP configuration changed externally; refresh before saving");
		const old = JSON.parse(raw) as Document;
		const document = transform({ ...old, ...incoming }, old, false) as Document;
		if (!document.mcpServers || Array.isArray(document.mcpServers) || typeof document.mcpServers !== "object") throw new Error("mcpServers must be an object");
		for (const [name, config] of Object.entries(document.mcpServers)) {
			const result = validateMcpServerConfig(name, config); if (typeof result === "string") throw new Error(result);
			if (scope === "project" && config.auth) throw new Error("Provider authentication is allowed only in global MCP configuration");
		}
		mkdirSync(dirname(path), { recursive: true }); writeFileSync(`${path}.webui.tmp`, JSON.stringify(document,null,2)+"\n", { mode: 0o600 }); renameSync(`${path}.webui.tmp`,path);
		return this.get(cwd,scope);
	}
	trust(cwd: string) { new ProjectTrustStore(getAgentDir()).set(cwd,true); }
}
