/** Real persistent history + production browser: summary virtualization,
 * scrolling, expansion, search and message navigation without model calls. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const count = Number(process.env.PI_HISTORY_MESSAGES ?? 4096);
const root = mkdtempSync(join(tmpdir(), "pi-history-ui-"));
const agentDir = join(root, "agent"), cwd = join(root, "work");
mkdirSync(agentDir); mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: [], retry: { enabled: false } }));
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const manager = SessionManager.create(cwd);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
for (let i = 0; i < count; i++) manager.appendMessage(i % 2
	? { role: "assistant", content: [{ type: "text", text: `answer-${i}` }], timestamp: i + 1, api: "openai-completions", provider: "fixture", model: "fixture", usage, stopReason: "stop" }
	: { role: "user", content: [{ type: "text", text: `question-${i}-unique` }], timestamp: i + 1 });
const listener = createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); assert(port >= 8900);
const child = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_DATA_DIR: join(root, "data"), PI_WEB_CWD: cwd }, stdio: ["ignore", "pipe", "pipe"] });
let output = "", browser, ws;
child.stdout.on("data", c => { output = (output + c).slice(-8000); }); child.stderr.on("data", c => { output = (output + c).slice(-8000); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const received = [];
async function waitFor(predicate) {
	for (let i = 0; i < 300; i++) { const message = received.find(predicate); if (message) return message; await sleep(100); }
	throw new Error(`snapshot timed out: ${output}`);
}
try {
	let ready = false;
	for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch {} await sleep(100); }
	assert(ready, output);
	ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); ws.on("message", raw => received.push(JSON.parse(raw)));
	await once(ws, "open"); ws.send(JSON.stringify({ type: "hello", clientId: "long-history-ui", protocolVersion: 41 }));
	await waitFor(m => m.type === "snapshot"); received.length = 0;
	ws.send(JSON.stringify({ type: "switch_session", path: manager.getSessionFile() }));
	await sleep(500);
	ws.send(JSON.stringify({ type: "get_state" }));
	const { state } = await waitFor(m => m.type === "snapshot" && m.state.messages.length === count);
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	const errors = []; page.on("pageerror", error => errors.push(String(error)));
	await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "long-history-ui"));
	await page.goto(`http://127.0.0.1:${port}/`);
	await page.waitForFunction(count => document.querySelectorAll(".messages [data-msg-id]").length === count, count);
	if (await page.locator(".setup-modal .modal-close").count()) await page.locator(".setup-modal .modal-close").click();
	await page.waitForFunction(count => document.querySelectorAll(".msg-lazy-ph").length > count - 200, count);
	assert(await page.locator(".msg-collapsed").count() < 200, "summary DOM is limited to the viewport buffer");
	await page.locator(".messages").evaluate(el => { el.scrollTop = 0; });
	await page.waitForFunction(id => document.querySelector(`[data-msg-id="${id}"]`)?.classList.contains("msg-collapsed"), state.messages[0].id);
	await page.locator(`[data-msg-id="${state.messages[0].id}"]`).click();
	await page.locator(`.msg[data-msg-id="${state.messages[0].id}"]`).waitFor();
	const target = state.messages[Math.floor(count / 2 / 2) * 2];
	await page.evaluate(id => window.dispatchEvent(new CustomEvent("pi:jump-message", { detail: { messageId: id } })), target.id);
	await page.locator(`.msg[data-msg-id="${target.id}"]`).waitFor();
	await page.waitForFunction(id => { const r = document.querySelector(`.msg[data-msg-id="${id}"]`)?.getBoundingClientRect(); return r && r.top >= 0 && r.top < innerHeight; }, target.id);
	await page.keyboard.press("ControlOrMeta+f");
	await page.locator(".search-input").fill("question-2-unique");
	await page.waitForFunction(() => document.querySelector(".search-count")?.textContent?.replace(/\s/g, "").includes("1/1"));
	await page.locator(`.msg[data-msg-id="${state.messages[2].id}"]`).waitFor();
	await page.keyboard.press("Escape");
	await page.locator(".messages").evaluate(el => { el.scrollTop = el.scrollHeight; });
	await page.waitForFunction(count => document.querySelectorAll(".msg-lazy-ph").length > count - 200, count);
	assert.deepEqual(errors, []);
	console.log(`PASS ${count} history rows: bounded summaries, scroll, expand, message jump and search`);
} finally {
	await browser?.close(); ws?.terminate(); child.kill("SIGTERM");
	await Promise.race([once(child, "exit"), sleep(5000)]); if (child.exitCode === null) child.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
}
