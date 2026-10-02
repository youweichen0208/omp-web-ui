import { opendir, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
const ignored = new Set([
	".git",
	"node_modules",
	".venv",
	"venv",
	".gradle",
	".m2",
	".idea",
	"target",
	"dist",
	"build",
	"vendor",
]);
/** Bounded breadth-first discovery; directory symlinks are never traversed. */
export async function discoverJavaProjects(cwd: string) {
	const queue = [{ path: cwd, depth: 0 }];
	let gradle = false,
		partial = false,
		entries = 0;
	for (let index = 0; index < queue.length && index < 256; index++) {
		const directory = queue[index];
		// Check descriptors first, even if the directory contains many other files.
		if (
			(
				await stat(join(directory.path, "pom.xml")).catch(() => undefined)
			)?.isFile()
		)
			return { maven: true, gradle, partial };
		try {
			const handle = await opendir(directory.path);
			for await (const entry of handle) {
				if (++entries > 10000) return { maven: false, gradle, partial: true };
				if (
					entry.isFile() &&
					["build.gradle", "build.gradle.kts"].includes(entry.name)
				)
					gradle = true;
				if (
					directory.depth < 3 &&
					entry.isDirectory() &&
					!ignored.has(entry.name)
				) {
					if (queue.length < 256)
						queue.push({
							path: join(directory.path, entry.name),
							depth: directory.depth + 1,
						});
					else partial = true;
				}
			}
		} catch {
			partial = true;
		}
	}
	return { maven: false, gradle, partial };
}
/** Only paths are inspected; credentials/settings contents never enter UI state. */
export function defaultMavenSettings(
	home = homedir(),
	env: NodeJS.ProcessEnv = process.env,
) {
	const file = (path: string) => {
		if (!isAbsolute(path)) return "";
		try {
			return statSync(path).isFile() ? path : "";
		} catch {
			return "";
		}
	};
	return {
		mavenUserSettings: file(join(home, ".m2", "settings.xml")),
		mavenGlobalSettings: env.MAVEN_HOME
			? file(join(env.MAVEN_HOME, "conf", "settings.xml"))
			: env.M2_HOME
				? file(join(env.M2_HOME, "conf", "settings.xml"))
				: "",
	};
}

/** mvn is only inspected, never executed (including version-manager shims). */
export async function mavenSettingsNearExecutable(command: string) {
	const base = dirname(command);
	for (const candidate of [
		join(base, "..", "conf", "settings.xml"),
		join(base, "..", "libexec", "conf", "settings.xml"),
	]) {
		if ((await stat(candidate).catch(() => undefined))?.isFile())
			return candidate;
	}
	return undefined;
}
