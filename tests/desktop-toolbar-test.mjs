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
		await page.routeWebSocket('**/ws', route => {
			const upstream = route.connectToServer();
			route.onMessage(message => upstream.send(message));
			upstream.onMessage(wire => {
				const message = JSON.parse(wire.toString());
				if (message.type === 'snapshot' || message.type === 'snapshot_delta') message.state.piConfigured = true;
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
			for (const view of ['chat', 'nodes']) {
				if (view === 'nodes') await page.getByRole('tab', { name: '节点', exact: true }).click();
				const actions = await page.locator('.topbar-actions').boundingBox();
				const controls = await page.locator('.desktop-window-controls').count() ? await page.locator('.desktop-window-controls').boundingBox() : null;
				await page.locator('.topbar').screenshot({ path: `tests/scratch/toolbar-${platform}-${width}-${view}.png` });
				assert(actions.x + actions.width <= (controls?.x ?? width) + 1, `${platform}/${width}/${view}: toolbar overlaps window controls`);
				const menu = page.locator('.topbar-actions .topbar-more .chip');
				const box = await menu.boundingBox();
				const hit = await menu.evaluate(el => { const b = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); });
				assert(hit && box.width >= 60, `${platform}/${width}/${view}: settings is clipped or covered`);
				const file = await page.locator('.topbar-actions > .panel-toggle').boundingBox();
				assert(box.x + box.width <= file.x + 1, 'settings overlaps file toggle');
				await menu.click();
				await page.locator('.topbar-actions .dd-menu').waitFor();
				await page.keyboard.press('Escape');
			}
		}
		await page.close();
	}
	console.log('PASS Windows/macOS toolbar bounds and settings at 900/1000/1500px');
} finally {
	await browser?.close();
	const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped;
	rmSync(data, { recursive: true, force: true });
}
