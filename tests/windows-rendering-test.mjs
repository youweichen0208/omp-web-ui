/** Actual Electron/OS rendering; CI runs this on macOS and Windows at 100%/125%. */
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const base = mkdtempSync(join(tmpdir(), 'pi-rendering-')), cwd = join(base, 'project'), agent = join(base, 'agent');
const output = resolve(process.env.PI_RENDER_OUTPUT || 'tests/scratch/rendering');
mkdirSync(cwd); mkdirSync(agent); mkdirSync(output, { recursive: true });
for (const name of ['.ruff_cache', 'raw', 'scripts', 'skills', ...Array.from({ length: 40 }, (_, i) => `source-${String(i).padStart(2, '0')}`)]) mkdirSync(join(cwd, name));
writeFileSync(join(cwd, 'README.md'), '# 本质：渲染验收\n\n同一份离线测试资料。\n');
writeFileSync(join(agent, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'render-test' }));
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', models: [{ id: 'render-test', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
const timestamp = 1791547200000;
const transcript = [
	{ id: 'render-user', role: 'user', content: [{ type: 'text', text: '请说明这个项目的本质，并检查文档转换与知识整理。' }], timestamp },
	{ id: 'render-assistant', role: 'assistant', model: 'render-test', content: [{ type: 'thinking', thinking: '先检查原始资料和已有知识，保留可追溯的来源。', durationMs: 2000 }, { type: 'text', text: '## 本质：职责分离\n\n文档转换保留文字、表格和代码；知识整理提取可信结论，并保留证据与适用条件。\n\n```python\ndef convert_document(source):\n    return source.read_text()\n```' }, ...[1, 2, 3].map(n => ({ type: 'toolCall', id: `render-bash-${n}`, name: 'bash', argumentsText: JSON.stringify({ command: `echo '检查 PDF、CHM 与源码资料的转换结果并核对来源 ${n}'` }) }))], timestamp: timestamp + 1000 },
	...[1, 2, 3].map(n => ({ id: `render-result-${n}`, role: 'toolResult', toolCallId: `render-bash-${n}`, toolName: 'bash', content: [{ type: 'text', text: '检查完成。\n' }], isError: false, timestamp: timestamp + 2000 + n })),
	{ id: 'render-final', role: 'assistant', model: 'render-test', content: [{ type: 'text', text: '已检查转换结果。待验证结论保留草稿，人工复核后发布。' }], timestamp: timestamp + 4000 },
];
let app;
try {
	for (const scale of process.platform === 'win32' ? [1, 1.25] : [1]) {
		app = await electron.launch({ ...(process.argv[2] ? { executablePath: resolve(process.argv[2]) } : {}), args: [...(process.argv[2] ? [] : ['.']), `--force-device-scale-factor=${scale}`, `--user-data-dir=${join(base, `profile-${scale}`)}`], env: { ...process.env, PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, `data-${scale}`), PI_CODING_AGENT_DIR: agent } });
		let page;
		for (let i = 0; i < 200; i++) { page = app.windows().find(p => p.url().startsWith('http://127.0.0.1:')); if (page) break; await sleep(100); }
		assert(page, 'local app window starts'); page.setDefaultTimeout(15000);
		let conversation = false;
		await page.routeWebSocket('**/ws*', socket => {
			const upstream = socket.connectToServer(); socket.onMessage(message => upstream.send(message));
			upstream.onMessage(wire => {
				const message = JSON.parse(wire.toString());
				if (message.type === 'snapshot' || message.type === 'snapshot_delta') { message.state.piConfigured = true; message.state.messages = conversation ? transcript : []; message.state.isStreaming = false; message.state.streamingMessage = null; if (message.type === 'snapshot_delta') { message.type = 'snapshot'; delete message.appended; delete message.baseRev; } }
				socket.send(JSON.stringify(message));
			});
		});
		await page.evaluate(() => { localStorage.setItem('pi-appearance', 'light'); localStorage.setItem('pi-left-collapsed', 'false'); });
		await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:')); w.setContentSize(1440, 900); });
		const cdp = await page.context().newCDPSession(page);
		const nativeWindow = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:')); return { size: w.getContentSize(), background: w.getBackgroundColor() }; });
		assert.equal(nativeWindow.background.toUpperCase(), '#FBF9F6');
		// Hosted macOS can clamp native windows to its small virtual display. Keep
		// the comparison canvas identical; still use this OS/Electron font renderer.
		if (nativeWindow.size[0] !== 1440 || nativeWindow.size[1] !== 900) await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: scale, mobile: false });
		await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
		const fonts = [], failures = [];
		page.on('response', response => { if (/\.woff2(?:\?|$)/.test(response.url())) { fonts.push({ url: new URL(response.url()).pathname, status: response.status() }); if (!response.ok()) failures.push(response.url()); } });
		await page.reload(); await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' }); await page.locator('.empty-example-icon svg').first().waitFor();
		assert.equal(await page.evaluate(() => document.documentElement.dataset.platform), process.platform);
		await page.evaluate(async () => { await Promise.all([400, 500, 600].map(weight => document.fonts.load(`${weight} 16px "UI SC"`, '本质检查'))); await document.fonts.load('400 12px "JetBrains Mono"', '.ruff_cache'); await document.fonts.ready; });
		const prefix = `${process.platform}-${Math.round(scale * 100)}`;
		await page.screenshot({ path: join(output, `${prefix}-empty.png`) });
		assert.equal(await page.locator('.empty-example-icon svg').count(), 4);
		assert.equal(failures.length, 0, `font resources load successfully: ${JSON.stringify(fonts)}`);
		assert.equal(new Set(fonts.filter(font => /ui-sc-/.test(font.url)).map(font => font.url)).size, 3);
		assert(fonts.some(font => /jetbrains-mono/.test(font.url) && font.status === 200));
		conversation = true; await page.reload(); await page.locator('.msg-text', { hasText: '职责分离' }).waitFor().catch(async error => { await page.screenshot({ path: join(output, `${prefix}-failure.png`) }); writeFileSync(join(output, `${prefix}-failure.txt`), await page.locator('body').innerText()); throw error; }); await page.evaluate(() => document.fonts.ready);
		await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
		const { root } = await cdp.send('DOM.getDocument'); const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.msg-text h2' });
		const rendered = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
		assert(rendered.fonts.some(font => font.familyName === 'UI SC' && font.isCustomFont && font.glyphCount > 0), JSON.stringify(rendered));
		const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, platform: document.documentElement.dataset.platform, appearance: document.documentElement.dataset.appearance, bodySize: getComputedStyle(document.body).fontSize }));
		assert.equal(metrics.bodySize, process.platform === 'win32' ? '14.5px' : '14px');
		assert.equal(metrics.width, 1440); assert.equal(metrics.height, 900); assert.equal(metrics.dpr, scale);
		for (const selector of ['.panel-right > .panel-title > span:first-child', '.bash-group-head > span']) for (const item of await page.locator(selector).all()) assert.equal(await item.evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
		await page.mouse.move(720, 880); await page.screenshot({ path: join(output, `${prefix}-conversation.png`) });
		const scroll = page.locator('.file-tree');
		if (await scroll.count()) { await scroll.hover(); await page.screenshot({ path: join(output, `${prefix}-scrollbar.png`) }); }
		writeFileSync(join(output, `${prefix}-metrics.json`), JSON.stringify({ ...metrics, nativeWindow, fonts, renderedFonts: rendered.fonts }, null, 2));
		await app.close(); app = undefined;
		console.log(`PASS actual ${prefix} Electron: platform, fonts, SVG icons, labels, 1440x900 screenshots`);
	}
} finally { await app?.close().catch(() => {}); rmSync(base, { recursive: true, force: true }); }
