import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const base = mkdtempSync(join(tmpdir(), "pi-switch-"));
const agent = join(base, "agent");
process.env.PI_CODING_AGENT_DIR = agent;
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const projects = ["short-a", "short-b", "long-c"].map((name) => join(base, name));
for (const [i, project] of projects.entries()) {
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, `project-${i}.txt`), `project ${i}`);
	const session = SessionManager.create(project);
	for (let n = 0; n < (i === 2 ? 250 : 2); n++) {
		session.appendMessage({ role: "user", content: [{ type: "text", text: `fixture-${i}-${n}` }], timestamp: Date.now() });
		session.appendMessage({ role: "assistant", content: [{ type: "text", text: `reply-${i}-${n} ` + "example text ".repeat(40) }], api: "openai-completions", provider: "test", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	}
}
assert.equal(spawnSync("git", ["init", "-q", projects[2]]).status, 0);
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
assert(port >= 8900);
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: projects[0], PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; server.stderr.on("data", (d) => { logs += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, browser;
try {
	for (let n = 0; n < 100; n++) {
		try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
		if (n === 99) throw new Error(logs);
		await sleep(100);
	}
	ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const messages = [];
	ws.on("message", (raw) => messages.push(JSON.parse(raw)));
	await new Promise((r) => ws.once("open", r));
	const send = (msg) => ws.send(JSON.stringify(msg));
	const wait = async (test) => {
		for (let n = 0; n < 300; n++) { const m = messages.find(test); if (m) return m; await sleep(20); }
		throw new Error("message timeout: " + messages.slice(-3).map((m) => m.type));
	};
	send({ type: "hello", clientId: "switch-protocol" });
	await wait((m) => m.type === "snapshot");
	for (let n = 0; n < 12; n++) send({ type: "set_cwd", path: projects[n % 3], requestId: `rapid-${n}` });
	const last = await wait((m) => m.type === "cwd_result" && m.requestId === "rapid-11");
	assert.equal(last.ok, true); assert.equal(last.cwd, projects[2]);
	await wait((m) => m.type === "snapshot" && m.state.cwd === projects[2]);
	send({ type: "set_cwd", path: join(base, "missing"), requestId: "failure" });
	const failed = await wait((m) => m.type === "cwd_result" && m.requestId === "failure");
	assert.equal(failed.ok, false); assert.equal(failed.cwd, projects[2]);
	send({ type: "list_files" });
	assert.equal((await wait((m) => m.type === "files")).cwd, projects[2]);
	console.log("PASS protocol: rapid switches, final target, failure rollback, scoped listing");
	if (!CHROME_PATH) throw new Error("Chrome unavailable");
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage();
	const outgoing = [];
	let browserSocket;
	await page.routeWebSocket("**/ws", (route) => {
		browserSocket = route;
		const backend = route.connectToServer();
		route.onMessage((raw) => { outgoing.push(JSON.parse(String(raw))); backend.send(raw); });
		backend.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			// Keep acknowledgements slow enough to exercise the display-only state.
			if (["snapshot", "snapshot_delta", "cwd_result"].includes(msg.type)) setTimeout(() => route.send(raw), 150);
			else route.send(raw);
		});
	});
	await page.goto(`http://127.0.0.1:${port}`);
	// Dismiss first-run model setup without configuring or invoking a model.
	await page.waitForSelector("textarea");
	await page.keyboard.press("Escape");
	await page.locator(".setup-modal .modal-close").waitFor();
	await page.locator(".setup-modal .modal-close").click();
	await page.waitForSelector(`.project-item[title="${projects[1]}"]`);
	const select = async (i) => {
		const elapsed = await page.evaluate(async ({ project, marker }) => {
			const start = performance.now();
			document.querySelector(`.project-item[title="${project}"]`).click();
			await new Promise((resolve, reject) => {
				const check = () => {
					const main = document.querySelector("main");
					if (main?.textContent.includes(marker)) requestAnimationFrame(() => resolve());
					else if (performance.now() - start > 10000) reject(new Error("content timeout"));
					else requestAnimationFrame(check);
				}; check();
			});
			return performance.now() - start;
		}, { project: projects[i], marker: `fixture-${i}-` });
		await page.waitForFunction(() => !document.querySelector('.protocol-banner[role="status"]'));
		return elapsed;
	};
	console.log(`First visit content: ${(await select(1)).toFixed(1)}ms`); await select(0);
	const input = page.locator("textarea").first();
	await input.fill("draft-a"); await select(1); await input.fill("draft-b"); await select(0);
	assert.equal(await input.inputValue(), "draft-a");
	const times = [];
	for (let n = 0; n < 20; n++) times.push(await select(n % 2 === 0 ? 1 : 0));
	times.sort((a, b) => a - b);
	console.log(`Cached project content first-frame P95 (${times.length} samples): ${times[Math.ceil(times.length * .95) - 1].toFixed(1)}ms`);
	await select(2); await select(0); const long = await select(2);
	console.log(`Long conversation cached first-frame: ${long.toFixed(1)}ms`);
	await page.locator(".messages").evaluate((el) => { el.scrollTop = 200; el.dispatchEvent(new Event("scroll")); });
	await page.waitForTimeout(100);
	const scrollBefore = await page.locator(".messages").evaluate((el) => el.scrollTop);
	await select(0); await select(2);
	const scrollAfter = await page.locator(".messages").evaluate((el) => el.scrollTop);
	assert(Math.abs(scrollBefore - scrollAfter) < 5, `scroll restored: ${scrollBefore} -> ${scrollAfter}`);
	// Repeated view switches must preserve the terminal instance and render content.
	await page.getByRole("tab").nth(1).click();
	await page.waitForSelector(".xterm-screen");
	await page.getByRole("tab").nth(2).click();
	await page.waitForSelector(".scm-view");
	const viewTimes = [];
	for (let n = 0; n < 20; n++) {
		viewTimes.push(await page.evaluate(async (index) => {
			const start = performance.now();
			document.querySelectorAll('[role="tab"]')[index].click();
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			const content = document.querySelector(index === 1 ? ".xterm-screen" : ".scm-view");
			if (!content?.getBoundingClientRect().height) throw new Error("view content is hidden");
			return performance.now() - start;
		}, n % 2 ? 2 : 1));
	}
	viewTimes.sort((a, b) => a - b);
	assert.equal(outgoing.filter((m) => m.type === "terminal_create").length, 1);
	assert.equal(outgoing.filter((m) => m.type === "prompt").length, 0);
	console.log(`Visited view content P95: ${viewTimes[18].toFixed(1)}ms; one terminal created`);
	await page.getByRole("tab").nth(0).click();
	await input.fill("reconnect draft");
	browserSocket.close();
	await page.waitForTimeout(1800);
	await page.waitForFunction(() => !document.querySelector("textarea").disabled);
	assert.equal(await input.inputValue(), "reconnect draft");
	assert(outgoing.filter((m) => m.type === "hello").length >= 2);
	console.log("PASS browser: delayed synchronization, actual content, drafts, scroll restoration, retained views, reconnect");
} finally {
	ws?.close();
	await browser?.close();
	server.kill("SIGTERM");
	await new Promise((r) => { if (server.exitCode !== null) r(); else server.once("exit", r); });
}
