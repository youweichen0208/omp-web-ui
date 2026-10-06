/** Real clicks to target content + two animation frames, three isolated launches.
 * Run serially after resource loads. --electron-executable selects a packaged app.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, _electron } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
const executable = process.argv.find(a => a.startsWith('--electron-executable='))?.slice('--electron-executable='.length);
const mode = executable ? 'electron' : 'web';
const directory = mkdtempSync(join(tmpdir(), 'pi-click-bench-'));
process.env.PI_CODING_AGENT_DIR = join(directory, 'agent');
const { SessionManager } = await import('@earendil-works/pi-coding-agent');
const paths = [0, 1, 2].map(i => join(directory, `project-${i}`));
for (const [index, path] of paths.entries()) {
	mkdirSync(path);
	const manager = SessionManager.create(path);
	manager.appendMessage({ role: 'user', content: `marker-project-${index}`, timestamp: Date.now() });
	manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `reply-project-${index}` }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
}
const samples = [];
try {
	for (let round = 1; round <= 3; round++) {
		const launchedAt = performance.now();
		let server, app, browser, page;
		const env = { ...process.env, PI_WEB_DATA_DIR: join(directory, `data-${round}`), PI_WEB_CWD: paths[0], PI_CODING_AGENT_DIR: join(directory, 'agent') }; delete env.ELECTRON_RUN_AS_NODE;
		try {
			if (executable) {
				app = await _electron.launch({ executablePath: resolve(executable), args: [`--user-data-dir=${join(directory, `profile-${round}`)}`], env });
				assert(await app.evaluate(({ app }) => app.isPackaged));
				for (let i = 0; i < 300 && !page; i++) { page = app.windows().find(p => p.url().startsWith('http://127.0.0.1:')); if (!page) await sleep(100); }
			} else {
				const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r)); assert(port >= 8900);
				server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...env, PORT: String(port) }, stdio: 'ignore' });
				let ready = false; for (let i = 0; i < 300 && !ready; i++) { try { ready = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).pid === server.pid; } catch {} if (!ready) await sleep(100); } assert(ready);
				browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true }); page = await browser.newPage(); await page.goto(`http://127.0.0.1:${port}`);
			}
			assert(page); assert(Number(new URL(page.url()).port) >= 8900); await page.locator('.project-item.active').waitFor();
			if (await page.locator('.setup-modal .modal-close').count()) await page.locator('.setup-modal .modal-close').click();
			samples.push({ round, scenario: 'launch-to-ready', ms: performance.now() - launchedAt });
			await page.waitForFunction(path => [...document.querySelectorAll('.project-item')].some(el => el.title === path), paths[2]);
			const select = async index => page.evaluate(({ path, marker }) => new Promise((res, rej) => {
				const start = performance.now(); [...document.querySelectorAll('.project-item')].find(el => el.title === path).click();
				const frame = () => {
					if (document.querySelector('main')?.textContent.includes(marker) && !document.querySelector('textarea:not(.xterm-helper-textarea)')?.disabled && !document.querySelector('.protocol-banner[role="status"]')) requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - start)));
					else if (performance.now() - start > 15000) rej(Error('target frame timeout'));
					else requestAnimationFrame(frame);
				}; frame();
			}), { path: paths[index], marker: `marker-project-${index}` });
			for (let i = 0; i < 3; i++) await select(i);
			for (let i = 0; i < 30; i++) samples.push({ round, scenario: 'warm-project-click', ms: await select(i % 3) });
			await page.locator('.view-switch [role=tab]').nth(1).click(); await page.locator('.xterm-screen').waitFor();
			await page.locator('.view-switch [role=tab]').nth(0).click(); await page.locator('textarea:not(.xterm-helper-textarea)').waitFor();
			for (let i = 0; i < 30; i++) samples.push({ round, scenario: 'warm-view-click', ms: await page.evaluate(index => new Promise((res, rej) => {
				const start = performance.now(); document.querySelectorAll('.view-switch [role="tab"]')[index].click();
				requestAnimationFrame(() => requestAnimationFrame(() => { const target = document.querySelector(index === 1 ? '.xterm-screen' : 'textarea:not(.xterm-helper-textarea)'); if (!target?.getBoundingClientRect().height) rej(Error('view not visible')); else res(performance.now() - start); }));
			}), i % 2 ? 0 : 1) });
		} finally { await app?.close(); await browser?.close(); if (server?.exitCode === null) { server.kill(); await once(server, 'exit'); } }
	}
	const summary = [...new Set(samples.map(s => s.scenario))].map(scenario => { const values = samples.filter(s => s.scenario === scenario).map(s => s.ms).sort((a, b) => a - b); return { scenario, n: values.length, p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1] }; });
	writeFileSync(`docs/review-data/${mode}-interaction.json`, JSON.stringify({ mode, node: process.version, definition: 'real click to content visible, enabled input and two requestAnimationFrame callbacks; warmed three short native histories', samples, summary }, null, 2) + '\n');
	console.log(mode, summary);
} finally { rmSync(directory, { recursive: true, force: true }); }
