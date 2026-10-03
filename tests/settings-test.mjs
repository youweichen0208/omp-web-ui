// Native resource views and display-only preferences; zero model calls.
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.argv[2] || 8931);
const DATA_DIR = mkdtempSync(join(tmpdir(), "pi-web-set-test-"));
console.log("data-dir:", DATA_DIR);
const extensionRoot = join(DATA_DIR, "agent", "extensions");
mkdirSync(join(extensionRoot, "sample-directory"), { recursive: true });
writeFileSync(join(extensionRoot, "sample-directory", "index.ts"), "export default function () {}\n");
writeFileSync(join(extensionRoot, "custom-footer.ts"), "export default function () {}\n");

const server = spawn(process.execPath, ["dist/server/index.js"], {
	env: {
		...process.env,
		PORT: String(PORT),
		PI_WEB_DATA_DIR: DATA_DIR,
		PI_WEB_CWD: process.cwd(),
		PI_CODING_AGENT_DIR: join(DATA_DIR, "agent"),
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv-err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		ws.on("message", (d) => this.received.push(JSON.parse(d.toString())));
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	/** Wait for a message; optional predicate. `type` may be an array of
	 *  acceptable types (snapshot OR snapshot_delta — incremental snapshots
	 *  mean post-action checkpoints often arrive as deltas). A set_settings
	 *  pushes settings_state twice (immediately + after the reload), so stale
	 *  duplicates are consumed while scanning. */
	async waitFor(type, timeout = 8000, pred) {
		const start = Date.now();
		const types = Array.isArray(type) ? type : [type];
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (!types.includes(m.type)) continue;
				this.received.splice(i, 1);
				if (!pred || pred(m)) return m;
				i--;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
}

async function connect() {
	for (let i = 0; i < 60; i++) {
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((res, rej) => {
				ws.on("open", res);
				ws.on("error", rej);
			});
			return new Client(ws);
		} catch {
			await sleep(500);
		}
	}
	throw new Error("server not ready");
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name} ${extra}`);
	}
}

let c;
try {
	c = await connect();
	c.send({ type: "hello", clientId: "settings-test-client" });
	await c.waitFor("ready");
	await c.waitFor(["snapshot", "snapshot_delta"]);
	const st0 = await c.waitFor("settings_state");
	check("settings_state pushed on attach", !!st0.settings);
	check("has skills array", Array.isArray(st0.settings.skills));
	check("has extensions array", Array.isArray(st0.settings.extensions));
	check("no bundled todo", !st0.settings.extensions.some(e => e.builtin === "todo"));
	check("native directory extension loaded", st0.settings.extensions.some(e => e.name === "sample-directory"));
	check("native standalone extension loaded", st0.settings.extensions.some(e => e.name === "custom-footer"));
	check("native prompt available", typeof st0.settings.effectiveSystemPrompt === "string" && st0.settings.effectiveSystemPrompt.length > 0);
	for (const field of ["promptMode", "customSystemPrompt", "terminalToolsEnabled", "visionBridgeEnabled", "presets"]) check(`${field} removed`, !(field in st0.settings));
	const originalPrompt = st0.settings.effectiveSystemPrompt;
	c.send({ type: "set_settings", thinkingWrap: true, toolsWrap: false, promptMode: "replace", customSystemPrompt: "HOST_OVERRIDE_SENTINEL" });
	const st1 = await c.waitFor("settings_state", 8000, m => m.settings.thinkingWrap === true);
	check("display preferences round-trip", st1.settings.toolsWrap === false);
	check("legacy prompt override ignored", st1.settings.effectiveSystemPrompt === originalPrompt);
	c.ws.close();
	await sleep(300);
	c = await connect();
	c.send({ type: "hello", clientId: "settings-test-client" });
	await c.waitFor("ready");
	await c.waitFor(["snapshot", "snapshot_delta"]);
	const st9 = await c.waitFor("settings_state");
	check("display preferences survive reconnect", st9.settings.thinkingWrap === true && st9.settings.toolsWrap === false);
	check("native prompt survives reconnect", st9.settings.effectiveSystemPrompt === originalPrompt);

	// extensions_reload：外部变更（如终端里 pi remove 完成）后重发现扩展
	c.send({ type: "extensions_reload" });
	await c.waitFor("settings_state", 15000);
	check("extensions_reload re-pushes settings", true);
	c.ws.close();

	console.log(`\n${pass} passed, ${fail} failed`);
} catch (err) {
	console.error("TEST ERROR:", err.message);
	fail++;
} finally {
	server.kill("SIGTERM");
	await sleep(300);
}
process.exit(fail > 0 ? 1 : 0);
