import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DefaultPackageManager, VERSION, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { ComponentUpdate } from "./protocol.js";

import { extensionDisplay } from "./extension-display.js";

let restartRequired = false;
export const componentRestartRequired = () => restartRequired;
export function markComponentUpdated(): void { restartRequired = true; }

export interface UpdateTarget { id: string; name: string; current: string | null; kind: "bundled" | "npm" | "git" | "local"; source?: string; directory?: string; pinned?: boolean; ambiguous?: boolean; scope?: "user" | "project"; packageName?: string }
const npmSource = /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@([^\s]+))?$/i;
function packageInfo(directory: string): { name?: string; version?: string } {
	try {
		const value = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		return { name: typeof value?.name === "string" ? value.name : undefined, version: typeof value?.version === "string" ? value.version : undefined };
	} catch { return {}; }
}
export function packageManagerFor(session: AgentSession, cwd: string, agentDir: string): DefaultPackageManager {
	return new DefaultPackageManager({ cwd, agentDir, settingsManager: session.settingsManager });
}
export function updateTargets(session: AgentSession, manager: DefaultPackageManager): UpdateTarget[] {

	const targets: UpdateTarget[] = [
		{ id: "builtin:agent", name: "pi Agent", current: VERSION, kind: "bundled", packageName: "@earendil-works/pi-coding-agent" },

	];
	const packages = manager.listConfiguredPackages();
	for (const pkg of packages) {
		const parsed = npmSource.exec(pkg.source);
		const metadata = pkg.installedPath ? packageInfo(pkg.installedPath) : {};
		const git = /^(?:git:|https?:\/\/|git@|ssh:\/\/)/.test(pkg.source);
		targets.push({ id: `${pkg.scope}:${pkg.source}`, name: parsed?.[1] ?? metadata.name ?? pkg.source, source: pkg.source, scope: pkg.scope, directory: pkg.installedPath, kind: parsed && ["@youweichen/pi-harness", "pi-harness"].includes(parsed[1]) ? "bundled" : parsed ? "npm" : git ? "git" : "local", packageName: parsed?.[1], current: metadata.version ?? null, ambiguous: packages.filter((other) => parsed ? npmSource.exec(other.source)?.[1] === parsed[1] : other.source === pkg.source).length > 1, pinned: parsed ? !!parsed[2] : git && pkg.source.includes("#") });
	}
	const roots = packages.flatMap((pkg) => pkg.installedPath ? [pkg.installedPath.replaceAll("\\", "/").replace(/\/$/, "") + "/"] : []);
	for (const extension of session.resourceLoader.getExtensions().extensions) {
		if (extension.hidden || extension.resolvedPath.startsWith("builtin:")) continue;
		const path = extension.resolvedPath;
		if (roots.some((root) => path.replaceAll("\\", "/").startsWith(root))) continue;
		targets.push({ id: `local:${path}`, name: extensionDisplay(path).name, current: null, kind: "local" });
	}
	return targets;
}

const parseVersion = (value: string) => /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
/** Only stable registry releases are offered; prerelease builds are not silently selected. */
export function hasNewerStableVersion(current: string, latest: string): boolean {
	const a = parseVersion(current), b = parseVersion(latest);
	if (!a || !b || b[4]) return false;
	for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(b[i]) > Number(a[i]);
	return !!a[4];
}
const registryCache = new Map<string, { until: number; promise: Promise<string> }>();
export async function latestNpmVersion(name: string): Promise<string> {
	const cached = registryCache.get(name);
	if (cached && cached.until > Date.now()) return cached.promise;
	const promise = (async () => {
		const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(8000) });
		if (!response.ok) throw Error(`HTTP ${response.status}`);
		const data = await response.json() as { version?: unknown };
		if (typeof data.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(data.version)) throw Error("Invalid registry version");
		return data.version;
	})();
	registryCache.set(name, { until: Date.now() + 300_000, promise });
	if (registryCache.size > 256) registryCache.delete(registryCache.keys().next().value!);
	try { return await promise; } catch (error) { registryCache.delete(name); throw error; }
}
export const gitOutput = (cwd: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
	execFile("git", args, { cwd, timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) => error ? reject(Error("Git update check failed")) : resolve(stdout.trim()));
});
export async function checkComponent(target: UpdateTarget, npm = latestNpmVersion, git = gitOutput): Promise<ComponentUpdate> {
	const result: ComponentUpdate = { id: target.id, name: target.name, current: target.current, latest: null, kind: target.kind, scope: target.scope, status: "manual", canUpdate: false };
	try {
		if (target.kind === "local") return result;
		if (target.kind === "git") {
			if (!target.directory) throw Error("Package not installed");
			result.current = (await git(target.directory, ["rev-parse", "HEAD"])).slice(0, 12);
			if (target.pinned) return { ...result, status: "pinned" };
			const upstream = await git(target.directory, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => "");
			const ref = upstream.startsWith("origin/") ? `refs/heads/${upstream.slice(7)}` : "HEAD";
			const remote = await git(target.directory, ["ls-remote", "origin", ref]);
			const sha = /^([0-9a-f]{40,64})\s/m.exec(remote)?.[1];
			if (!sha) throw Error("Remote version unavailable");
			result.latest = sha.slice(0, 12);
		} else {
			if (!target.packageName) throw Error("Package name unavailable");
			result.latest = await npm(target.packageName);
		}
		const comparable = !!result.current && (target.kind === "git" || !!parseVersion(result.current) && !!parseVersion(result.latest!) && !parseVersion(result.latest!)![4]);
		const available = comparable && (target.kind === "git" ? result.current !== result.latest : hasNewerStableVersion(result.current!, result.latest!));
		return { ...result, status: target.ambiguous ? "manual" : target.pinned ? "pinned" : !comparable ? "unknown" : available ? "available" : "current", canUpdate: available && !target.pinned && !target.ambiguous && target.kind !== "bundled" };
	} catch (error) { return { ...result, status: "error", error: error instanceof Error ? error.message : "Check failed" }; }
}
export async function checkComponents(targets: UpdateTarget[]): Promise<ComponentUpdate[]> {
	const results: ComponentUpdate[] = [];
	// Keep registry/git concurrency bounded for installations with many extensions.
	for (let i = 0; i < targets.length; i += 4) results.push(...await Promise.all(targets.slice(i, i + 4).map((target) => checkComponent(target))));
	return results;
}

/** Resolve updates from the server catalog, never a client-supplied package spec. */
export async function updateComponentPackage(targets: UpdateTarget[], id: string, update: (source: string) => Promise<void>, check = checkComponent, git = gitOutput): Promise<void> {
	const target = targets.find((entry) => entry.id === id);
	if (!target?.source || target.kind === "bundled" || target.kind === "local" || target.pinned) throw Error("该组件需要随应用升级或手动维护");
	if (target.ambiguous) throw Error("同一来源安装在多个范围，请按范围手动更新");
	if (!(await check(target)).canUpdate) throw Error("没有可安装的更新，请重新检查");
	if (target.kind === "git" && target.directory && await git(target.directory, ["status", "--porcelain"])) throw Error("扩展目录有本地改动，请先保存或提交后再更新");
	await update(target.source);
	markComponentUpdated();
}
