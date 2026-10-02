import { it, expect } from "vitest";
import {
	languageOf,
	documentLanguage,
	serverSettings,
} from "../../server/code-languages.js";
import {
	safeArchivePath,
	NativeCodeToolchains,
	MissingCodeTool,
} from "../../server/code-native-toolchains.js";
import {
	codeDefaults,
	CodeIntelligenceManager,
} from "../../server/code-intelligence.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
it.each([
	["Example.java", "java"],
	["main.go", "go"],
	["lib.rs", "rust"],
	["main.c", "cpp"],
	["main.cpp", "cpp"],
	["main.CXX", "cpp"],
	["types.hpp", "cpp"],
])("recognizes %s as %s", (path, language) =>
	expect(languageOf(path)).toBe(language),
);
it("uses the language document IDs", () => {
	expect(documentLanguage("main.c")).toBe("c");
	expect(documentLanguage("main.cpp")).toBe("cpp");
	expect(documentLanguage("lib.rs")).toBe("rust");
});
it("rejects archive traversal and platform absolute paths", () => {
	const root = resolve("cache");
	for (const path of ["../escape", "/absolute", "C:/escape", "path\\escape"])
		expect(safeArchivePath(root, path)).toBe(false);
	expect(safeArchivePath(root, "bin/tool")).toBe(true);
});
it("disables Rust build scripts and procedural macros", () =>
	expect(serverSettings("rust", codeDefaults())).toMatchObject({
		"rust-analyzer": {
			cargo: { buildScripts: { enable: false } },
			procMacro: { enable: false },
			files: { watcher: "server" },
			checkOnSave: false,
		},
	}));
it("blocks every native service before launching project-controlled executables", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-native-trust-")),
		cwd = join(root, "project");
	await mkdir(cwd);
	const marker = join(root, "executed"),
		script = join(cwd, "malicious-server");
	await writeFile(script, `#!/bin/sh\necho executed > '${marker}'\n`, {
		mode: 0o755,
	});
	const manager = new CodeIntelligenceManager(join(root, "data"), () => false);
	try {
		const settings = {
			...codeDefaults(),
			nativePaths: { java: script, go: script, rust: script, cpp: script },
		};
		await manager.configure(cwd, settings);
		for (const file of ["Example.java", "main.go", "main.rs", "main.cpp"]) {
			await writeFile(join(cwd, file), "ignored");
			await expect(
				manager.query(cwd, { action: "symbols", path: file }),
			).rejects.toThrow(/trust/);
		}
		await expect(
			import("node:fs/promises").then((fs) => fs.readFile(marker)),
		).rejects.toThrow(/ENOENT/);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
it("rejects missing custom executable paths without downloading", async () => {
	const tools = new NativeCodeToolchains("unused");
	try {
		await expect(
			tools.launch("rust", resolve("."), {
				...codeDefaults(),
				nativePaths: { rust: resolve("missing-rust-analyzer") },
			}),
		).rejects.toBeInstanceOf(MissingCodeTool);
	} finally {
		await tools.shutdown();
	}
});

it("separates Java 8/17 project runtimes from the Java 21 server", () => {
	const settings = {
		...codeDefaults(),
		javaHome: resolve("server21"),
		javaProjectHomes: { "8": resolve("jdk8"), "17": resolve("jdk17") },
	};
	expect(serverSettings("java", settings)).toMatchObject({
		java: {
			configuration: {
				runtimes: [
					{ name: "JavaSE-1.8", path: settings.javaProjectHomes["8"] },
					{ name: "JavaSE-17", path: settings.javaProjectHomes["17"] },
				],
			},
		},
	});
	expect(JSON.stringify(serverSettings("java", codeDefaults()))).not.toContain(
		"JavaSE-1.8",
	);
});
it("rejects relative project JDK paths without launching them", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-java-settings-"));
	const manager = new CodeIntelligenceManager(join(root, "data"), () => false);
	try {
		await expect(
			manager.configure(root, {
				...codeDefaults(),
				javaProjectHomes: { "8": "./jdk" },
			}),
		).rejects.toThrow(/absolute/);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
it("disables Gradle import while retaining Maven and Java project runtimes", () => {
	expect(serverSettings("java", codeDefaults())).toMatchObject({
		java: { import: { gradle: { enabled: false }, maven: { enabled: true } } },
	});
	expect(JSON.stringify(serverSettings("java", codeDefaults()))).not.toContain(
		"wrapper",
	);
});
it.each(["build.gradle", "build.gradle.kts"])(
	"blocks %s projects before launching Java",
	async (marker) => {
		const root = await mkdtemp(join(tmpdir(), "pi-gradle-unsupported-"));
		const manager = new CodeIntelligenceManager(join(root, "data"), () => true);
		let launched = false;
		(manager as any).nativeTools.launch = async () => {
			launched = true;
			throw Error("Unexpected native launch");
		};
		try {
			await writeFile(
				join(root, marker),
				'throw new Error("must not execute")',
			);
			await writeFile(join(root, "Example.java"), "class Example {}");
			const project = await (manager as any).project(root);
			await (manager as any).warm(project);
			await expect(
				manager.query(root, { action: "diagnostics", path: "Example.java" }),
			).rejects.toThrow(/Gradle projects are not supported/);
			expect(launched).toBe(false);
			expect((await manager.state(root)).services).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						language: "java",
						status: "unsupported_gradle",
						rssMiB: 0,
					}),
				]),
			);
			expect((await manager.state(root)).diagnostics).toEqual([]);
			await writeFile(join(root, "pom.xml"), "<project/>");
			await expect(
				manager.query(root, { action: "symbols", path: "Example.java" }),
			).rejects.toThrow(/Unexpected native launch/);
			expect(launched).toBe(true);
		} finally {
			await manager.shutdown();
			await rm(root, { recursive: true, force: true });
		}
	},
);
