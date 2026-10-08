// Real Chromium regression for slash picker anchors after deleting the command text.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
const port = 8999, base = mkdtempSync(join(tmpdir(), 'wiki-format-editor-'));
writeFileSync(join(base, 'note.md'), '# Code\n\n```java\npublic class Original {}\n```\n\nInsert here.\n');
let server, browser;
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	const editor = page.locator('.wiki-prose .fp-rich-document');
	await editor.locator('code .hljs-keyword').first().waitFor();
	const toolbar = page.locator('.wiki-insert-toolbar');
	assert.deepEqual(await toolbar.locator('button').evaluateAll(buttons => buttons.slice(0, -1).map(button => button.getAttribute('aria-label'))), ['正文', '标题 2', '标题 3', '列表', '插入表格', '图片', '任务列表', '引用', '代码块', '文档链接', '提及日期']);
	await editor.locator('p').last().fill('Insert here.');
	for (const [label, tag] of [['标题 2', 'h2'], ['标题 2', 'h2'], ['标题 3', 'h3'], ['正文', 'p']]) {
		await toolbar.getByRole('button', { name: label, exact: true }).click();
		assert.equal(await editor.locator(tag).last().textContent(), 'Insert here.');
	}
	await toolbar.getByRole('button', { name: '提及日期', exact: true }).click();
	assert.ok((await editor.locator('p').last().textContent()).includes(new Date().toLocaleDateString('sv-SE')));
	console.log('PASS complete toolbar, explicit headings/paragraph and date insertion');
	for (const [alias, label, kind] of [['dmk', '代码块', 'code'], ['bg', '插入表格', 'table']]) {
		for (const input of ['mouse', 'keyboard']) {
			await editor.locator('p').last().fill('');
			await page.keyboard.type(`/${alias}`);
			const trigger = await editor.locator('p').last().boundingBox();
			if (input === 'mouse') await page.getByRole('option', { name: label, exact: true }).click();
			else await page.keyboard.press('Enter');
			const popup = await page.locator(`.wiki-${kind}-popover`).boundingBox();
			assert.ok(Math.abs(popup.x - trigger.x) < 20 && popup.y >= trigger.y && popup.y <= trigger.y + trigger.height + 10, `/${alias} (${input}) picker stays at the insertion point: ${JSON.stringify({ trigger, popup })}`);
			await page.keyboard.press('Escape');
			console.log(`PASS /${alias} ${input} positioning`);
		}
	}
	await editor.locator('p').last().fill('');
	await page.keyboard.type('/dmk');
	await page.getByRole('option', { name: '代码块', exact: true }).click();
	await page.locator('.wiki-code-popover').getByRole('option', { name: 'python', exact: false }).click();
	await page.keyboard.type('print("slash")');
	await page.keyboard.press('Meta+s');
	await page.locator('.wiki-save-status.saved').waitFor();
	assert.ok(readFileSync(join(base, 'note.md'), 'utf8').includes('```python\nprint("slash")'));
	console.log('PASS slash insertion/save');
	await editor.locator('p').last().click();
	// Toolbar entry points still use the initiating button, independently of the caret.
	const button = page.locator('.wiki-insert-toolbar').getByRole('button', { name: '代码块', exact: true });
	const trigger = await button.boundingBox();
	await button.click();
	const popup = await page.locator('.wiki-code-popover').boundingBox();
	assert.ok(Math.abs(popup.x - trigger.x) < 2 && Math.abs(popup.y - trigger.y - trigger.height - 6) < 2);
	await page.locator('.wiki-code-popover').getByRole('option', { name: 'python', exact: false }).click();
	await page.keyboard.type('print("anchored")');
	await page.keyboard.press('Meta+s');
	await page.locator('.wiki-save-status.saved').waitFor();
	assert.ok(readFileSync(join(base, 'note.md'), 'utf8').includes('```python\nprint("anchored")'));
	console.log('PASS toolbar positioning and insertion/save');
	await page.screenshot({ path: '/tmp/pi-wiki-toolbar-full.png' });
	await page.setViewportSize({ width: 800, height: 900 });
	await page.locator('.wiki-chat-panel > header button[aria-label]').click();
	await toolbar.getByRole('button', { name: '提及日期', exact: true }).click();
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'toolbar does not widen the page');
	await toolbar.getByRole('button', { name: '代码块', exact: true }).click();
	const narrowPopup = await page.locator('.wiki-code-popover').boundingBox();
	assert.ok(narrowPopup.x >= 0 && narrowPopup.x + narrowPopup.width <= 800, 'scrolled toolbar picker remains inside viewport');
	await page.keyboard.press('Escape');
	await page.screenshot({ path: '/tmp/pi-wiki-toolbar-narrow.png' });
	console.log('PASS narrow toolbar scrolling and popup bounds');

} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(base, { recursive: true, force: true });
}
