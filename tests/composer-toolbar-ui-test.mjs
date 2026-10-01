/** Focused browser regression for the compact composer toolbar. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';

const port = 8996;
const root = mkdtempSync(join(tmpdir(), 'pi-composer-toolbar-'));
let server, browser;
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), OMP_WEB_CWD: root, OMP_WEB_DATA_DIR: join(root, 'data'), OMP_WEB_AGENT_DIR: join(root, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = ''; server.stderr.on('data', (chunk) => { stderr += chunk; });
	for (let i = 0; i < 80 && !await portUp(port); i++) await sleep(200);
	assert(await portUp(port), stderr);
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
	let socket, state;
	const sent = [];
	await page.routeWebSocket('**/ws', (route) => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage((wire) => { const msg = JSON.parse(wire.toString()); sent.push(msg); if (msg.type !== 'set_thinking') upstream.send(wire); });
		upstream.onMessage((wire) => { const msg = JSON.parse(wire.toString()); if (msg.type === 'snapshot') { if (!state) { state = msg.state; route.send(wire); } } else route.send(wire); });
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.inputbox textarea').waitFor();
	for (let i = 0; i < 50 && !state; i++) await sleep(100);
	assert(state, 'initial snapshot');
	state = { ...state, rev: state.rev + 1, isStreaming: true, piConfigured: true, model: { id: 'glm-5.3', name: 'GLM 5.3 (Volc)', provider: 'volc' }, thinkingLevel: 'high', availableThinkingLevels: ['minimal', 'medium', 'high'] };
	socket.send(JSON.stringify({ type: 'snapshot', state }));
	await page.locator('.thinking-control .chip', { hasText: '思考 · 深度' }).waitFor();
	const thinkingStyle = await page.locator('.thinking-control .chip').evaluate((element) => ({ border: getComputedStyle(element).borderColor, modelBorder: getComputedStyle(document.querySelector('.input-tools-left > .dropdown .chip')).borderColor }));
	assert.equal(thinkingStyle.border, thinkingStyle.modelBorder, 'thinking and model triggers share the same border treatment');
	assert.equal(await page.locator('.input-tools .btn.supplement:visible, .input-tools .btn.steer:visible').count(), 0, 'empty composer hides queue and steer');
	assert(await page.locator('.usage-cache-short').isVisible(), 'wide composer shows cache summary');
	await page.locator('.thinking-control .chip').click();
	await page.locator('.dd-menu-thinking', { hasText: '速度和质量平衡' }).waitFor();
	await page.locator('.dd-menu-thinking .dd-item', { hasText: '标准' }).click();
	assert(sent.some((msg) => msg.type === 'set_thinking' && msg.level === 'medium'), 'thinking menu selects a supported level');
	await page.locator('.inputbox textarea').fill('顺便修改文件名');
	await page.locator('.input-tools .btn.supplement:visible').waitFor();
	await page.locator('.input-tools .btn.steer:visible').waitFor();
	await page.setViewportSize({ width: 460, height: 900 });
	assert.equal(await page.locator('.thinking-trigger-prefix').isVisible(), false, 'narrow composer hides thinking prefix');
	assert.equal(await page.locator('.usage-cache-short').isVisible(), false, 'narrow composer hides cache summary');
	const toolbar = await page.locator('.input-tools').evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth, stop: element.querySelector('.btn.stop').getBoundingClientRect().width }));
	assert(toolbar.content <= toolbar.width + 1, `composer toolbar must fit 460px: ${JSON.stringify(toolbar)}`);
	assert(toolbar.stop >= 30, 'stop button keeps its size');
	await page.locator('.usage-trigger').click();
	await page.locator('.usage-popover .usage-cache-section').waitFor();
	await page.locator('.usage-trigger').click();
	await page.setViewportSize({ width: 390, height: 900 });
	assert.equal(await page.locator('.input-tools-left .chip-model').isVisible(), false, 'smallest composer keeps only model icon');
	const smallest = await page.locator('.input-tools').evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
	assert(smallest.content <= smallest.width + 1, `composer toolbar must fit 390px: ${JSON.stringify(smallest)}`);
	console.log('composer toolbar UI passed');
} finally {
	await browser?.close();
	if (server?.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(2000)]); }
	rmSync(root, { recursive: true, force: true });
}
