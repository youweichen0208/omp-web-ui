/** Isolated WS + browser regression; registry responses are local fixtures. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
const port = Number(process.argv.slice(2).find(arg => /^\d+$/.test(arg)) || 9149);
const root = mkdtempSync(join(tmpdir(), 'pi-component-updates-'));
const agent = join(root, 'agent');
const registryMock = join(root, 'registry-mock.mjs');
writeFileSync(registryMock, `const original=globalThis.fetch; globalThis.fetch=(url,options)=>String(url).startsWith('https://registry.npmjs.org/') ? Promise.resolve(new Response(JSON.stringify(String(url).endsWith('/latest')?{version:'999.0.0'}:{'dist-tags':{latest:'999.0.0'}}),{status:String(url).includes('broken')?503:200,headers:{'content-type':'application/json'}})) : original(url,options);`);
for (const name of ['sample', 'pinned', 'broken']) {
	const directory = join(agent, 'npm', 'node_modules', name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', pi: { extensions: ['index.ts'] } }));
	writeFileSync(join(directory, 'index.ts'), 'export default function () {}');
}
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: ['npm:sample', 'npm:pinned@1.0.0', 'npm:broken'] }));
const server = spawn(process.execPath, ['--import', pathToFileURL(registryMock).href, 'dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_DATA_DIR: join(root, 'data'), PI_WEB_CWD: root, PI_CODING_AGENT_DIR: agent }, stdio: 'ignore' });
let browser, ws;
const messages = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate) {
	for (let i = 0; i < 200; i++) { const found = messages.find(predicate); if (found) return found; await sleep(50); }
	throw Error('Timed out waiting for update response');
}
try {
	for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {} await sleep(100); }
	ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	ws.on('message', wire => messages.push(JSON.parse(wire.toString())));
	await new Promise(resolve => ws.once('open', resolve));
	ws.send(JSON.stringify({ type: 'hello', clientId: 'component-test' }));
	await wait(m => m.type === 'ready');
	ws.send(JSON.stringify({ type: 'check_component_updates', requestId: 'check-1' }));
	const report = await wait(m => m.type === 'component_updates' && m.requestId === 'check-1' && m.phase === 'ready');
	assert.equal(report.items.find(item => item.id === 'builtin:agent').canUpdate, false);
	assert.equal(report.items.some(item => item.id === 'builtin:todo'), false);
	assert.equal(report.items.find(item => item.name === 'sample').canUpdate, true);
	assert.equal(report.items.find(item => item.name === 'pinned').status, 'pinned');
	assert.equal(report.items.find(item => item.name === 'broken').status, 'error');
	ws.send(JSON.stringify({ type: 'update_component', requestId: 'reject-builtin', id: 'builtin:agent' }));
	await wait(m => m.type === 'component_updates' && m.requestId === 'reject-builtin' && m.phase === 'error');
	ws.send(JSON.stringify({ type: 'update_component', requestId: 'reject-arbitrary', id: 'npm:injected' }));
	await wait(m => m.type === 'component_updates' && m.requestId === 'reject-arbitrary' && m.phase === 'error');
	if (process.argv.includes('--browser')) {
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
		const page = await browser.newPage();
		await page.routeWebSocket('**/ws', route => {
			const upstream = route.connectToServer();
			route.onMessage(wire => {
				const message = JSON.parse(wire.toString());
				if (message.type === 'update_component') {
					route.send(JSON.stringify({ type: 'component_updates', requestId: message.requestId, cwd: root, phase: 'updating', items: [] }));
					setTimeout(() => route.send(JSON.stringify({ type: 'component_updates', requestId: message.requestId, cwd: root, phase: 'updated', restartRequired: true, items: report.items.map(item => item.id === message.id ? { ...item, current: item.latest, status: 'current', canUpdate: false } : item) })), 100);
					return;
				}
				upstream.send(wire);
			});
			upstream.onMessage(wire => { const message = JSON.parse(wire.toString()); if (message.type === 'snapshot' || message.type === 'snapshot_delta') message.state.piConfigured = true; route.send(JSON.stringify(message)); });
		});
		await page.goto(`http://127.0.0.1:${port}`);
		// Close first-run model setup when present; no real model is required.
		await page.locator('.topbar-more .chip').waitFor();
		await page.keyboard.press('Escape');
		await page.locator('.topbar-more .chip').click();
		await page.locator('.dd-menu').getByRole('button', { name: '所有设置', exact: true }).click();
		assert.equal(await page.getByRole('button', { name: /目标审查|视觉桥|预设/ }).count(), 0);
		await page.getByRole('button', { name: '系统提示词', exact: true }).click();
		await page.locator('.set-prompt-preview').waitFor();
		assert.equal(await page.locator('.settings-modal textarea').count(), 0, 'native prompt must be read-only');
		assert((await page.locator('.set-prompt-preview').textContent()).length > 0);
		await page.getByRole('button', { name: '消息显示', exact: true }).click();
		const thinking = page.locator('.settings-modal label', { hasText: '完整显示思考' }).locator('input');
		await thinking.click();
		await page.waitForFunction(() => [...document.querySelectorAll(".settings-modal label")].find(label => label.textContent.includes("完整显示思考"))?.querySelector("input")?.checked);
		assert(await thinking.isChecked(), 'display preference should persist');
		await page.getByRole('button', { name: '组件更新', exact: true }).click();
		await page.locator('.component-update-row', { hasText: 'pi Agent' }).waitFor();

		await page.locator('.component-update-row', { hasText: 'sample' }).getByRole('button', { name: '更新扩展' }).waitFor();
		await page.locator('.component-update-row', { hasText: 'broken' }).getByText('检查失败，可重试', { exact: true }).waitFor();
		await page.screenshot({ path: '/tmp/pi-component-updates.png' });
		await page.locator('.component-update-row', { hasText: 'sample' }).getByRole('button', { name: '更新扩展' }).click();
		await page.getByText('更新已安装，请重启应用以加载新版本。', { exact: true }).waitFor();
		assert.equal(await page.locator('.component-update-row', { hasText: 'sample' }).getByRole('button', { name: '更新扩展' }).count(), 0);
	}
	console.log('PASS component versions, built-in restrictions, pinned sources, registry errors and update UI');
} finally {
	await browser?.close(); ws?.close();
	if (server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await stopped; }
	rmSync(root, { recursive: true, force: true });
}
