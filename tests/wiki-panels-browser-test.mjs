/** Wiki panel layout and Windows titlebar regression (#35).
 * Run after npm run build. Uses an isolated server/data directory. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const port = 31000 + Math.floor(Math.random() * 10000);
const probe = createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
await new Promise((resolve) => probe.close(resolve));
const data = mkdtempSync(join(tmpdir(), "pi-wiki-panels-"));
const agent = join(data, "agent");
mkdirSync(agent);
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "wiki-a" }));
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "unused", models: ["wiki-a", "wiki-b"].map(id => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 4096 })) } } }));
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_DATA_DIR: data, PI_WEB_CWD: data, PI_CODING_AGENT_DIR: join(data, "agent") }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser;
server.stdout.on("data", (chunk) => { logs += chunk; });
server.stderr.on("data", (chunk) => { logs += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
writeFileSync(join(data, "note.md"), "# Test document\n\nPanel resize fixture.\n");
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
	await page.addInitScript(() => { window.electronAPI = { platform: 'win32', windowAction() {}, onWindowState() { return () => {}; } }; });
	await page.routeWebSocket("**/ws", route => {
		const upstream = route.connectToServer();
		route.onMessage(message => upstream.send(message));
		upstream.onMessage(wire => {
			const message = JSON.parse(wire.toString());
			if (message.type === 'snapshot' || message.type === 'snapshot_delta') message.state.piConfigured = true;
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('[data-tree-node="note.md"]').click();
	await page.locator('.wiki-chat-panel').waitFor();
	await page.waitForFunction(() => document.querySelector('.wiki-model-controls')?.disabled === false);
	await page.locator('.wiki-model-controls > .dropdown > .chip').click();
	await page.locator('.wiki-model-controls .dd-item').filter({ hasText: 'wiki-b' }).click();
	await page.waitForFunction(() => document.querySelector('.wiki-model-controls .chip-model')?.textContent.includes('wiki-b'));
	await page.locator('.wiki-model-controls .thinking-control > .dropdown > .chip').click();
	await page.locator('.wiki-model-controls .thinking-mode-option').filter({ hasText: '深度' }).click();
	await page.waitForFunction(() => document.querySelector('.wiki-model-controls .thinking-control')?.textContent.includes('深度'));

	await page.locator('.wiki-chat-panel > header button').last().click();
	assert.equal(await page.locator('.wiki-chat-panel').count(), 0);
	await page.locator('.wiki-expand-composer').click();
	assert(await page.locator('.wiki-model-controls .chip-model').isVisible(), 'collapsed-panel composer also offers model selection');
	assert((await page.locator('.wiki-model-controls .chip-model').innerText()).includes('wiki-b'));
	await page.locator('.wiki-collapse-composer').click();
	const toggle = page.locator('.wiki-chat-toggle');
	const unobstructed = await toggle.evaluate(button => { const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
	assert(unobstructed, 'Windows window controls must not cover the chat reopen button');
	await toggle.click({ timeout: 3000 });
	await page.locator('.wiki-chat-panel').waitFor();
	for (const [side, panel, delta] of [['sidebar', '.wiki-sidebar', 70], ['chat', '.wiki-chat-panel', -80]]) {
		const before = (await page.locator(panel).boundingBox()).width;
		const handle = page.locator(`.wiki-resize-${side}`);
		const rect = await handle.boundingBox({ timeout: 3000 }); assert(rect, `${side} has a visible resize handle`);
		await page.mouse.move(rect.x + rect.width / 2, rect.y + 100); await page.mouse.down();
		await page.mouse.move(rect.x + rect.width / 2 + delta, rect.y + 100, {steps: 8}); await page.mouse.up();
		const after = (await page.locator(panel).boundingBox()).width;
		assert(after >= before + Math.abs(delta) - 2, `${side} width changes: ${before} -> ${after}`);
	}
	await page.reload();
	await page.locator('[data-tree-node="note.md"]').click();
	await page.locator('.wiki-chat-panel').waitFor();
	assert.equal(Math.round((await page.locator('.wiki-sidebar').boundingBox()).width), 320);
	assert.equal(Math.round((await page.locator('.wiki-chat-panel').boundingBox()).width), 480);
	await page.locator('.wiki-resize-sidebar').focus(); await page.keyboard.press('ArrowRight');
	assert.equal(Math.round((await page.locator('.wiki-sidebar').boundingBox()).width), 330);
	await page.keyboard.press('Home');
	await page.waitForFunction(() => Math.round(document.querySelector('.wiki-sidebar').getBoundingClientRect().width) === 250);
	assert.equal(Math.round((await page.locator('.wiki-sidebar').boundingBox()).width), 250);
	await page.locator('.wiki-resize-chat').dblclick();
	assert.equal(Math.round((await page.locator('.wiki-chat-panel').boundingBox()).width), 400);
	for (const width of [1000, 800, 600, 390]) {
		await page.setViewportSize({width, height: 900});
		await page.locator('.wiki-chat-panel > header button').last().click();
		assert(await toggle.evaluate(button => { const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), `reopen reachable at ${width}px`);
		await toggle.click({timeout: 2000}); await page.locator('.wiki-chat-panel').waitFor();
		assert(await page.locator('.wiki-chat-panel').evaluate(panel => panel.getBoundingClientRect().right <= innerWidth && panel.getBoundingClientRect().left >= 0));
	}
	mkdirSync('tests/scratch', {recursive:true});
	await page.screenshot({path:'tests/scratch/wiki-panels-win32-mobile.png'});
	assert.deepEqual(errors, []);
	console.log('PASS: Windows Wiki chat reopens and both panels resize');

} finally {
	await browser?.close();
	server.kill("SIGTERM");
	await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", resolve); });
	rmSync(data, { recursive: true, force: true });
}
