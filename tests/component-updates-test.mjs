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
	const directory = join(root, 'plugins', 'node_modules', name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', omp: { hooks: 'index.ts' } }));
	writeFileSync(join(directory, 'index.ts'), 'export default function () {}');
}
writeFileSync(join(root, 'plugins', 'package.json'), JSON.stringify({ dependencies: { sample: '^1.0.0', pinned: '1.0.0', broken: '^1.0.0' } }));
const server = spawn(process.execPath, ['--import', pathToFileURL(registryMock).href, 'dist/server/index.js'], { env: { ...process.env, PORT: String(port), OMP_WEB_DATA_DIR: join(root, 'data'), OMP_WEB_CWD: root, OMP_WEB_AGENT_DIR: agent }, stdio: 'ignore' });
let browser, ws;
const messages = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate, attempts = 200) {
	for (let i = 0; i < attempts; i++) { const found = messages.find(predicate); if (found) return found; await sleep(50); }
	throw Error('Timed out waiting for update response');
}
try {
	for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {} await sleep(100); }
	ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	ws.on('message', wire => messages.push(JSON.parse(wire.toString())));
	await new Promise(resolve => ws.once('open', resolve));
	ws.send(JSON.stringify({ type: 'hello', clientId: 'component-test' }));
	await wait(m => m.type === 'ready', 1200);
	ws.send(JSON.stringify({ type: 'check_component_updates', requestId: 'check-1' }));
	const report = await wait(m => m.type === 'component_updates' && m.requestId === 'check-1' && m.phase === 'ready');
	assert.equal(report.items.find(item => item.id === 'builtin:agent').canUpdate, false);
	assert.equal(report.items.find(item => item.id === 'builtin:agent').status, 'available');
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
		await page.locator('.settings-tab[title="组件更新"]').click();
		await page.locator('.component-update-row', { hasText: 'Oh My Pi' }).waitFor();
		const builtin = page.locator('.component-update-row', { hasText: 'Oh My Pi' });
		assert.equal(await builtin.getByRole('button', { name: '更新扩展' }).count(), 0);
		await builtin.getByText('有新版本', { exact: true }).waitFor();
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
