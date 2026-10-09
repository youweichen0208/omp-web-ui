/** Zero-token regression for duplicate notices (#44) and file drop overlays (#38).
 * Run after npm run build. Uses an isolated server/data directory. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const port = 31000 + Math.floor(Math.random() * 10000);
const probe = createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
await new Promise((resolve) => probe.close(resolve));
const data = mkdtempSync(join(tmpdir(), "pi-notice-drop-"));
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_DATA_DIR: data, PI_WEB_CWD: data, PI_CODING_AGENT_DIR: join(data, "agent") }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser;
server.stdout.on("data", (chunk) => { logs += chunk; });
server.stderr.on("data", (chunk) => { logs += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Replays incoming notices and native file drag events against the real UI.
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null) throw new Error(logs);
		try {
			const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
			assert.equal(health.pid, server.pid); ready = true; break;
		} catch { await sleep(100); }
	}
	assert(ready, logs);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	const errors = [];
	page.on("pageerror", error => errors.push(String(error)));
	let socket;
	await page.routeWebSocket("**/ws", route => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage(message => upstream.send(message));
		upstream.onMessage(wire => {
			const message = JSON.parse(wire.toString());
			if (message.type === "snapshot" || message.type === "snapshot_delta") message.state.piConfigured = true;
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".inputbar textarea").waitFor();
	for (let i = 0; i < 4; i++) socket.send(JSON.stringify({ type: "notice", level: "error", text: "目录不可读：ENOENT: repeated-directory" }));
	await page.waitForFunction(() => document.querySelector(".notice-count")?.textContent === "×4");
	assert.equal(await page.locator(".notice").count(), 1);
	await page.locator(".notice-close").click();
	assert.equal(await page.locator(".notice").count(), 0);
	console.log("PASS: identical notices collapse and dismiss together");
	const migration = String.raw`pi-mcp-adapter no longer reads C:\Users\user\.pi\agent\mcp.json. Move it with: mv "source" "target"`;
	socket.send(JSON.stringify({ type: "notice", level: "warning", text: migration }));
	await page.getByText("旧 MCP 扩展需要选择配置方式", { exact: true }).waitFor();
	assert((await page.locator(".notice-text").innerText()).includes("保留 mcp.json"));
	await page.locator(".notice summary").click();
	assert((await page.locator(".notice-text").innerText()).includes(migration));
	await page.locator(".notice").getByRole("button", { name: "Extensions", exact: true }).click();
	await page.locator('.settings-tab.active').filter({ hasText: 'Extensions' }).waitFor();
	await page.locator('.settings-modal .modal-head button').click();
	await page.locator('.notice-close').click();
	console.log("PASS: adapter migration offers native-safe guidance and opens Extensions without running a shell command");
	const transfer = await page.evaluateHandle(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(["hello"], "drop-regression.txt", { type: "text/plain" }));
		return transfer;
	});
	await page.locator(".app").dispatchEvent("dragover", { dataTransfer: transfer });
	await page.locator(".app-drop-overlay").waitFor();
	await page.locator(".inputbar").dispatchEvent("dragover", { dataTransfer: transfer });
	await page.locator(".inputbar").dispatchEvent("drop", { dataTransfer: transfer });
	await page.locator(".attach-chip.file").waitFor();
	assert.equal(await page.locator(".app-drop-overlay").count(), 0, "window drop overlay must disappear after child handles upload");
	assert.equal(await page.locator(".drop-overlay").count(), 0);
	for (const event of ["dragend", "blur", "Escape"]) {
		await page.locator(".app").dispatchEvent("dragover", { dataTransfer: transfer });
		await page.locator(".app-drop-overlay").waitFor();
		if (event === "Escape") await page.keyboard.press("Escape");
		else await page.evaluate(type => window.dispatchEvent(new Event(type)), event);
		await page.locator(".app-drop-overlay").waitFor({ state: "detached" });
	}
	assert.deepEqual(errors, []);
	console.log("PASS: child upload clears all drag overlays");
} finally {
	await browser?.close();
	server.kill("SIGTERM");
	await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", resolve); });
	rmSync(data, { recursive: true, force: true });
}
