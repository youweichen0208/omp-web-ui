// Exercise the shipped server with the shipped Electron runtime, without using
// the checkout's node_modules. No model calls or user configuration are needed.
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const [executable, appRoot] = process.argv.slice(2).map((p) => resolve(p));
assert(executable && appRoot, "Usage: node tests/packaged-server-start-test.mjs <executable> <resources/app>");
if (process.platform === "win32") {
	const helper = readFileSync(join(appRoot, "node_modules/node-pty/lib/conpty_console_list_agent.js"), "utf8");
	assert.match(helper, /pi-web-ui: the console may already be gone during ConPTY teardown/);
	console.log("PASS packaged node-pty includes the ConPTY cleanup patch");
}
// Loading the lazy provider is essential: startup alone does not import it.
const provider = pathToFileURL(join(appRoot, "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js")).href;
execFileSync(executable, ["--input-type=module", "--eval", `await import(${JSON.stringify(provider)})`], {
	env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "", NODE_OPTIONS: "" },
	timeout: 30000,
	stdio: "pipe",
});
const temp = mkdtempSync(join(tmpdir(), "pi-packaged-start-"));
const workspace = join(temp, "workspace");
mkdirSync(workspace);
// Use the packaged runtime and worker, not the checkout's SQLite reader.
const databasePath = join(workspace, "graph.db");
const database = new DatabaseSync(databasePath);
database.exec("CREATE TABLE nodes(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO nodes VALUES(1, 'packaged-sqlite')");
database.close();
await new Promise((resolve, reject) => {
	let settled = false;
	let workerOutput = "";
	const worker = fork(join(appRoot, "dist/server/sqlite-worker.js"), [], {
		execPath: executable, execArgv: [],
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "", NODE_OPTIONS: "" },
		stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json",
	});
	const finish = (error) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		worker.kill();
		if (error) reject(new Error(`${error.message}\n${workerOutput}`)); else resolve();
	};
	const timer = setTimeout(() => finish(new Error("Packaged SQLite worker timed out")), 10000);
	worker.stderr.on("data", (chunk) => { workerOutput = (workerOutput + chunk).slice(-8000); });
	worker.once("error", finish);
	worker.once("exit", (code, signal) => finish(new Error(`Packaged SQLite worker exited: ${code ?? signal}`)));
	worker.once("message", (message) => {
		try {
			assert.equal(message.error, undefined);
			assert.equal(message.data.table, "nodes");
			assert.equal(message.data.rows[0][1].value, "packaged-sqlite");
			finish();
		} catch (error) { finish(error); }
	});
	worker.send({ absolute: databasePath, offset: 0 }, (error) => { if (error) finish(error); });
});
console.log("PASS packaged SQLite worker: table and row data");
const listener = createServer();
await new Promise((resolve, reject) => {
	listener.once("error", reject);
	listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
assert(port >= 8900);
let output = "";
let failure;
const child = fork(join(appRoot, "dist/server/index.js"), [], {
	execPath: executable,
	cwd: workspace,
	env: {
		...process.env,
		NODE_PATH: "",
		NODE_OPTIONS: "",
		ELECTRON_RUN_AS_NODE: "1",
		PORT: String(port),
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_CWD: workspace,
		PI_WEB_DATA_DIR: join(temp, "data"),
		PI_CODING_AGENT_DIR: join(temp, "agent"),
		PI_WEB_PKG_ROOT: appRoot,
		PI_WEB_NO_BROWSER: "1",
	},
	stdio: ["ignore", "pipe", "pipe", "ipc"],
	serialization: "json",
});
child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-20000); });
child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-20000); });
child.on("error", (error) => { failure = error; });
child.on("exit", (code, signal) => { failure = new Error(`Packaged server exited: ${code ?? signal}`); });
try {
	let healthy = false;
	for (let n = 0; n < 150; n++) {
		if (failure) throw failure;
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
			const health = await response.json();
			assert.equal(health.ok, true);
			assert.equal(health.pid, child.pid);
			healthy = true;
			break;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	assert(healthy, "Packaged server health check timed out");
	const page = await fetch(`http://127.0.0.1:${port}/`);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /<div id="root">/);
	console.log(`PASS packaged server: ${appRoot}`);
} catch (error) {
	console.error(output);
	throw error;
} finally {
	if (child.pid && child.exitCode === null && child.signalCode === null) {
		const exited = once(child, "exit");
		child.kill();
		await exited;
	}
	rmSync(temp, { recursive: true, force: true });
}
