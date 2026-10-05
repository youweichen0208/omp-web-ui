import { createHash } from "node:crypto";
import { join, relative, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { DefaultPackageManager, SettingsManager, ProjectTrustStore, loadSkills, type PackageSource } from "@earendil-works/pi-coding-agent";
import { settingsVersion, sourceOf } from "./extensions-model.js";
import type { NativeSkillsState } from "./protocol.js";

/** Discover native resources without loading extension entry points or installing dependencies. */
export async function nativeSkills(cwd: string, agentDir: string, change?: { id: string; enabled: boolean; version: string }, valid = () => true): Promise<NativeSkillsState> {
	const trusted = new ProjectTrustStore(agentDir).get(cwd) === true;
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
	const fail = () => { const errors = settings.drainErrors(); if (errors.length) throw Error(errors.map(e => e.error.message).join("\n")); };
	fail();
	const version = settingsVersion(cwd, agentDir);
	const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
	const resources = (await manager.resolve(async () => "skip")).skills;
	const entries = resources.flatMap(resource => {
		const loaded = loadSkills({ cwd, agentDir, includeDefaults: false, skillPaths: [resource.path] }).skills;
		return loaded.map(skill => ({ resource, skill, id: createHash("sha256").update(`${resource.metadata.scope}:${resource.metadata.source}:${resource.path}:${skill.filePath}`).digest("hex") }));
	});
	if (change) {
		if (!valid()) throw Error("Workspace changed");
		if (change.version !== version || version !== settingsVersion(cwd, agentDir)) throw Error("Pi settings changed; refresh before applying changes");
		const target = entries.find(entry => entry.id === change.id);
		if (!target || target.resource.metadata.scope === "temporary") throw Error("Skill unavailable");
		const { path, metadata } = target.resource;
		const project = metadata.scope === "project";
		if (project && !trusted) throw Error("Project is not trusted");
		// A toggle must never affect multiple skills discovered from one custom directory.
		if (entries.filter(entry => entry.resource === target.resource).length !== 1) throw Error("Manage this shared skill directory in native settings");
		const config = project ? settings.getProjectSettings() : settings.getGlobalSettings();
		const base = (resource: typeof target.resource) => resource.metadata.packageRoot ?? resource.metadata.baseDir ?? (project ? join(cwd, ".pi") : agentDir);
		const matches = (pattern: string, resource: typeof target.resource) => {
			const normalized = pattern.slice(1).replace(/^\.[\\/]/, "").replaceAll("\\", "/");
			const paths = [resource.path, relative(base(resource), resource.path)];
			if (basename(resource.path) === "SKILL.md") paths.push(dirname(resource.path), relative(base(resource), dirname(resource.path)));
			return paths.some(value => value.replaceAll("\\", "/") === normalized);
		};
		const override = (patterns: string[]) => {
			const removed = patterns.filter(p => /^[+-]/.test(p) && matches(p, target.resource));
			const retained = patterns.filter(p => !removed.includes(p));
			for (const resource of resources) {
				if (resource === target.resource || resource.metadata.scope !== metadata.scope || resource.metadata.origin !== metadata.origin || metadata.origin === "package" && resource.metadata.source !== metadata.source) continue;
				for (const pattern of removed) if (matches(pattern, resource)) retained.push(`${pattern[0]}${resource.path}`);
			}
			return [...retained, `${change.enabled ? "+" : "-"}${path}`];
		};
		if (metadata.origin === "package") {
			const packages: PackageSource[] = [...(config.packages ?? [])];
			const index = packages.findIndex(entry => sourceOf(entry) === metadata.source);
			if (index < 0) throw Error("Package no longer configured");
			const entry = packages[index];
			const declaration = typeof entry === "string" ? { source: entry } : entry;
			// [] means none, unlike an absent filter. Preserve that baseline when enabling one.
			const patterns = declaration.skills?.length === 0 && declaration.autoload !== false ? ["!**"] : declaration.skills ?? [];
			packages[index] = { ...declaration, skills: override(patterns) };
			if (project) settings.setProjectPackages(packages); else settings.setPackages(packages);
		} else {
			const paths = override(config.skills ?? []);
			if (project) settings.setProjectSkillPaths(paths); else settings.setSkillPaths(paths);
		}
		await settings.flush(); fail();
		return nativeSkills(cwd, agentDir);
	}
	return {
		version,
		paths: [...new Set([join(agentDir, "skills"), join(homedir(), ".agents/skills"), join(cwd, ".pi/skills"), ...resources.map(r => r.metadata.packageRoot).filter((path): path is string => !!path)])],
		skills: entries.map(({ id, skill, resource }) => ({ id, name: skill.name, description: skill.description, path: skill.filePath, enabled: resource.enabled, source: resource.metadata.origin === "package" ? "package" : resource.metadata.scope, scope: resource.metadata.scope, canToggle: resource.metadata.scope !== "temporary" && entries.filter(e => e.resource === resource).length === 1, promptVisible: !skill.disableModelInvocation })),
	};
}
