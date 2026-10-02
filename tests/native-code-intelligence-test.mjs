/** Native servers are optional. CI --install validates their actual upstream binaries. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const appRoot = resolve(process.env.PI_NATIVE_APP_ROOT || process.cwd());
const { CodeIntelligenceManager, codeDefaults } = await import(
	pathToFileURL(join(appRoot, "dist/server/code-intelligence.js"))
);
const root = await mkdtemp(join(tmpdir(), "pi-native-lsp-test-"));
const data = process.env.PI_NATIVE_TEST_DATA || join(root, "data");
const manager = new CodeIntelligenceManager(data, () => true);
manager.subscribe((state) => {
	for (const service of state.services)
		if (service.error && ["failed", "oom"].includes(service.status))
			console.error(`${service.language}: ${service.error}`);
});
const requested = (
	process.env.PI_NATIVE_TEST_LANGUAGES || "java,go,rust,cpp"
).split(",");
const javaVersion = process.env.PI_NATIVE_JAVA_VERSION || "21";
const projectJdk = process.env.PI_NATIVE_PROJECT_JDK;
const fixtures = {
	java: {
		path: "src/main/java/Example.java",
		bad: 'public class Example { public static int square(int x) { return x*x; } int broken = "wrong"; }',
		good: "public class Example { public static int square(int x) { return x*x; } int broken = 1; }",
		symbol: "square",
		line: 1,
		markers: {
			"pom.xml": `<project><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>fixture</artifactId><version>1</version><properties><maven.compiler.source>${javaVersion === "8" ? "1.8" : javaVersion}</maven.compiler.source><maven.compiler.target>${javaVersion === "8" ? "1.8" : javaVersion}</maven.compiler.target><maven.compiler.release>${javaVersion}</maven.compiler.release></properties></project>`,
		},
	},
	go: {
		path: "main.go",
		bad: 'package fixture\nfunc Square(x int) int { return x*x }\nvar broken int = "wrong"\n',
		good: "package fixture\nfunc Square(x int) int { return x*x }\nvar broken int = 1\n",
		symbol: "Square",
		line: 2,
		markers: { "go.mod": "module fixture\n\ngo 1.22\n" },
	},
	rust: {
		path: "src/lib.rs",
		bad: 'pub fn square(x: i32) -> i32 { x*x }\npub fn broken() -> i32 { "wrong" }\n',
		good: "pub fn square(x: i32) -> i32 { x*x }\npub fn broken() -> i32 { 1 }\n",
		symbol: "square",
		line: 1,
		markers: {
			"Cargo.toml":
				'[package]\nname="fixture"\nversion="0.1.0"\nedition="2021"\n',
			"build.rs":
				'fn main() { std::fs::write("build-script-executed", "executed").unwrap(); }',
		},
	},
	cpp: {
		path: "main.cpp",
		bad: 'int square(int x) { return x*x; }\nint broken = "wrong";\n',
		good: "int square(int x) { return x*x; }\nint broken = 1;\n",
		symbol: "square",
		line: 1,
		markers: { "compile_flags.txt": "-std=c++17\n" },
	},
};
if (javaVersion === "8" && projectJdk) {
	fixtures.java.bad = fixtures.java.bad.replace(
		/ }$/,
		' java.util.List<String> values = java.util.List.of("unsupported"); }',
	);
	fixtures.java.good = fixtures.java.good.replace(
		/ }$/,
		' java.util.List<String> values = java.util.Collections.singletonList("supported"); }',
	);
}
if (javaVersion === "17") {
	fixtures.java.bad = fixtures.java.bad.replace(
		/ }$/,
		" public record Point(int x) {} }",
	);
	fixtures.java.good = fixtures.java.good.replace(
		/ }$/,
		" public record Point(int x) {} }",
	);
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
try {
	for (const language of requested) {
		const fixture = fixtures[language];
		assert(fixture, language);
		const cwd = join(root, language);
		await mkdir(cwd);
		for (const [path, text] of Object.entries({
			...fixture.markers,
			[fixture.path]: fixture.bad,
		})) {
			await mkdir(join(cwd, path, ".."), { recursive: true });
			await writeFile(join(cwd, path), text);
		}
		if (process.argv.includes("--install"))
			await manager.install(cwd, language);
		if (language === "java" && projectJdk) {
			assert(["8", "17"].includes(javaVersion));
			await manager.configure(cwd, {
				...codeDefaults(),
				javaProjectHomes: { [javaVersion]: projectJdk },
			});
		}
		const state = await manager.state(cwd);
		assert(state.settings[language]);
		let before;
		for (let attempt = 0; attempt < 200; attempt++) {
			before = await manager.query(cwd, {
				action: "diagnostics",
				path: fixture.path,
			});
			if (
				before.freshness === "fresh" &&
				before.diagnostics.some((d) => d.severity === 1)
			)
				break;
			await wait(300);
		}
		assert.equal(before.freshness, "fresh", `${language}: diagnostics fresh`);
		assert(
			before.diagnostics.some((d) => d.severity === 1),
			`${language}: detects actual type error: ${JSON.stringify(before)}; state=${JSON.stringify(await manager.state(cwd))}`,
		);
		if (language === "java" && javaVersion === "8" && projectJdk) {
			assert(
				before.diagnostics.some((d) => /of\(/.test(d.message)),
				`Java 8 must reject Java 9 List.of API: ${JSON.stringify(before)}`,
			);
		}
		const symbols = await manager.query(cwd, {
			action: "symbols",
			path: fixture.path,
		});
		assert(
			JSON.stringify(symbols).includes(fixture.symbol),
			`${language}: symbols`,
		);
		const symbol = await manager.query(cwd, {
			action: "read_symbol",
			path: fixture.path,
			line: fixture.line,
			symbol: fixture.symbol,
		});
		assert(
			symbol.results.some((s) => s.text.includes(fixture.symbol)),
			`${language}: reads enclosing symbol`,
		);
		const definition = await manager.query(cwd, {
			action: "navigate",
			path: fixture.path,
			line: fixture.line,
			symbol: fixture.symbol,
			operation: "definition",
		});
		assert(
			definition.results.some(
				(item) =>
					item.result &&
					JSON.stringify(item.result).includes(fixture.path.split("/").at(-1)),
			),
			`${language}: definition navigation`,
		);
		await writeFile(join(cwd, fixture.path), fixture.good);
		let repaired;
		for (let attempt = 0; attempt < 200; attempt++) {
			repaired = await manager.query(cwd, {
				action: "diagnostics",
				path: fixture.path,
			});
			if (
				repaired.freshness === "fresh" &&
				!repaired.diagnostics.some((d) => d.severity === 1)
			)
				break;
			await wait(300);
		}
		assert.equal(repaired.freshness, "fresh", `${language}: repair freshness`);
		assert(
			!repaired.diagnostics.some((d) => d.severity === 1),
			`${language}: repaired error removed: ${JSON.stringify(repaired)}`,
		);
		if (language === "rust")
			await assert.rejects(readFile(join(cwd, "build-script-executed")), {
				code: "ENOENT",
			});
		console.log(
			`PASS actual ${language}${language === "java" ? ` Maven Java ${javaVersion}` : ""}: symbols, symbol read, type error and repaired diagnostics`,
		);
		// Give other languages slots while keeping this test's ownership isolated.
	}
} finally {
	await manager.shutdown();
	await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
