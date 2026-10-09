/** Zero-token regression for workspace and Wiki file creation (#34/#43).
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
const data = mkdtempSync(join(tmpdir(), "pi-create-file-"));
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_DATA_DIR: data, PI_WEB_CWD: data, PI_CODING_AGENT_DIR: join(data, "agent") }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser;
server.stdout.on("data", (chunk) => { logs += chunk; });
server.stderr.on("data", (chunk) => { logs += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(join(data, "docs"));
mkdirSync(join(data, "vanishing"));
writeFileSync(join(data, "existing.txt"), "keep me");
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
		let vanishOnce = true;
	await page.routeWebSocket("**/ws", route => {
		const upstream = route.connectToServer();
		route.onMessage(message => {
			const request = JSON.parse(message.toString());
			if (vanishOnce && request.type === 'list_files' && request.path === 'vanishing') {
				vanishOnce = false; rmSync(join(data, 'vanishing'), { recursive: true });
			}
			upstream.send(message);
		});
		upstream.onMessage(wire => {
			const message = JSON.parse(wire.toString());
			if (message.type === "snapshot" || message.type === "snapshot_delta") message.state.piConfigured = true;
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".inputbar textarea").waitFor();
	await page.locator('[data-tree-node="vanishing"]').click();
	await page.locator('.tree-directory-error').waitFor();
	assert.match(await page.locator('.tree-directory-error').textContent(), /目录已移动或删除/);
	assert.equal(await page.locator('.notice').count(), 0);
	mkdirSync(join(data, 'vanishing')); writeFileSync(join(data, 'vanishing/restored.txt'), 'restored');
	await page.locator('.tree-directory-error').getByRole('button', { name: '刷新文件' }).click();
	await page.locator('[data-tree-node="vanishing/restored.txt"]').waitFor();
	assert.equal(await page.locator('.tree-directory-error').count(), 0);
	writeFileSync(join(data, 'refreshed.txt'), 'external addition');
	await page.locator('.panel-right').getByRole('button', { name: '刷新文件', exact: true }).click();
	await page.locator('[data-tree-node="refreshed.txt"]').waitFor();
	await page.locator('.panel-right').getByRole('button', { name: '新建文件', exact: true }).click();
	const form = page.locator('.create-file-form');
	await form.locator('input').fill('existing.txt');
	await form.getByRole('button', { name: '创建', exact: true }).click();
	await form.getByRole('alert').waitFor();
	assert.equal(readFileSync(join(data, 'existing.txt'), 'utf8'), 'keep me');
	assert.equal(await form.locator('input').inputValue(), 'existing.txt');
	await form.locator('input').fill('docs/created.md');
	await form.getByRole('button', { name: '创建', exact: true }).click();
	await page.locator('.wiki-workbench .fp-rich-document[contenteditable="true"]').waitFor();
	assert.equal(readFileSync(join(data, 'docs/created.md'), 'utf8'), '');
	await page.locator('.wiki-sidebar').getByRole('button', { name: '新建文件', exact: true }).click();
	await form.waitFor();
	assert.equal(await form.locator('input').inputValue(), 'docs/');
	await form.locator('input').fill('docs/second.md');
	await form.getByRole('button', { name: '创建', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.wiki-toolbar')?.textContent?.includes('second.md') || document.querySelector('.wiki-breadcrumb')?.textContent?.includes('second.md'));
	assert.equal(readFileSync(join(data, 'docs/second.md'), 'utf8'), '');
	await page.locator('.wiki-workbench .fp-rich-document[contenteditable="true"]').waitFor();
	await page.locator('.wiki-workbench .fp-rich-document').fill('Created and edited');
	for (let i = 0; i < 100 && !readFileSync(join(data, 'docs/second.md'), 'utf8').includes('Created and edited'); i++) await sleep(50);
	assert.match(readFileSync(join(data, 'docs/second.md'), 'utf8'), /Created and edited/);
	assert.deepEqual(errors, []);
	console.log('PASS: workspace and Wiki create/open files, preserve existing content and suggest parent directory');

} finally {
	await browser?.close();
	server.kill("SIGTERM");
	await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", resolve); });
	rmSync(data, { recursive: true, force: true });
}
