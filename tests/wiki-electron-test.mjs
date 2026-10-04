// Actual Electron/preload/backend integration; OS opening is stubbed at the shell boundary.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const base = mkdtempSync(join(tmpdir(), 'pi-wiki-electron-')), cwd = join(base, 'wiki');
mkdirSync(cwd); writeFileSync(join(cwd, 'README.md'), '# Desktop Wiki\n\nNative workspace.'); writeFileSync(join(cwd, 'sample.bin'), Buffer.from([0, 1, 2]));
let app;
try {
	app = await electron.launch({ args: ['.', `--user-data-dir=${join(base, 'profile')}`], env: { ...process.env, PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') } });
	let page;
	for (let i = 0; i < 200; i++) { page = app.windows().find(w => w.url().startsWith('http://127.0.0.1:')); if (page) break; await new Promise(r => setTimeout(r, 100)); }
	assert(page); page.setDefaultTimeout(12000);
	await page.waitForFunction(() => !!window.electronAPI?.appUpdate);
	assert.equal((await page.evaluate(() => window.electronAPI.appUpdate('read'))).phase, 'unsupported');
	assert.equal(await page.evaluate(async () => { try { await window.electronAPI.appUpdate('arbitrary'); return false; } catch { return true; } }), true);
	await page.locator('.setup-modal').waitFor();
	await page.locator('.setup-modal .modal-close').click();
	await app.evaluate(({ BrowserWindow, shell }) => { BrowserWindow.getAllWindows()[0].setSize(1440, 950); shell.openPath = async path => { globalThis.wikiOpened = path; return ''; }; });
	assert.equal(await page.getByRole('tab', { name: 'Wiki 模式', exact: true }).count(), 0);
	await page.locator('.file-name', { hasText: 'README.md' }).click();
	await page.locator('.wiki-document h1', { hasText: 'Desktop Wiki' }).waitFor();
	const tabs = await page.locator('.topbar .view-switch').boundingBox(); assert(tabs.x >= 90, 'tabs must avoid macOS traffic lights');
	await page.getByRole('treeitem', { name: 'sample.bin', exact: true }).click();
	await page.getByRole('button', { name: '用默认应用打开', exact: true }).click();
	for (let i = 0; i < 30 && !(await app.evaluate(() => globalThis.wikiOpened)); i++) await new Promise(r => setTimeout(r, 100));
	assert((await app.evaluate(() => globalThis.wikiOpened)).endsWith('sample.bin'));
	const rejected = await page.evaluate(async cwd => { try { await window.electronAPI.openWikiFile({ clientId: sessionStorage.getItem('pi-web-ui:client-id'), cwd, path: '../outside' }); return false; } catch { return true; } }, cwd);
	assert(rejected, 'invalid file identity is rejected');
	await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
	await page.locator('.wiki-document h1', { hasText: 'Desktop Wiki' }).waitFor();
	assert.equal(await page.getByRole('dialog', { name: '有未保存修改' }).count(), 0, 'read-only media never creates a dirty draft');
	await page.screenshot({ path: 'tests/scratch/wiki-electron.png' });
	console.log('PASS actual Electron Wiki layout, preload, validated default-app opening and invalid identity rejection');
} finally { await app?.close(); rmSync(base, { recursive: true, force: true }); }
