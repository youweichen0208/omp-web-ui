import { it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../../server/code-toolchain.js", () => ({
	prepareToolchain: async () => fixture.root,
	leaseToolchain: async () => () => {},
	cleanupUnusedToolchains: async () => {},
}));
import { CodeIntelligenceManager } from "../../server/code-intelligence.js";
it("waits through mixed unversioned publications before the first fresh repair result", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-diagnostic-window-"));
	fixture.root = join(root, "toolchain");
	const cli = join(
		fixture.root,
		"node_modules/typescript-language-server/lib/cli.mjs",
	);
	await mkdir(join(cli, ".."), { recursive: true });
	const rpc = pathToFileURL(
		createRequire(import.meta.url).resolve("vscode-jsonrpc/node"),
	).href;
	await writeFile(
		cli,
		`
import {createMessageConnection,StreamMessageReader,StreamMessageWriter} from ${JSON.stringify(rpc)};
const connection=createMessageConnection(new StreamMessageReader(process.stdin),new StreamMessageWriter(process.stdout));
const oldError={range:{start:{line:0,character:0},end:{line:0,character:1}},message:"old semantic error",code:2322,severity:1};
connection.onRequest("initialize",()=>({capabilities:{textDocumentSync:1}}));
connection.onNotification("textDocument/didOpen",({textDocument:d})=>connection.sendNotification("textDocument/publishDiagnostics",{uri:d.uri,diagnostics:[oldError]}));
connection.onNotification("textDocument/didChange",({textDocument:d})=>{
 connection.sendNotification("textDocument/publishDiagnostics",{uri:d.uri,diagnostics:[oldError]});
 setTimeout(()=>connection.sendNotification("textDocument/publishDiagnostics",{uri:d.uri,diagnostics:[]}),200);
});
connection.listen();
`,
	);
	const cwd = join(root, "project");
	await mkdir(cwd);
	const file = join(cwd, "example.ts");
	await writeFile(file, 'const value:number="wrong";');
	const manager = new CodeIntelligenceManager(join(root, "data"), () => true);
	try {
		const before = (await manager.query(cwd, {
			action: "diagnostics",
			path: "example.ts",
		})) as any;
		expect(before.freshness).toBe("fresh");
		expect(before.diagnostics).toHaveLength(1);
		await writeFile(file, "const value:number=1;");
		const after = (await manager.query(cwd, {
			action: "diagnostics",
			path: "example.ts",
		})) as any;
		expect(after.freshness).toBe("fresh");
		expect(after.diagnostics).toEqual([]);
		expect(await manager.baseline(cwd, "example.ts")).toEqual([]);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
}, 10000);
it("pulls Rust diagnostics, ignores empty pushes and retries cancelled indexing responses", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-rust-diagnostics-"));
	const cwd = join(root, "project"),
		cli = join(root, "fixture.mjs");
	await mkdir(cwd);
	const file = join(cwd, "lib.rs");
	await writeFile(file, 'fn broken() -> i32 { "wrong" }');
	const rpc = pathToFileURL(
		createRequire(import.meta.url).resolve("vscode-jsonrpc/node"),
	).href;
	await writeFile(
		cli,
		`
import {createMessageConnection,StreamMessageReader,StreamMessageWriter,ResponseError} from ${JSON.stringify(rpc)};
const connection=createMessageConnection(new StreamMessageReader(process.stdin),new StreamMessageWriter(process.stdout));
let text="", uri="", first=true, indexing=true;
const error={range:{start:{line:0,character:0},end:{line:0,character:1}},message:"type mismatch",code:"E0308",severity:1};
connection.onRequest("initialize",()=>({capabilities:{diagnosticProvider:{interFileDependencies:true,workspaceDiagnostics:false}}}));
connection.onNotification("textDocument/didOpen",({textDocument:d})=>{text=d.text;uri=d.uri;connection.sendNotification("textDocument/publishDiagnostics",{uri,diagnostics:[]});});
connection.onNotification("textDocument/didChange",({contentChanges})=>{text=contentChanges[0].text;connection.sendNotification("textDocument/publishDiagnostics",{uri,diagnostics:[error]});});
connection.onRequest("textDocument/diagnostic",()=>{if(first){first=false;throw new ResponseError(-32802,"indexing",{retriggerRequest:true});}if(indexing){indexing=false;return {kind:"full",items:[]};}return {kind:"full",items:text.includes("wrong")?[error]:[]};});
connection.listen();
`,
	);
	const manager = new CodeIntelligenceManager(join(root, "data"), () => true);
	vi.spyOn((manager as any).nativeTools, "launch").mockResolvedValue({
		command: process.execPath,
		args: [cli],
	});
	try {
		let before = (await manager.query(cwd, {
			action: "diagnostics",
			path: "lib.rs",
		})) as any;
		expect(before.freshness).toBe("pending");
		before = (await manager.query(cwd, {
			action: "diagnostics",
			path: "lib.rs",
		})) as any;
		expect(before.freshness).toBe("fresh");
		expect(before.diagnostics).toEqual([]);
		before = (await manager.query(cwd, {
			action: "diagnostics",
			path: "lib.rs",
		})) as any;
		expect(before.freshness).toBe("fresh");
		expect(before.diagnostics).toHaveLength(1);
		await writeFile(file, "fn broken() -> i32 { 1 }");
		const after = (await manager.query(cwd, {
			action: "diagnostics",
			path: "lib.rs",
		})) as any;
		expect(after.freshness).toBe("fresh");
		expect(after.diagnostics).toEqual([]);
		expect(await manager.baseline(cwd, "lib.rs")).toEqual([]);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
}, 10000);
