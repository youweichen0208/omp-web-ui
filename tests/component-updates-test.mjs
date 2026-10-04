/** Isolated WS + browser regression; registry responses are local fixtures. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { portUp } from './lib/port-utils.mjs';
import { CHROME_PATH } from './lib/chrome.mjs';
const port = Number(process.argv.slice(2).find(arg => /^\d+$/.test(arg)) || 9149);
assert.equal(await portUp(port), false, `Port ${port} busy`);
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
mkdirSync(join(agent, 'skills', 'settings-fixture'), { recursive: true });
writeFileSync(join(agent, 'skills', 'settings-fixture', 'SKILL.md'), '---\nname: settings-fixture\ndescription: A loaded skill description that expands in the compact settings list.\n---\nUse this fixture only in tests.\n');
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
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		page.setDefaultTimeout(12000);
		const terminalCommands = [];
		let staleRegistry = false;
		const errors = []; page.on('pageerror', e => errors.push(e.message));
		await page.routeWebSocket('**/ws', route => {
			const upstream = route.connectToServer();
			route.onMessage(wire => {
				const message = JSON.parse(wire.toString());
				if (message.type === 'run_command') { terminalCommands.push(message); return; }
				if (message.type === 'update_component') {
					route.send(JSON.stringify({ type: 'component_updates', requestId: message.requestId, cwd: root, phase: 'updating', items: [] }));
					setTimeout(() => route.send(JSON.stringify({ type: 'component_updates', requestId: message.requestId, cwd: root, phase: 'updated', restartRequired: true, items: report.items.map(item => item.id === message.id ? { ...item, current: item.latest, status: 'current', canUpdate: false } : item) })), 100);
					return;
				}
				upstream.send(wire);
			});
			upstream.onMessage(wire => { const message = JSON.parse(wire.toString()); if (message.type === 'snapshot' || message.type === 'snapshot_delta') message.state.piConfigured = true; if (staleRegistry && message.type === 'update_status') Object.assign(message, { latest: '0.9.0', upToDate: true }); route.send(JSON.stringify(message)); });
		});
		await page.goto(`http://127.0.0.1:${port}`);
		// Close first-run model setup when present; no real model is required.
		await page.locator('.topbar-more .chip').waitFor();
		await page.keyboard.press('Escape');
		await page.locator('.topbar-more .chip').click();
		await page.locator('.dd-menu').getByRole('button', { name: '所有设置', exact: true }).click();
		assert.equal(await page.getByRole('button', { name: /目标审查|视觉桥|预设/ }).count(), 0);
		assert.equal(await page.getByRole('button', { name: '界面插件', exact: true }).count(), 0);
		assert.equal(await page.getByRole('button', { name: '消息显示', exact: true }).count(), 0);
		assert.equal(await page.locator('.settings-tab.active').innerText(), '系统提示词');
		for (const width of [1440, 900, 390]) {
			await page.setViewportSize({ width, height: 1000 });
			let expected;
			for (const name of ['系统提示词', '技能', 'Extensions', 'MCP 与 Codemode', '组件更新']) {
				await page.locator('.settings-rail').getByRole('button', { name, exact: true }).click();
				const boxes = await page.evaluate(() => ['.settings-modal', '.settings-rail', '.modal-body'].map(selector => { const b = document.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round); }));
				expected ??= boxes; assert.deepEqual(boxes, expected, `consistent settings shell at ${width}: ${name}`);
				const modal = await page.locator('.settings-modal').boundingBox();
				const close = await page.locator('.settings-modal > .modal-head button').boundingBox();
				assert(close.x > modal.x + modal.width - 90, 'close stays at top right');
				assert(modal.x >= 0 && modal.x + modal.width <= width, 'modal fits viewport');
				if (width === 1440 || width === 390) await page.screenshot({ path: `/tmp/pi-settings-minimal-${width}-${name.replaceAll(' ', '-')}.png` });
			}
		}
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.locator('.settings-rail').getByRole('button', { name: '技能', exact: true }).click();
		const skill = page.locator('.settings-skill').filter({ hasText: 'settings-fixture' });
		await skill.locator('summary').click();
		assert(await skill.locator('p').isVisible(), 'skill expands its full description');
		await page.getByRole('button', { name: '系统提示词', exact: true }).click();
		await page.locator('.prompt-sections').waitFor();
		assert.equal(await page.locator('.settings-modal textarea').count(), 0, 'native prompt must be read-only');
		assert((await page.locator('.prompt-sections').textContent()).length > 0);
		await page.getByRole('button', { name: '组件更新', exact: true }).click();
		await page.locator('.component-update-row', { hasText: 'pi Agent' }).waitFor();

		await page.locator('.component-update-row', { hasText: 'sample' }).getByRole('button', { name: '更新扩展' }).waitFor();
		await page.locator('.component-update-row', { hasText: 'broken' }).getByText('检查失败，可重试', { exact: false }).waitFor();
		await page.screenshot({ path: '/tmp/pi-component-updates.png' });
		await page.locator('.component-update-row', { hasText: 'sample' }).getByRole('button', { name: '更新扩展' }).click();
		await page.getByText('更新已安装，请重启应用以加载新版本。', { exact: true }).waitFor();
		assert.equal(await page.locator('.component-update-row', { hasText: 'sample' }).getByRole('button', { name: '更新扩展' }).count(), 0);
		await page.getByRole('button', { name: '自动更新', exact: true }).click();
		await page.waitForFunction(() => !document.querySelector('.settings-modal'));
		for (let i = 0; i < 100 && !terminalCommands.length; i++) await sleep(50);
		assert.equal(terminalCommands.length, 1);
		assert.equal(terminalCommands[0].command.command, 'npm install -g @youweichen/pi-web-ui@999.0.0');
		staleRegistry = true;
		await page.evaluate(() => localStorage.setItem('pi-web-ui:appearance', 'dark'));
		await page.reload();
		await page.locator('.topbar-more .chip').waitFor();
		assert.equal(await page.locator('html').getAttribute('data-appearance'), 'dark');
		await page.locator('.topbar-more .chip').click();
		await page.locator('.dd-menu').getByRole('button', { name: '所有设置', exact: true }).click();
		await page.getByRole('button', { name: '组件更新', exact: true }).click();
		await page.locator('.component-update-row', { hasText: 'pi-web-ui' }).getByText(/已是最新/).waitFor();
		assert(await page.getByRole('button', { name: '自动更新', exact: true }).isDisabled(), 'old registry latest cannot downgrade');
		assert.deepEqual(errors, []);

		// Exercise the renderer against a desktop bridge without downloading or installing anything.
		await page.addInitScript(() => {
			let listener, state = { phase: 'available', current: '0.12.0', latest: '0.13.0' };
			window.updateActions = [];
			window.electronAPI = {
				platform: 'darwin', windowAction() {}, onWindowState() { return () => {}; },
				onAppUpdate(callback) { listener = callback; return () => { listener = undefined; }; },
				async appUpdate(action) {
					window.updateActions.push(action);
					if (action === 'update') { state = { ...state, phase: 'downloading', percent: 42 }; listener?.(state); }
					return state;
				},
			};
			window.finishDownload = () => { state = { ...state, phase: 'downloaded', percent: 100 }; listener?.(state); };
		});
		await page.reload();
		await page.locator('.topbar-more .chip').click();
		await page.locator('.dd-menu').getByRole('button', { name: '所有设置', exact: true }).click();
		await page.getByRole('button', { name: '组件更新', exact: true }).click();
		await page.getByRole('button', { name: '自动更新', exact: true }).click();
		await page.getByText('正在下载：42%', { exact: true }).waitFor();
		assert(await page.getByRole('button', { name: '自动更新', exact: true }).isDisabled());
		await page.evaluate(() => window.finishDownload());
		await page.getByRole('button', { name: '重启并安装', exact: true }).click();
		assert.deepEqual(await page.evaluate(() => window.updateActions.filter(a => a !== 'read')), ['update', 'install']);

	}
	console.log('PASS component versions, built-in restrictions, pinned sources, registry errors and update UI');
} finally {
	await browser?.close(); ws?.close();
	if (server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await stopped; }
	rmSync(root, { recursive: true, force: true });
}
