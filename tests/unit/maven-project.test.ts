import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverJavaProjects,
	defaultMavenSettings,
} from "../../server/maven-project.js";
import {
	CodeIntelligenceManager,
	codeDefaults,
} from "../../server/code-intelligence.js";
import { serverSettings } from "../../server/code-languages.js";
it("finds Maven at three directory levels and prefers it over Gradle", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-nested-maven-"));
	try {
		await mkdir(join(root, "services/java/backend"), { recursive: true });
		await writeFile(join(root, "build.gradle"), "ignored");
		await writeFile(join(root, "services/java/backend/pom.xml"), "<project/>");
		expect((await discoverJavaProjects(root)).maven).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it("ignores generated/dependency directories and deeper Maven projects", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-maven-ignore-"));
	try {
		for (const path of [
			"node_modules/pkg",
			"target/generated",
			".git/repo",
			"a/b/c/d",
		]) {
			await mkdir(join(root, path), { recursive: true });
			await writeFile(join(root, path, "pom.xml"), "<project/>");
		}
		expect((await discoverJavaProjects(root)).maven).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it("prewarms nested Maven using the same discovery as explicit Java queries", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-maven-warm-"));
	const manager = new CodeIntelligenceManager(join(root, "data"), () => true);
	let launched = 0;
	(manager as any).nativeTools.launch = async () => {
		launched++;
		throw Error("Maven launcher reached");
	};
	try {
		await mkdir(join(root, "backend"));
		await writeFile(join(root, "backend/pom.xml"), "<project/>");
		await writeFile(join(root, "backend/Example.java"), "class Example {}");
		await (manager as any).warm(await manager.project(root));
		expect(launched).toBe(1);
		expect(
			(await manager.state(root)).services.find((s) => s.language === "java")
				?.status,
		).not.toBe("unsupported_java");
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
it("discovers existing user and Maven installation settings by path only", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-maven-settings-"));
	try {
		await mkdir(join(root, ".m2"));
		await mkdir(join(root, "maven/conf"), { recursive: true });
		await writeFile(join(root, ".m2/settings.xml"), "private user config");
		await writeFile(
			join(root, "maven/conf/settings.xml"),
			"private global config",
		);
		const settings = defaultMavenSettings(root, {
			MAVEN_HOME: join(root, "maven"),
		});
		expect(settings).toEqual({
			mavenUserSettings: join(root, ".m2/settings.xml"),
			mavenGlobalSettings: join(root, "maven/conf/settings.xml"),
		});
		expect(
			serverSettings("java", { ...codeDefaults(), ...settings }),
		).toMatchObject({
			java: {
				configuration: {
					maven: {
						userSettings: settings.mavenUserSettings,
						globalSettings: settings.mavenGlobalSettings,
					},
				},
			},
		});
		expect(
			defaultMavenSettings(root, { M2_HOME: join(root, "maven") }),
		).toEqual(settings);
		expect(defaultMavenSettings(join(root, "missing"), {})).toEqual({
			mavenUserSettings: "",
			mavenGlobalSettings: "",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it("validates explicit Maven settings and preserves them when reloading saved settings", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-maven-config-"));
	const manager = new CodeIntelligenceManager(join(root, "data"), () => false);
	let reloaded: CodeIntelligenceManager | undefined;
	try {
		await expect(
			manager.configure(root, {
				...codeDefaults(),
				mavenGlobalSettings: "conf/settings.xml",
			}),
		).rejects.toThrow(/absolute/);
		const settings = {
			...codeDefaults(),
			mavenUserSettings: join(root, "user.xml"),
			mavenGlobalSettings: join(root, "global.xml"),
		};
		await manager.configure(root, settings);
		reloaded = new CodeIntelligenceManager(join(root, "data"), () => false);
		expect((await reloaded.state(root)).settings).toMatchObject({
			mavenUserSettings: settings.mavenUserSettings,
			mavenGlobalSettings: settings.mavenGlobalSettings,
		});
	} finally {
		await reloaded?.shutdown();
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
it("returns ready Java services without repeating Maven directory discovery, while still rechecking trust", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-java-ready-"));
	let trusted = true;
	const manager = new CodeIntelligenceManager(
		join(root, "data"),
		() => trusted,
	);
	const maven = await import("../../server/maven-project.js");
	const { vi } = await import("vitest");
	const discover = vi.spyOn(maven, "discoverJavaProjects");
	try {
		const project = await manager.project(root);
		const ready = {
			state: {
				language: "java",
				status: "ready",
				rssMiB: 0,
				restarts: 0,
				heapMiB: 1024,
				checkedFiles: 0,
				pendingFiles: 0,
				unconfirmedFiles: 0,
			},
			connection: { dispose() {} },
			docs: new Map(),
			generation: 0,
			retries: 0,
			stderr: "",
		};
		project.services.set("java", ready as any);
		for (let i = 0; i < 5; i++)
			expect(await (manager as any).service(project, "java")).toBe(ready);
		expect(discover).not.toHaveBeenCalled();
		trusted = false;
		await expect((manager as any).service(project, "java")).rejects.toThrow(
			/trust/,
		);
	} finally {
		discover.mockRestore();
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
it.each(["conf/settings.xml", "libexec/conf/settings.xml"])(
	"finds Maven global settings next to mvn using %s layout",
	async (path) => {
		const root = await mkdtemp(join(tmpdir(), "pi-mvn-layout-"));
		try {
			const { mavenSettingsNearExecutable } =
				await import("../../server/maven-project.js");
			await mkdir(join(root, path, ".."), { recursive: true });
			await writeFile(join(root, path), "configuration path only");
			expect(await mavenSettingsNearExecutable(join(root, "bin", "mvn"))).toBe(
				join(root, path),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
it.skipIf(process.platform === "win32")(
	"resolves mvn symlinks outside the project without running Maven",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-mvn-link-"));
		const { NativeCodeToolchains } =
			await import("../../server/code-native-toolchains.js");
		const { symlink, access, realpath } = await import("node:fs/promises");
		const tools = new NativeCodeToolchains(join(root, "data"));
		const previous = process.env.PATH;
		try {
			await mkdir(join(root, "project"));
			await mkdir(join(root, "bin"));
			await mkdir(join(root, "installation/libexec/bin"), { recursive: true });
			await mkdir(join(root, "installation/libexec/conf"), { recursive: true });
			const command = join(root, "installation/libexec/bin/mvn");
			await writeFile(
				command,
				`#!/bin/sh\ntouch '${join(root, "executed")}'\n`,
				{ mode: 0o755 },
			);
			await writeFile(
				join(root, "installation/libexec/conf/settings.xml"),
				"configuration",
			);
			await symlink(command, join(root, "bin/mvn"));
			process.env.PATH = join(root, "bin");
			expect(await tools.findMavenGlobalSettings(join(root, "project"))).toBe(
				await realpath(join(root, "installation/libexec/conf/settings.xml")),
			);
			await expect(access(join(root, "executed"))).rejects.toThrow();
		} finally {
			process.env.PATH = previous;
			await tools.shutdown();
			await rm(root, { recursive: true, force: true });
		}
	},
);
