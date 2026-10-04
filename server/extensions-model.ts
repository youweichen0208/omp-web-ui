import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { PackageSource } from "@earendil-works/pi-coding-agent";
export const textField = (value: unknown): string | undefined => typeof value === "string" ? value.slice(0, 4000) : undefined;
export const resourceTypes = ["extensions", "skills", "prompts", "themes"] as const;
export const sourceOf = (entry: PackageSource) => typeof entry === "string" ? entry : entry.source;
export function readJson(path: string): Record<string, any> {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
export function settingsVersion(cwd: string, agentDir: string): string {
	return createHash("sha256").update(JSON.stringify([readJson(join(agentDir, "settings.json")), readJson(join(cwd, ".pi/settings.json"))])).digest("hex");
}
export function packageDisabled(entry: PackageSource): boolean { return typeof entry !== "string" && resourceTypes.every(type => Array.isArray(entry[type]) && entry[type]!.length === 0); }
export function sourceInfo(source: string) {
	const npm = /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@([^\s]+))?$/i.exec(source);
	if (npm) return { kind: "npm" as const, name: npm[1], ref: npm[2], pinned: /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(npm[2] ?? ""), unpinned: `npm:${npm[1]}` };
	if (/^(git:|https?:\/\/|git@|ssh:\/\/)/.test(source)) {
		const ref = /(?:\.git|\/[^/@]+)@(.+)$/.exec(source)?.[1] ?? /#([^#]+)$/.exec(source)?.[1];
		return { kind: "git" as const, name: source, ref, pinned: !!ref, unpinned: ref ? source.slice(0, -(ref.length + 1)) : source };
	}
	return { kind: "local" as const, name: source.split(/[\\/]/).at(-1) || source, pinned: false, unpinned: source };
}
export function validateSource(value: unknown, cwd: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\x00-\x1f]/.test(value)) throw Error("Invalid package source");
	const source = value.trim();
	if (source.startsWith("-")) throw Error("Invalid package source");
	if (source.startsWith("npm:")) { if (sourceInfo(source).kind !== "npm") throw Error("Invalid npm source"); return source; }
	if (/^(git:|https?:\/\/|git@|ssh:\/\/)/.test(source)) return source;
	return resolve(cwd, source.startsWith("~/") ? join(homedir(), source.slice(2)) : source);
}
