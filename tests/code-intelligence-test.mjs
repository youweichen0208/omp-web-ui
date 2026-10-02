/** Real offline toolchain; may run under packaged Electron with its own SDK/dependencies. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	mkdtemp,
	writeFile,
	mkdir,
	readFile,
	rm,
	realpath,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const appRoot = resolve(process.argv[2] || process.cwd());
const { CodeIntelligenceManager, codeDefaults } = await import(
	pathToFileURL(join(appRoot, "dist/server/code-intelligence.js"))
);
const { subscribeProject, projectWatchStats } = await import(
	pathToFileURL(join(appRoot, "dist/server/project-watcher.js"))
);
const root = await mkdtemp(join(tmpdir(), "pi-code-test-"));
let trusted = false;
const manager = new CodeIntelligenceManager(join(root, "data"), () => trusted);
try {
	const cache = join(root, "concurrent-cache");
	const preparation = pathToFileURL(
		join(appRoot, "dist/server/code-toolchain.js"),
	).href;
	const script = `const {prepareToolchain}=await import(${JSON.stringify(preparation)});console.log(await prepareToolchain(${JSON.stringify(cache)}));`;
	const prepared = await Promise.all(
		[1, 2].map(() =>
			promisify(execFile)(
				process.execPath,
				["--input-type=module", "-e", script],
				{ env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: process.platform === "win32" ? 180000 : 60000 },
			),
		),
	);
	assert.equal(prepared[0].stdout.trim(), prepared[1].stdout.trim());
	const cwd = join(root, "project");
	await mkdir(cwd);
	const alias = join(root, "project-alias");
	await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
	await manager.state(alias);
	assert.equal(manager.canonicalCwd(alias), await realpath(cwd));
	await mkdir(join(cwd, "node_modules/typescript"), { recursive: true });
	await mkdir(join(cwd, "node_modules/marker-plugin"), { recursive: true });
	const marker = join(root, "executed");
	const evil = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed'); module.exports=()=>({create: info=>info.languageService});`;
	await writeFile(
		join(cwd, "node_modules/marker-plugin/package.json"),
		JSON.stringify({ name: "marker-plugin", main: "index.js" }),
	);
	await writeFile(join(cwd, "node_modules/marker-plugin/index.js"), evil);
	await writeFile(
		join(cwd, "node_modules/typescript/package.json"),
		JSON.stringify({ name: "typescript", version: "99.0.0", main: "index.js" }),
	);
	await writeFile(join(cwd, "node_modules/typescript/index.js"), evil);
	await writeFile(
		join(cwd, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { strict: true, plugins: [{ name: "marker-plugin" }] },
			include: ["*.ts"],
		}),
	);
	await writeFile(
		join(cwd, "example.ts"),
		'export function greet(name: string) { return name.length; }\nconst broken: number = "wrong";\n',
	);
	await writeFile(
		join(cwd, "example.py"),
		"def greet(name: str) -> int:\n    return name\n",
	);
	const interpreter = join(cwd, "fake-python");
	await writeFile(interpreter, `#!/bin/sh\necho executed > '${marker}'\n`, {
		mode: 0o755,
	});
	await writeFile(
		join(cwd, "pyrightconfig.json"),
		JSON.stringify({ pythonPath: interpreter }),
	);
	await assert.rejects(
		manager.query(cwd, { action: "diagnostics", path: "example.py" }),
		/trust/,
	);
	await assert.rejects(readFile(marker), { code: "ENOENT" });
	assert.notEqual(
		(await manager.query(cwd, { action: "diagnostics" })).freshness,
		"fresh",
	);
	const symbols = await manager.query(cwd, {
		action: "symbols",
		path: "example.ts",
	});
	assert(symbols.results[0].symbols.some((s) => s.name === "greet"));
	await assert.rejects(readFile(marker), { code: "ENOENT" });
	await writeFile(
		join(cwd, "locations.ts"),
		'const emoji = "😀"; export function first(){return 1;} export function second(){return 2;}',
	);
	const located = await manager.query(cwd, {
		action: "read_symbol",
		path: "locations.ts",
		line: 1,
		symbol: "second",
	});
	assert.equal(located.results[0].name, "second");
	assert(!located.results[0].text.includes("function first"));
	const absent = await manager.query(cwd, {
		action: "read_symbol",
		path: "locations.ts",
		line: 1,
		symbol: "sec",
	});
	assert.equal(absent.status, "not_found");
	const diagnostics = await manager.query(cwd, {
		action: "diagnostics",
		path: "example.ts",
	});
	assert(diagnostics.diagnostics.some((d) => d.code === "2322"));
	assert(diagnostics.checkedFiles >= 1);
	assert.equal(
		diagnostics.freshness,
		"fresh",
		"TS freshness must be scoped to TS despite untrusted Python",
	);
	assert(await manager.baseline(cwd, "example.ts"));
	const symbol = await manager.query(cwd, {
		action: "read_symbol",
		path: "example.ts",
		line: 1,
		symbol: "greet",
	});
	assert.match(symbol.results[0].text, /function greet/);
	await assert.rejects(
		manager.query(cwd, { action: "symbols", path: "../outside.ts" }),
		/outside/,
	);
	const prior = symbols.results[0].version;
	await writeFile(
		join(cwd, "example.ts"),
		"export function greet(name: string) { return name.length; }\nconst broken: number = 1;\n",
	);
	await assert.rejects(
		manager.query(cwd, {
			action: "symbols",
			path: "example.ts",
			expectedVersion: prior,
		}),
		/version changed/,
	);
	const fixed = await manager.query(cwd, {
		action: "diagnostics",
		path: "example.ts",
	});
	assert.equal(fixed.freshness, "fresh", "first fresh result after repair");
	assert(!fixed.diagnostics.some((d) => d.code === "2322"));
	// Server-owned watchers must see module creation, removal and dependency installation.
	await writeFile(
		join(cwd, "consumer.ts"),
		'import { value } from "./created"; export const result=value;',
	);
	const missing = await manager.query(cwd, {
		action: "diagnostics",
		path: "consumer.ts",
	});
	assert(missing.diagnostics.some((d) => d.code === "2307"));
	const awaitModule = async (missing) => {
		for (let i = 0; i < 160; i++) {
			await new Promise((done) => setTimeout(done, 50));
			const state = await manager.state(cwd);
			const errors = state.diagnostics.filter((d) => d.path === "consumer.ts");
			if (
				errors.some((d) => d.code === "2307" && d.freshness === "fresh") ===
					missing &&
				state.services.find((s) => s.language === "typescript")
					?.pendingFiles === 0
			)
				return;
		}
		throw new Error(
			"Module watcher failed: " + JSON.stringify(await manager.state(cwd)),
		);
	};
	await writeFile(join(cwd, "created.ts"), "export const value=1;");
	await awaitModule(false);
	await rm(join(cwd, "created.ts"));
	await awaitModule(true);
	await writeFile(
		join(cwd, "consumer.ts"),
		'import { value } from "fixture-installed"; export const result=value;',
	);
	await manager.query(cwd, { action: "diagnostics", path: "consumer.ts" });
	await mkdir(join(cwd, "node_modules/fixture-installed"), { recursive: true });
	await writeFile(
		join(cwd, "node_modules/fixture-installed/package.json"),
		JSON.stringify({ name: "fixture-installed", types: "index.d.ts" }),
	);
	await writeFile(
		join(cwd, "node_modules/fixture-installed/index.d.ts"),
		"export declare const value:number;",
	);
	await awaitModule(false);
	// No interpreter override in the trusted fixture; archive omits fsevents entirely.
	await rm(join(cwd, "pyrightconfig.json"));
	trusted = true;
	const python = await manager.query(cwd, {
		action: "diagnostics",
		path: "example.py",
	});
	assert(python.diagnostics.some((d) => d.code === "reportReturnType"));
	await writeFile(
		join(cwd, "example.py"),
		"def greet(name: str) -> int:\n    return len(name)\n",
	);
	let updated = false;
	for (let i = 0; i < 100; i++) {
		await new Promise((r) => setTimeout(r, 50));
		if (
			!(await manager.state(cwd)).diagnostics.some(
				(d) => d.path === "example.py" && d.severity === 1,
			)
		) {
			updated = true;
			break;
		}
	}
	assert(
		updated,
		"shared client watcher refreshes Python diagnostics without fsevents or another query",
	);
	const a = await subscribeProject(cwd, () => {}),
		b = await subscribeProject(cwd, () => {});
	const awaitRoot = await realpath(cwd);
	const watched = projectWatchStats().filter((s) => s.cwd === awaitRoot);
	assert.equal(watched.length, 1);
	assert(watched[0].handles <= (process.platform === "linux" ? 1024 : 1));
	b();
	a();
	console.log(
		"PASS real TS/Python symbols, diagnostics, disk updates, versions, trust markers and bundled compiler",
	);
} finally {
	await manager.shutdown();
	await rm(root, { recursive: true, force: true });
}
