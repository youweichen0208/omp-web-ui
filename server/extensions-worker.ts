import { DefaultPackageManager, SettingsManager, ProjectTrustStore, type PackageSource } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionOperation, ExtensionPackage, ExtensionsState, ExtensionScope } from "./protocol.js";
import { readJson, textField, resourceTypes, sourceOf, sourceInfo, packageDisabled, settingsVersion } from "./extensions-model.js";
import { gitOutput, latestNpmVersion } from "./component-updates.js";
export interface WorkerRequest { cwd: string; agentDir: string; action: "list" | "check" | "mutate"; operation?: ExtensionOperation; source?: string; version?: string; }
const blankResources = () => ({ extensions: [] as string[], skills: [] as string[], prompts: [] as string[], themes: [] as string[] });
export async function extensionWork(input: WorkerRequest, progress: (message: string) => void = () => {}): Promise<ExtensionsState> {
	const { cwd, agentDir } = input;
	const trusted = new ProjectTrustStore(agentDir).get(cwd) === true;
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
	const errors = settings.drainErrors(); if (errors.length) throw Error(errors.map(e => e.error.message).join("\n"));
	const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
	manager.setProgressCallback(event => progress(`${event.type}: ${event.message ?? event.source}`));
	const config = (scope: ExtensionScope) => scope === "user" ? settings.getGlobalSettings() : settings.getProjectSettings();
	const packages = (scope: ExtensionScope) => config(scope).packages ?? [];
	const setPackages = (scope: ExtensionScope, entries: PackageSource[]) => scope === "user" ? settings.setPackages(entries) : settings.setProjectPackages(entries);
	const flush = async () => { await settings.flush(); const errors = settings.drainErrors(); if (errors.length) throw Error(errors.map(e => e.error.message).join("\n")); };
	const scopedManager = (scope:ExtensionScope, entries:PackageSource[]) => {
		const isolated = SettingsManager.inMemory({...settings.getSettings(), packages:[]}, {projectTrusted:true});
		if(scope === "project") isolated.setProjectPackages(entries); else isolated.setPackages(entries);
		return new DefaultPackageManager({cwd,agentDir,settingsManager:isolated});
	};
	const checkUpdates = async () => (await Promise.all((["user","project"] as const).filter(scope=>scope==="user"||trusted).map(scope=>scopedManager(scope,packages(scope)).checkForAvailableUpdates()))).flat();
	const backupPath = join(agentDir, "webui-extension-filters.json");
	const backup = readJson(backupPath);
	const backupKey = (id: string) => createHash("sha256").update(`${id.startsWith("user:") ? "global" : cwd}:${id}`).digest("hex");
	const saveBackup = () => { mkdirSync(agentDir, { recursive: true }); writeFileSync(`${backupPath}.tmp`, JSON.stringify(backup), { mode: 0o600 }); renameSync(`${backupPath}.tmp`, backupPath); };
	async function list(): Promise<ExtensionsState> {
		const resources = await manager.resolve(async () => "skip");
		const result: ExtensionPackage[] = [];
		const projectDeclarations = readJson(join(cwd, ".pi/settings.json")).packages ?? [];
		for (const scope of ["user", "project"] as const) {
			const declarations: PackageSource[] = scope === "project" && !trusted ? projectDeclarations : packages(scope);
			for (const entry of declarations) {
				const source = sourceOf(entry), info = sourceInfo(source), path = scope === "project" && !trusted ? undefined : manager.getInstalledPath(source, scope);
				let metadata: Record<string,any> = {}; if (path) try { metadata = readJson(join(path, "package.json")); } catch {}
				const counts = blankResources();
				for (const type of resourceTypes) counts[type] = resources[type].filter(r => r.metadata.source === source && r.metadata.scope === scope).map(r => relative(path ?? cwd, r.path));
				result.push({ id: `${scope}:${source}`, source, scope, kind: info.kind, name: textField(metadata.name) ?? info.name, path, version: textField(metadata.version), description: textField(metadata.description), enabled: !packageDisabled(entry), pinned: info.pinned, trusted: scope === "user" || trusted, resources: counts, protected: ["@youweichen/pi-web-ui", "pi-web-ui", "@earendil-works/pi-coding-agent"].includes(info.name) });
			}
		}
		for (const resource of resources.extensions) {
			if (resource.metadata.origin !== "top-level" || resource.path.startsWith("builtin:") || resource.metadata.scope === "temporary") continue;
			result.push({ id: `file:${resource.metadata.scope}:${resource.path}`, source: resource.path, name: basename(resource.path), scope: resource.metadata.scope, kind: "file", path: resource.path, enabled: resource.enabled, pinned: false, trusted: resource.metadata.scope === "user" || trusted, resources: blankResources() });
		}
		return { packages: result, version: settingsVersion(cwd,agentDir), trusted };
	}
	if (input.action === "mutate") {
		if (input.version !== settingsVersion(cwd,agentDir)) throw Error("Pi settings changed; refresh before applying changes");
		const op = input.operation!;
		const state = await list(), target = state.packages.find(p => p.id === op.id);
		if (!["install","update-all"].includes(op.action) && !target) throw Error("Package no longer configured");
		if (target?.kind === "file" && op.action !== "toggle") throw Error("Standalone files only support toggling and editing");
		if (target?.protected) throw Error("This package must be managed with the application");
		if (target && !target.trusted || op.scope === "project" && !trusted) throw Error("Project is not trusted; review it in MCP settings or Pi first");
		if (input.version !== settingsVersion(cwd,agentDir)) throw Error("Pi settings changed; refresh before applying changes");
		const scope = target?.scope ?? op.scope ?? "user", local = scope === "project";
		const source = target?.source ?? input.source!;
		const entries = packages(scope), index = entries.findIndex(p => sourceOf(p) === source);
		if (op.action === "install") {
			if (!input.source) throw Error("Install preview expired");
			if (["@youweichen/pi-web-ui", "pi-web-ui", "@earendil-works/pi-coding-agent"].includes(sourceInfo(input.source).name)) throw Error("Manage this package with the application updater");
			await manager.install(input.source, { local });
			if (input.version !== settingsVersion(cwd,agentDir)) throw Error("Pi settings changed during install; files were installed but configuration was not overwritten");
			manager.addSourceToSettings(input.source, { local });
		} else if (op.action === "remove") {
			await manager.remove(source, { local });
			await settings.reload(); manager.removeSourceFromSettings(source, { local });
			delete backup[backupKey(target!.id)]; saveBackup();
		} else if (op.action === "toggle" && target?.kind === "file") {
			const paths = [...(config(scope).extensions ?? [])].filter(p => p !== `-${source}` && p !== `+${source}`);
			paths.push(`${op.enabled ? "+" : "-"}${source}`);
			if (local) settings.setProjectExtensionPaths(paths); else settings.setExtensionPaths(paths);
		} else if (op.action === "toggle") {
			const key = backupKey(target!.id);
			if (!op.enabled && !packageDisabled(entries[index])) { backup[key] = entries[index]; saveBackup(); entries[index] = { ...(typeof entries[index] === "object" ? entries[index] : { source }), autoload: true, extensions: [], skills: [], prompts: [], themes: [] }; }
			if (op.enabled && packageDisabled(entries[index])) entries[index] = backup[key] ?? { source };
			setPackages(scope, entries);
		} else if (op.action === "unpin") {
			const unpinned = sourceInfo(source).unpinned;
			entries[index] = typeof entries[index] === "string" ? unpinned : { ...entries[index], source: unpinned };
			const saved = backup[backupKey(target!.id)]; if (saved) { backup[backupKey(`${scope}:${unpinned}`)] = typeof saved === "string" ? unpinned : { ...saved, source: unpinned }; saveBackup(); }
			setPackages(scope, entries);
		} else if (op.action === "move") {
			const destination = scope === "user" ? "project" : "user";
			if (!trusted) throw Error("Project is not trusted");
			if (packages(destination).some(p => sourceInfo(sourceOf(p)).unpinned === sourceInfo(source).unpinned)) throw Error("Package already declared in destination scope");
			const movedSource = target!.kind === "local" ? target!.path ?? source : source;
			await manager.install(movedSource, { local: destination === "project" });
			if (input.version !== settingsVersion(cwd,agentDir)) throw Error("Pi settings changed during move; destination files installed but configuration retained");
			const old = entries[index], moved = typeof old === "string" ? movedSource : { ...old, source: movedSource };
			setPackages(destination, [...packages(destination), moved]); await flush();
			setPackages(scope, entries.filter((_,i) => i !== index));
			const oldBackup = backup[backupKey(target!.id)]; if (oldBackup) { backup[backupKey(`${destination}:${movedSource}`)] = typeof oldBackup === "string" ? movedSource : { ...oldBackup, source: movedSource }; saveBackup(); }
		} else if (op.action === "update" || op.action === "update-all") {
			const updates = await checkUpdates();
			const eligible = state.packages.filter(p => !p.protected && p.trusted && !p.pinned && updates.some(u => u.source === p.source && u.scope === p.scope) && (op.action === "update-all" || p.id === target!.id));
			if (!eligible.length) throw Error("No updates available");
			for (const [i,p] of eligible.entries()) {
				if (p.kind === "git" && p.path && await gitOutput(p.path,["status","--porcelain"])) throw Error(`Local changes in ${p.name}; commit or save them before updating`);
				progress(`${i+1}/${eligible.length} ${p.name}`);
				// A scope-isolated native manager prevents update(source) from also updating another declaration.
				const updater = scopedManager(p.scope,[p.source]);
				updater.setProgressCallback(event => progress(`${event.type}: ${event.message ?? event.source}`));
				await updater.update(p.source);
			}
		} else throw Error("Unsupported operation");
		await flush();
	}
	const state = await list();
	if (input.action === "check") {
		const updates = await checkUpdates();
		for (const item of state.packages) {
			item.update = !item.protected && updates.some(u => u.scope === item.scope && u.source === item.source);
			if (item.update && item.kind === "npm" && !sourceInfo(item.source).ref) try { item.latest = await latestNpmVersion(sourceInfo(item.source).name); } catch (e) { item.checkError = String(e); }
			if (item.update && item.kind === "git") item.latest = "HEAD";
		}
		state.checkedAt = Date.now();
	}
	return state;
}
if (process.send && process.argv.includes("--extensions-worker")) process.once("message", (input: WorkerRequest) => {
	void extensionWork(input, message => process.send?.({ progress: message })).then(state => process.send?.({ state }, () => process.disconnect()), error => process.send?.({ error: error instanceof Error ? error.message : String(error) }, () => process.disconnect()));
});
