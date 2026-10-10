// Wiki editing 22a: real filesystem writes, delayed acknowledgements and conflicts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
const port = 8998;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-editing-')), cwd = join(base, 'work'), agent = join(base, 'agent');
mkdirSync(cwd); mkdirSync(agent);
writeFileSync(join(agent, "auth.json"), JSON.stringify({ local: { type: "api_key", key: "unused" } }));
writeFileSync(join(cwd, 'README.md'), '# Editing workbench\n\nA paragraph to select and edit.\n\n## Section\n\nAnother paragraph.\n');
writeFileSync(join(cwd, 'linked.markdown'), '# Linked Markdown\n\nLinked text.\n');
writeFileSync(join(cwd, 'other.md'), '# Other\n\nOther content.\n');
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { local: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', models: [{ id: 'unused', name: 'Local model', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'local', defaultModel: 'unused' }));
const server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', browser, page, delayWrites = false, failWrite = false;
server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const disk = () => readFileSync(join(cwd, 'README.md'), 'utf8');
try {
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	const errors = []; page.on('pageerror', e => errors.push(e.message));
	const writes = [];
	await page.route('**/api/wiki', async route => {
		const body = route.request().postDataJSON();
		if (body.action === 'write') {
			writes.push(body);
			if (failWrite) return route.fulfill({ status: 503, json: { error: 'Temporary save failure' } });
			const response = await route.fetch();
			if (delayWrites) await sleep(1200);
			return route.fulfill({ response });
		}
		await route.continue();
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.locator('.file-name', { hasText: 'README.md' }).click();
	const editor = page.locator('.wiki-prose .fp-rich-document');
	await editor.waitFor();
	await page.getByRole('button', { name: '新对话', exact: true }).waitFor();
	await page.waitForFunction(() => !document.querySelector('.wiki-send')?.textContent?.includes('会话准备中'));
	assert.equal(await page.locator('.wiki-save, .wiki-prose .fp-rich-toolbar, .wiki-context-chips, .wiki-index-status').count(), 0);
	assert(!(await page.locator('.wiki-chat-model').innerText()).includes('0%'));
	const endParagraph = async () => editor.locator('p').last().evaluate(el => { el.closest('[contenteditable]').focus(); const r = document.createRange(), s = getSelection(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r); });
	const saved = () => page.locator('.wiki-save-status.saved').waitFor();
	await endParagraph(); await page.keyboard.type(' Auto saved.'); await saved();
	assert(disk().includes('Auto saved.'));
	// A delayed write never disables editing or overwrites the newer draft.
	delayWrites = true;
	await endParagraph(); await page.keyboard.type(' First write.');
	await page.waitForRequest(r => r.postDataJSON?.()?.action === 'write').catch(() => {});
	assert.equal(await editor.getAttribute('contenteditable'), 'true');
	await page.keyboard.type(' Newer typing.'); await saved(); delayWrites = false;
	assert(disk().includes('First write. Newer typing.'));
	// Navigation flushes immediately, before the debounce, and persists the last input.
	await endParagraph(); await page.keyboard.type(' Navigate now.');
	await page.locator('.wiki-tree-row[title="other.md"]').click();
	await page.locator('.wiki-document-heading h1', { hasText: 'Other' }).waitFor();
	assert(disk().includes('Navigate now.')); assert.equal(await page.locator('.wiki-confirm').count(), 0);
	await page.locator('.wiki-tree-row[title="README.md"]').click(); await editor.waitFor();
	await page.locator('.wiki-document-heading h1', { hasText: 'Editing workbench' }).waitFor();
	// Failures retain the draft and expose retry; no automatic request storm.
	failWrite = true; await endParagraph(); await page.keyboard.type(' Retained after failure.');
	await page.getByRole('button', { name: '保存失败 · 重试', exact: true }).waitFor();
	const attempts = writes.length; await sleep(1000); assert.equal(writes.length, attempts);
	await page.locator('.wiki-tree-row[title="other.md"]').click();
	const confirm=page.locator('.wiki-confirm');await confirm.waitFor();
	assert(await confirm.evaluate(el=>el.contains(document.activeElement)),'save failure moves focus into navigation guard');
	const controls=confirm.locator('button:enabled');
	await controls.last().focus();await page.keyboard.press('Tab');assert(await controls.first().evaluate(el=>el===document.activeElement));
	await page.keyboard.press('Shift+Tab');assert(await controls.last().evaluate(el=>el===document.activeElement));
	await confirm.getByRole('button',{name:'取消',exact:true}).click();await confirm.waitFor({state:'detached'});
	assert((await editor.innerText()).includes('Retained after failure.'));

	failWrite = false; await page.getByRole('button', { name: '保存失败 · 重试', exact: true }).click(); await saved();
	assert(disk().includes('Retained after failure.'));
	// External edit preserves the draft, then explicitly rebases its CAS version.
	await endParagraph(); await page.keyboard.type(' My version.');
	writeFileSync(join(cwd, 'README.md'), '# External\n\nDisk version.\n');
	await page.keyboard.press('Meta+s'); await page.locator('.wiki-conflict').waitFor();
	assert((await editor.innerText()).includes('My version.')); assert(disk().includes('Disk version.'));
	await page.getByRole('button', { name: '保留我的版本', exact: true }).click(); await saved();
	assert(disk().includes('My version.'));
	const cleanVersion = disk(); writeFileSync(join(cwd, 'README.md'), '# External clean change\n\nKeep existing editor until choice.\n');
	await page.getByRole('button', { name: '刷新文件', exact: true }).click();
	await page.locator('.wiki-conflict').waitFor(); assert((await editor.innerText()).includes('My version.'));
	await page.getByRole('button', { name: '保留我的版本', exact: true }).click(); await saved(); assert.equal(disk(), cleanVersion);
	// Compact slash menu: aliases, ordering, 8 visible rows, keyboard selection.
	await endParagraph(); await page.keyboard.press('Enter'); await page.keyboard.type('/');
	await page.locator('.wiki-slash-menu').waitFor();
	assert.equal(await page.locator('.wiki-slash-menu').getByRole('option').first().innerText(), '正文\n普通正文段落');
	assert.equal(await page.locator('.wiki-slash-menu').getByRole('option').count(), 11);
	assert(!(await page.locator('.wiki-slash-menu').innerText()).includes('标题 4'));
	await page.screenshot({ path: '/tmp/pi-wiki-edit-slash.png' });
	await page.keyboard.type('dm');
	assert.equal(await page.locator('.wiki-slash-menu').getByRole('option').count(), 1);
	await page.keyboard.press('Enter'); await page.locator('.wiki-language-picker input').waitFor(); await page.keyboard.press('Enter'); await page.keyboard.type('public class Demo {');
	await editor.locator('select[data-code-language]').last().selectOption('java');
	await page.keyboard.press('Enter'); await page.keyboard.type('int n = 1;');
	assert((await editor.locator('pre code').last().innerText()).includes('Demo {\nint n = 1;'));
	await page.keyboard.press('Meta+s'); await saved(); assert(disk().includes('```java'));
	// Space-prefixed slash and direct Markdown heading shorthand.
	await endParagraph(); await page.keyboard.type(' /bg'); await page.locator('.wiki-slash-menu').getByRole('option').waitFor(); await page.keyboard.press('Enter'); await page.locator('.wiki-table-picker').waitFor(); await page.keyboard.press('Enter');
	assert.equal(await editor.locator('table tr').count(), 3); assert.equal(await editor.locator('table th, table td').count(), 9);
	await endParagraph(); await page.keyboard.type('#### '); await page.keyboard.type('Fourth heading');
	await editor.locator('h4', { hasText: 'Fourth heading' }).waitFor();
	// Floating selection formatting and ask Pi use the current selection.
	const selectFirst = async () => editor.locator('p').first().evaluate(el => { el.closest('[contenteditable]').focus(); const r = document.createRange(), s = getSelection(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); });
	await selectFirst(); await page.locator('.wiki-format-popover').waitFor();
	await page.getByRole('button', { name: '黄色背景', exact: true }).click();
	await page.keyboard.press('Meta+s'); await saved(); assert(disk().includes('<mark style="background-color: #fff3a3">'));
	await page.getByRole('button', { name: '黄色背景', exact: true }).click();
	await page.keyboard.press('Meta+s'); await saved(); assert(!disk().includes('<mark style="background-color: #fff3a3">'));
	await selectFirst(); await page.screenshot({ path: '/tmp/pi-wiki-edit-selection.png' });
	await page.getByRole('button', { name: '问 pi', exact: true }).click();
	assert((await page.locator('.wiki-context-chips').innerText()).includes('A paragraph'));
	assert(await page.getByRole('textbox', { name: '问 pi', exact: true }).evaluate(el => document.activeElement === el));
	// Link chooser uses selected range and persists native Wiki link syntax.
	await selectFirst(); await page.getByRole('button', { name: '加双链', exact: true }).click();
	await page.getByRole('textbox', { name: '输入链接，或 [[ 搜索文档', exact: true }).fill('[[other');
	await page.locator('.wiki-link-results button', { hasText: 'other.md' }).click();
	await page.keyboard.press('Meta+s'); await saved(); assert(disk().includes('[[other.md|A paragraph'));
	// Direct [[ search and the image command preserve their insertion point.
	await endParagraph(); await page.keyboard.press('Enter'); await page.keyboard.type('[[');
	await page.getByRole('dialog', { name: '加双链', exact: true }).waitFor();
	assert.equal(await page.locator('.wiki-link-results button', { hasText: 'linked.markdown' }).count(), 1);
	await page.getByRole('textbox', { name: '输入链接，或 [[ 搜索文档', exact: true }).fill('[[other');
	await page.locator('.wiki-link-results button', { hasText: 'other.md' }).click();
	await page.keyboard.press('Meta+s'); await saved(); assert(disk().includes('[[other.md]]'));
	await endParagraph(); await page.keyboard.press('Enter'); await page.keyboard.type('/tp');
	const chooser = page.waitForEvent('filechooser'); await page.keyboard.press('Enter');
	await (await chooser).setFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64') });
	await editor.locator('img').waitFor(); await page.keyboard.press('Meta+s'); await saved();
	assert(disk().includes('![test.png](')); assert(!disk().includes('clientId='));
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('.wiki-chat-panel').getByRole('button', { name: '收起对话面板', exact: true }).click();
	await endParagraph(); await page.keyboard.press('Enter'); await page.keyboard.type('/');
	await page.locator('.wiki-slash-menu').waitFor();
	const popup = await page.locator('.wiki-slash-menu').boundingBox();
	assert(popup.x >= 0 && popup.x + popup.width <= 390 && popup.y >= 0 && popup.y + popup.height <= 844);
	await page.screenshot({ path: '/tmp/pi-wiki-edit-mobile.png' });
	await page.keyboard.press('Escape'); await page.keyboard.press('Meta+s'); await saved();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	assert.deepEqual(errors, []);
	console.log('PASS Wiki autosave, delayed typing, navigation flush, retry/conflict, slash, Markdown, table, selection, highlights, links and mobile');
} catch (error) { if (page) { await page.screenshot({ path: '/tmp/pi-wiki-edit-failure.png' }); console.error(await page.locator('.wiki-error, .wiki-conflict').allTextContents()); } console.error(log.slice(-2000)); throw error; }
finally { await page?.unrouteAll({ behavior: 'ignoreErrors' }); await browser?.close(); server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); rmSync(base, { recursive: true, force: true }); }
