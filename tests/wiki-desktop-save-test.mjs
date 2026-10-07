// Real Electron close-to-tray/quit must wait for Wiki saves, including failure.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const base = mkdtempSync(join(tmpdir(), 'wiki-desktop-save-')), cwd = join(base, 'work'), agent = join(base, 'agent');
mkdirSync(cwd); mkdirSync(agent);
writeFileSync(join(cwd, 'README.md'), '# Desktop save\n\nContent.\n');
writeFileSync(join(agent, 'auth.json'), JSON.stringify({ local: { type: 'api_key', key: 'unused' } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'local', defaultModel: 'unused' }));
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { local: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', models: [{ id: 'unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
let app, page;
try {
	app = await electron.launch({ args: ['.', `--user-data-dir=${join(base, 'profile')}`], env: { ...process.env, PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: agent } });
	for (let i = 0; i < 200; i++) { page = app.windows().find(p => p.url().startsWith('http://127.0.0.1:')); if (page) break; await sleep(100); }
	assert(page); page.setDefaultTimeout(10000);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.locator('.file-name', { hasText: 'README.md' }).click();
	const editor = page.locator('.wiki-prose .fp-rich-document'); await editor.waitFor();
	await page.waitForFunction(() => !document.querySelector('.wiki-send')?.textContent?.includes('会话准备中'));
	const type = async text => { await editor.locator('p').last().evaluate(el => { el.closest('[contenteditable]').focus(); const r = document.createRange(), s = getSelection(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r); }); await page.keyboard.type(text); };
	const close = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:')).close());
	const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:')).isVisible());
	await type(' Saved on hide.'); await close();
	for (let i = 0; i < 100 && await visible(); i++) await sleep(50);
	assert.equal(await visible(), false); assert(readFileSync(join(cwd, 'README.md'), 'utf8').includes('Saved on hide.'));
	await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:')); w.show(); w.focus(); });
	await page.route(/\/api\/wiki(\?|$)/, route => route.request().postDataJSON().action === 'write' ? route.fulfill({ status: 503, json: { error: 'Simulated failure' } }) : route.continue());
	await type(' Preserve failed save.'); await close();
	await page.getByRole('button', { name: '保存失败 · 重试', exact: true }).waitFor();
	assert.equal(await visible(), true); assert(!readFileSync(join(cwd, 'README.md'), 'utf8').includes('Preserve failed save.'));
	await page.unrouteAll(); await page.getByRole('button', { name: '保存失败 · 重试', exact: true }).click(); await page.locator('.wiki-save-status.saved').waitFor();
	await type(' Saved on quit.');
	await app.close(); app = null;
	assert(readFileSync(join(cwd, 'README.md'), 'utf8').includes('Saved on quit.'));
	console.log('PASS real Electron Wiki save before hide and quit; failed save keeps the window and draft');
} finally { await page?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {}); await app?.close(); rmSync(base, { recursive: true, force: true }); }
