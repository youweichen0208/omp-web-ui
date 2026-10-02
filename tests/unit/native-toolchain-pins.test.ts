import { it, expect, vi } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeCodeToolchains } from "../../server/code-native-toolchains.js";
import {
	nativeToolchainPins,
	pinnedNativeAsset,
} from "../../server/native-toolchain-pins.js";
import { codeDefaults } from "../../server/code-intelligence.js";
import { rustAnalysisLimitation } from "../../server/code-languages.js";
it("locks every shipped platform asset and rejects changed upstream digests", () => {
	for (const [name, asset] of Object.entries(nativeToolchainPins.assets)) {
		expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(pinnedNativeAsset(name, asset.sha256)).toEqual(asset);
		expect(() => pinnedNativeAsset(name, "0".repeat(64))).toThrow(/changed/);
	}
	expect(() => pinnedNativeAsset("new-unreviewed-file.zip")).toThrow(
		/No pinned/,
	);
	expect(nativeToolchainPins.versions.jdk).toBe("jdk-21.0.12.1+1");
});
it("downloads a pinned release directly without GitHub API and rejects replacement bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-pinned-release-")),
		tools = new NativeCodeToolchains(root);
	const fetch = vi
		.spyOn(tools as any, "fetch")
		.mockResolvedValue(new Response("replaced executable"));
	try {
		await expect(tools.install("rust")).rejects.toThrow(
			/SHA256 mismatch[\s\S]*local server path/,
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0]).toMatch(
			/^https:\/\/github\.com\/rust-lang\/rust-analyzer\/releases\/download\//,
		);
		await expect(readFile(join(root, "ready.json"))).rejects.toThrow();
	} finally {
		await tools.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
it("rejects corrupted bytes even when a download responds successfully", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-pinned-bytes-")),
		tools = new NativeCodeToolchains(root);
	vi.spyOn(tools as any, "fetch").mockResolvedValue(
		new Response("replaced executable"),
	);
	try {
		await expect(
			(tools as any).download(
				"https://example.test/file",
				pinnedNativeAsset("clangd-mac-23.1.0.zip").sha256,
				join(root, "file.zip"),
			),
		).rejects.toThrow(/SHA256 mismatch/);
	} finally {
		await tools.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
it("includes the official macOS Go location under a GUI PATH and excludes project binaries", async () => {
	const tools = new NativeCodeToolchains("/tmp/pi-path-fixture");
	const seen: string[] = [];
	vi.spyOn(tools as any, "executable").mockImplementation(
		async (...args: unknown[]) => {
			seen.push(String(args[0]));
			return undefined;
		},
	);
	const previous = process.env.PATH;
	process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
	try {
		await (tools as any).find("go", "/project");
		expect(seen).toContain(
			`/usr/local/go/bin/go${process.platform === "win32" ? ".exe" : ""}`,
		);
	} finally {
		process.env.PATH = previous;
		await tools.shutdown();
	}
});
it("marks disabled macro expansion as a limitation without hiding real macro definition errors", () => {
	expect(
		rustAnalysisLimitation("unresolved-proc-macro", "proc macro not expanded"),
	).toBe(true);
	expect(rustAnalysisLimitation("macro-error", "OUT_DIR not available")).toBe(
		true,
	);
	expect(
		rustAnalysisLimitation(
			"macro-error",
			"unexpected token in macro invocation",
		),
	).toBe(false);
	expect(rustAnalysisLimitation("E0308", "type mismatch")).toBe(false);
});
it("keeps Go checksum verification enabled even with private module user settings", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-go-sum-")),
		tools = new NativeCodeToolchains(root);
	vi.spyOn(tools as any, "find").mockResolvedValue(process.execPath);
	const run = vi.spyOn(tools as any, "run").mockResolvedValue("");
	try {
		await tools.install("go");
		const options = run.mock.calls[0][2] as { env: Record<string, string> };
		expect(options.env.GOSUMDB).toBe("sum.golang.org");
		expect(options.env.GONOSUMDB).toBe("none");
		expect(options.env.GOPRIVATE).toBe("none");
	} finally {
		await tools.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
it("explains GitHub rate limiting with a retry, proxy and local server fallback", async () => {
	const { MockAgent } = await import("undici");
	const root = await mkdtemp(join(tmpdir(), "pi-gh-quota-")),
		tools = new NativeCodeToolchains(root),
		mock = new MockAgent();
	await (tools as any).dispatcher.close();
	(tools as any).dispatcher = mock;
	mock.disableNetConnect();
	mock
		.get("https://api.github.com")
		.intercept({ path: "/rate-test" })
		.reply(403, { message: "API rate limit exceeded" });
	try {
		await expect(
			(tools as any).fetch("https://api.github.com/rate-test"),
		).rejects.toThrow(/rate limited[\s\S]*local server path/);
	} finally {
		await tools.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

it("retains the selected Java server JDK when the user later switches JAVA_HOME to Java 8", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-server-jdk-")),
		tools = new NativeCodeToolchains(root),
		serverHome = join(root, "external-jdk21");
	const java = vi
		.spyOn(tools as any, "java")
		.mockResolvedValue(join(serverHome, "bin", "java"));
	const previousJavaHome = process.env.JAVA_HOME;
	vi.spyOn(tools as any, "fetch").mockResolvedValue(
		new Response(
			pinnedNativeAsset("jdt-language-server-1.61.0-202609031315.tar.gz")
				.sha256,
		),
	);
	vi.spyOn(tools as any, "download").mockImplementation(
		async (...args: unknown[]) => {
			await writeFile(String(args[2]), "fixture");
		},
	);
	vi.spyOn(tools as any, "unpack").mockImplementation(
		async (...args: unknown[]) => {
			await mkdir(String(args[1]), { recursive: true });
		},
	);
	try {
		await tools.install("java");
		expect((await (tools as any).installed("java")).jdk).toBe(serverHome);
		const server = join((tools as any).root("java"), "server");
		await mkdir(join(server, "plugins"), { recursive: true });
		await writeFile(
			join(server, "plugins", "org.eclipse.equinox.launcher_fixture.jar"),
			"fixture",
		);
		const config =
			process.platform === "darwin"
				? "config_mac"
				: process.platform === "win32"
					? "config_win"
					: "config_linux";
		await mkdir(join(server, config));
		process.env.JAVA_HOME = join(root, "jdk8");
		java.mockImplementation(async (...args: unknown[]) =>
			args[0] === serverHome ? join(serverHome, "bin", "java") : undefined,
		);
		const launch = await tools.launch(
			"java",
			join(root, "project"),
			codeDefaults(),
		);
		expect(launch.command).toBe(join(serverHome, "bin", "java"));
	} finally {
		if (previousJavaHome === undefined) delete process.env.JAVA_HOME;
		else process.env.JAVA_HOME = previousJavaHome;
		await tools.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
