import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
const data = mkdtempSync(join(tmpdir(), 'pi-toolbar-'));
const port = 8957;
const server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_DATA_DIR: data, PI_WEB_CWD: data, PI_CODING_AGENT_DIR: join(data, 'agent') }, stdio: 'ignore' });
let browser;
try {
	for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	mkdirSync('tests/scratch', { recursive: true });
	for (const platform of ['win32', 'darwin']) {
		const page = await browser.newPage();
		let socket, changeCount = 11;
		await page.routeWebSocket('**/ws', route => {
			socket = route;
			const upstream = route.connectToServer();
			route.onMessage(message => upstream.send(message));
			upstream.onMessage(wire => {
				const message = JSON.parse(wire.toString());
				if (message.type === 'snapshot' || message.type === 'snapshot_delta') {
					message.state.piConfigured = true;
					message.state.taskProgress = { id: 'toolbar-task', conversationId: message.state.conversationId, sourceMessageId: 'toolbar-user', title: 'Implement service', status: 'running', startedAt: Date.now(), completed: 1, steps: [], plan: { revision: 1, added: 0, removed: 0, items: Array.from({ length: 5 }, (_, i) => ({ id: `step-${i}`, title: `Step ${i + 1}`, status: i === 0 ? 'done' : i === 1 ? 'running' : 'pending' })) } };
				}
				if (message.type === 'git_branch') message.notRepo = false;
				if (message.type === 'scm_data' && message.kind === 'status') Object.assign(message, { ok: true, notRepo: false, files: Array.from({ length: changeCount }, (_, i) => ({ path: `changed-${i}.ts`, x: ' ', y: 'M' })) });
				if (message.type === 'bg_servers') message.servers = [{ port: 9001, since: Date.now() }, { port: 9002, since: Date.now() }];
				route.send(JSON.stringify(message));
			});
		});
		await page.addInitScript(platform => {
			window.electronAPI = { platform, windowAction() {}, onWindowState() { return () => {}; } };
			localStorage.setItem('pi-left-collapsed', 'true');
		}, platform);
		for (const width of [1000, 900, 1500]) {
			await page.setViewportSize({ width, height: 850 });
			await page.goto(`http://127.0.0.1:${port}`);
			await page.locator('.topbar-actions .topbar-more').waitFor();
			await page.locator('.tab-change-count', { hasText: String(changeCount) }).waitFor();
			assert.equal(await page.locator('.tab-change-count').evaluate(el => getComputedStyle(el).color), 'rgb(184, 81, 63)');
			assert.equal(await page.locator('.tab-change-count').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(252, 231, 227)');
			await page.waitForFunction(() => getComputedStyle(document.querySelector('.view-switch button.active')).color === 'rgb(47, 122, 174)');
			assert.equal(await page.locator('.topbar').evaluate(el => el.getBoundingClientRect().height), 44);
			assert.equal(await page.locator('.status-messages').count(), 0);
			assert.equal(await page.locator('.topbar-actions > .icon-btn').count(), 0);
			const input = page.locator('.inputbox textarea'), sendButton = page.locator('.inputbox .btn.send:visible');
			assert(await sendButton.isDisabled());
			assert.equal(await sendButton.evaluate(el => getComputedStyle(el).backgroundColor), 'oklch(0.9 0.004 80)');
			await input.fill('draft');
			await page.waitForFunction(() => [...document.querySelectorAll('.inputbox .btn.send')].filter(el => el.getClientRects().length).every(el => getComputedStyle(el).backgroundColor === 'rgb(47, 122, 174)'));
			assert.equal(await sendButton.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(47, 122, 174)');
			await page.waitForFunction(() => getComputedStyle(document.querySelector('.inputbox')).borderTopColor === 'rgb(47, 122, 174)');
			await input.fill('');
			assert.equal(await page.locator('.workspace-jobs .bg-task-badge').textContent(), '2');
			assert.equal(await page.locator('.header-task-progress').textContent(), '●第 2 / 5 步');
			assert.equal(await page.locator('.view-switch').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
			assert.equal(await page.locator('.project-panel-toggle').evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
			assert.equal(await page.locator('.topbar-actions > .panel-toggle').evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
			if (platform === 'darwin') assert.equal((await page.locator('.project-panel-toggle').boundingBox()).x, 92);
			for (const view of ['chat', 'nodes']) {
				if (view === 'nodes') await page.getByRole('tab', { name: '节点', exact: true }).click();
				const actions = await page.locator('.topbar-actions').boundingBox();
				const controls = await page.locator('.desktop-window-controls').count() ? await page.locator('.desktop-window-controls').boundingBox() : null;
				await page.locator('.topbar').screenshot({ path: `tests/scratch/toolbar-${platform}-${width}-${view}.png` });
				assert(actions.x + actions.width <= (controls?.x ?? width) + 1, `${platform}/${width}/${view}: toolbar overlaps window controls`);
				const taskButton = await page.locator('.header-task-progress').boundingBox();
				assert(taskButton.x + taskButton.width <= actions.x + 1, `${platform}/${width}/${view}: task overlaps tabs`);
				const menu = page.locator('.topbar-actions .topbar-more .chip');
				if (view === 'nodes') {
					assert.equal(await page.locator('.topbar-more').count(), 0, 'nodes does not move settings into the top-right toolbar');
					continue;
				}
				const box = await menu.boundingBox();
				const hit = await menu.evaluate(el => { const b = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); });
				assert(hit && box.width >= 60, `${platform}/${width}/${view}: settings is clipped or covered`);
				const file = await page.locator('.topbar-actions > .panel-toggle').boundingBox();
				assert(box.x + box.width <= file.x + 1, 'settings overlaps file toggle');
				await menu.click();
				await page.locator('.topbar-actions .dd-menu').waitFor();
				await page.keyboard.press('Escape');
			}
			await page.locator('.header-task-progress').click();
			await page.locator('.task-progress:visible').waitFor();
			assert(await page.locator('.task-progress').evaluate(el => document.activeElement === el));
			assert.equal(await page.locator('.panel-right > .panel-title').evaluate(el => el.getBoundingClientRect().height), 40);
			assert.equal(await page.locator('.tree-filter').textContent(), `改动 ${changeCount}`);
			if (width === 1500) {
				await page.locator('.topbar-actions > .panel-toggle').click();
				changeCount++;
				socket.send(JSON.stringify({ type: 'scm_changed' }));
				await page.locator('.tab-change-count', { hasText: String(changeCount) }).waitFor();
			assert.equal(await page.locator('.tab-change-count').evaluate(el => getComputedStyle(el).color), 'rgb(184, 81, 63)');
			assert.equal(await page.locator('.tab-change-count').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(252, 231, 227)');
			await page.waitForFunction(() => getComputedStyle(document.querySelector('.view-switch button.active')).color === 'rgb(47, 122, 174)');
				await page.locator('.topbar-actions > .panel-toggle').click();
				await page.locator('.tree-filter', { hasText: `改动 ${changeCount}` }).waitFor();
				await page.locator('.project-panel-toggle').click();
				if (platform === 'darwin') assert.equal((await page.locator('.project-panel-toggle').boundingBox()).x, 92);
				await page.screenshot({ path: `tests/scratch/toolbar-${platform}-expanded.png` });
			}
		}
		await page.locator('.topbar-more .chip').click();
		await page.locator('.workspace-settings-menu').screenshot({ path: `tests/scratch/settings-menu-${platform}.png` });
		await page.locator('.sound-menu-summary').click();
		await page.locator('.sound-master input').waitFor({ state: 'visible' });
		await page.locator('.sound-menu-summary').click();
		await page.locator('.dd-menu').getByRole('button', { name: '所有设置', exact: true }).click();
		await page.locator('.settings-tab[title="Extensions"]').click();
		assert.equal(await page.locator('.set-row', { hasText: 'rpiv-todo' }).count(), 0, 'removed bundled todo must not return');
		await page.locator('.extensions-panel .ext-header').getByRole('button', { name: '从 npm / git 安装', exact: true }).waitFor();
		await page.getByRole('button', { name: '系统提示词', exact: true }).click();
		await page.locator('.system-prompt-panel .prompt-sections').waitFor();
		await page.getByRole('button', { name: '原始文本', exact: true }).click();
		await page.locator('.prompt-raw').waitFor();
		assert.equal(await page.locator('.settings-modal textarea').count(), 0, 'raw native prompt stays read-only; editing starts from a source file');

		await page.close();
	}
	console.log('PASS Windows/macOS toolbar bounds and settings at 900/1000/1500px');
} finally {
	await browser?.close();
	const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped;
	rmSync(data, { recursive: true, force: true });
}
