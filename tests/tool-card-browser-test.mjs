/** Zero-token regression for generic tool-card layout (#45).
 * Run after npm run build. Uses an isolated server/data directory. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const port = 31000 + Math.floor(Math.random() * 10000);
const probe = createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
await new Promise((resolve) => probe.close(resolve));
const data = mkdtempSync(join(tmpdir(), "pi-tool-card-"));
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
	let socket, baseState;
	await page.routeWebSocket("**/ws", route => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage(message => upstream.send(message));
		upstream.onMessage(wire => {
			const message = JSON.parse(wire.toString());
			if (message.type === "snapshot") {
				message.state.piConfigured = true;
				message.state.messages = [{ id: "a", role: "assistant", timestamp: 1, content: [{ type: "text", text: "这个页面是目录节点，需要查看它的子页面。" }, { type: "toolCall", id: "tree", name: "intranet_wiki_tree", argumentsText: JSON.stringify({ domainId: 7706, kanbanId: 6393, sn: "WIKI2023042300368" }) }] }, { id: "r", role: "toolResult", toolCallId: "tree", toolName: "intranet_wiki_tree", content: [], isError: false, timestamp: 2, toolOutputUrl: "/api/tool-output?call=tree" }];
				baseState = message.state;
			}
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".inputbar textarea").waitFor();

	await page.route("**/api/tool-output-list?*", route => route.fulfill({ json: [{ id: "default", name: "tree.txt", default: true }] }));
	await page.route("**/api/tool-output?*", route => route.fulfill({ body: "Complete output", contentType: "text/plain", headers: { "content-disposition": 'attachment; filename="tree.txt"' } }));
	const card = page.locator('.toolcall-generic');
	await card.waitFor();
	assert.equal(await card.locator('dt').allTextContents().then(x => x.join(',')), 'domainId,kanbanId,sn');
	assert.equal(await card.locator('.toolcall-head').getByText('展开完整内容', { exact: true }).count(), 0);
	assert.equal(await card.locator('.toolcall-output').count(), 0, 'no empty output box');
	await card.getByRole('button', { name: '复制参数', exact: true }).click();
	await card.getByRole('button', { name: '已复制', exact: true }).waitFor();
	const downloaded = page.waitForEvent('download');
	await card.getByRole('button', { name: '下载完整输出', exact: true }).click();
	assert.equal((await downloaded).suggestedFilename(), 'tree.txt');
	await card.locator('.toolcall-name-toggle').click();
	assert.equal(await card.locator('.toolcall-body').count(), 0);
	await card.locator('.toolcall-name-toggle').press('Enter');
	await card.locator('.toolcall-body').waitFor();
	await card.getByRole('button', { name: '放大查看', exact: true }).click();
	await page.locator('.toolcall-zoom').waitFor();
	await page.keyboard.press('Escape');
	await card.locator('.toolcall-section-label').click();
	mkdirSync('tests/scratch', { recursive: true });
	await card.screenshot({ path: 'tests/scratch/tool-card-light.png' });
	await page.evaluate(() => document.documentElement.dataset.appearance = 'dark');
	await card.screenshot({ path: 'tests/scratch/tool-card-dark.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(300);
	await page.evaluate(() => document.documentElement.dataset.appearance = 'light');
	await card.screenshot({ path: 'tests/scratch/tool-card-mobile.png' });
	assert(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile card does not overflow');
	assert.deepEqual(errors, []);
	console.log('PASS generic tool parameters, accessible controls, download, collapse, zoom, dark and mobile layouts');
} finally {
	await browser?.close(); server.kill('SIGTERM');
	await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
	rmSync(data, { recursive: true, force: true });
}
