/** Real Electron relaunch and navigation, with only OS browser launching stubbed. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
const root = mkdtempSync(join(tmpdir(), 'pi-desktop-state-'));
const initial = join(root, 'initial'), project = join(root, 'new-project'), other = join(root, 'other-project');
mkdirSync(initial); mkdirSync(project); mkdirSync(other);
let app;
async function launch() {
	app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], env: { ...process.env, PI_WEB_DATA_DIR: join(root, 'data'), PI_WEB_CWD: initial, PI_CODING_AGENT_DIR: join(root, 'agent') } });
	let page;
	for (let i = 0; i < 200; i++) {
		page = app.windows().find(w => w.url().startsWith('http://127.0.0.1:'));
		if (page) break;
		await sleep(100);
	}
	assert(page); page.setDefaultTimeout(10000);
	await page.locator('.project-item.active').waitFor();
	if (await page.locator('.setup-modal').count()) await page.locator('.setup-modal .modal-close').click();
	return page;
}
try {
	let page = await launch();
	if (process.argv.includes('--links')) {
		await app.evaluate(({ shell }) => { globalThis.openedUrls = []; shell.openExternal = async url => { globalThis.openedUrls.push(url); }; });
		await page.evaluate(() => { location.hash = 'local-anchor'; });
		assert.deepEqual(await app.evaluate(() => globalThis.openedUrls), [], 'anchors remain inside app');
		await page.evaluate(() => window.open('file:///tmp/blocked-desktop-link'));
		await sleep(100);
		assert.deepEqual(await app.evaluate(() => globalThis.openedUrls), [], 'non-web protocols are not opened');
		const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
		const url = page.url();
		for (const target of ['_blank', '_self']) {
			await page.evaluate(target => { const a = document.createElement('a'); a.href = 'https://example.com/desktop-test'; a.target = target; a.textContent = 'External test'; a.id = 'external-test'; document.body.append(a); }, target);
			await page.locator('#external-test').click({ noWaitAfter: true });
			await sleep(500);
			assert((await app.evaluate(() => globalThis.openedUrls)).includes('https://example.com/desktop-test'), `${target}: link must open in system browser`);
			assert.equal(page.url(), url, 'app must retain its page');
			assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), windows, 'no extra desktop windows');
			await page.evaluate(() => document.getElementById('external-test').remove());
			await app.evaluate(() => { globalThis.openedUrls = []; });
		}
		console.log('PASS desktop external links use system browser');
	} else {
for (const path of [other, project]) {
			await page.locator('.lp-add-project').click();
			await page.locator('.fpk-modal-foot input').fill(path);
			await page.locator('.fpk-open-btn').click();
			await page.locator('.project-item.active').filter({ hasText: path === other ? 'other-project' : 'new-project' }).waitFor();
		}
		const id = await page.evaluate(() => sessionStorage.getItem('pi-web-client-id'));
		const saved = JSON.parse(readFileSync(join(root, 'data', 'client-state.json'), 'utf8'));
		assert.equal(saved[id].lastCwd, project, 'project is persisted before exit');
		await app.close(); app = null;
		page = await launch();
		assert.equal(await page.locator('.project-item.active .project-name').textContent(), 'new-project', 'relaunch must restore last opened project');
		assert.equal(await page.evaluate(() => sessionStorage.getItem('pi-web-client-id')), id, 'desktop identity survives process and port changes');
		assert.equal(await page.locator('.project-name', { hasText: 'other-project' }).count(), 1, 'other opened folders also survive');
		await page.reload();
		await page.locator('.project-item.active .project-name', { hasText: 'new-project' }).waitFor();
		assert.equal(await page.evaluate(() => sessionStorage.getItem('pi-web-client-id')), id);
		console.log('PASS desktop restores project list and active folder after relaunch and reload');
	}
} finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
