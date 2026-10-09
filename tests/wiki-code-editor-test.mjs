// Real Chromium regression for new fenced-code editing, line breaks and /dmk.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
const port = 8999, base = mkdtempSync(join(tmpdir(), 'wiki-code-editor-'));
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
	await page.waitForFunction(() => [...(CSS.highlights.get('rich-code-keyword') ?? [])].some(range => range.toString() === 'public'));
	const failures = [], errors = [];
	page.on('pageerror', error => errors.push(error.message));
	const check = (condition, message) => { console.log(condition ? 'PASS' : 'FAIL', message); if (!condition) failures.push(message); };
	await editor.locator('p').last().fill('');
	await page.keyboard.type('/dmk');
	check(await page.getByRole('option', { name: '代码块', exact: true }).count() === 1, '/dmk matches code block');
	await editor.locator('p').last().fill('');
	await page.keyboard.type('/code');
	await page.getByRole('option', { name: '代码块', exact: true }).waitFor();
	await page.keyboard.press('Enter');
	await editor.locator('select[data-code-language]').last().selectOption('java');
	await page.keyboard.type('public class Demo {');
	check(await editor.locator('pre').last().locator('code').evaluate(code => {
		const ranges = CSS.highlights?.get('rich-code-keyword');
		return [...(ranges ?? [])].some(range => code.contains(range.startContainer) && range.toString() === 'public')
			&& getComputedStyle(code, '::highlight(rich-code-keyword)').color !== getComputedStyle(code).color;
	}), 'new Java code highlights while typing');
	const caret = () => page.evaluate(() => {
		const range = getSelection().getRangeAt(0), rect = range.getBoundingClientRect();
		const node = range.startContainer, code = (node.nodeType === 1 ? node : node.parentElement).closest('code');
		return { y: rect.y, lineHeight: parseFloat(getComputedStyle(code).lineHeight) };
	});
	const before = await caret();
	await page.keyboard.press('Enter');
	await page.keyboard.type('x');
	const after = await caret();
	const delta = after.y - before.y;
	console.log('line geometry', { delta, lineHeight: before.lineHeight, html: await editor.locator('pre code').last().innerHTML() });
	check(Math.abs(delta - before.lineHeight) < 2, 'Enter advances exactly one line');
	await page.keyboard.press('Enter');
	await page.keyboard.press('Enter');
	await page.keyboard.type('return 1;');
	const code = editor.locator('pre').last().locator('code');
	check(await code.count() === 1, 'consecutive Enter keeps a single code element');
	const edited = await code.innerHTML();
	await page.evaluate(() => document.execCommand('undo'));
	check(await code.innerHTML() !== edited, 'native undo still edits highlighted code');
	await page.evaluate(() => document.execCommand('redo'));
	check(await code.innerHTML() === edited, 'native redo restores highlighted code');
	check(await code.evaluate(code => [...(CSS.highlights.get('rich-code-keyword') ?? [])].some(range => code.contains(range.startContainer) && range.toString() === 'return')), 'highlight offsets survive blank lines and redo');
	await page.locator('.wiki-toolbar-actions').getByRole('button', { name: '编辑源码', exact: true }).click();
	const source = await page.locator('.fp-editor').inputValue();
	check(source.includes('public class Demo {\nx\n\nreturn 1;'), 'saved Markdown retains exactly one newline');
	await page.keyboard.press('Meta+s');
	for (let i = 0; i < 50 && readFileSync(join(base, 'note.md'), 'utf8') !== source; i++) await new Promise(r => setTimeout(r, 100));
	check(readFileSync(join(base, 'note.md'), 'utf8') === source, 'disk save preserves edited code and blank lines');
	check(source.includes('```java\npublic class Original {}\n```'), 'existing untouched code remains unchanged');
	assert.deepEqual(errors, []);
	assert.deepEqual(failures, []);
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(base, { recursive: true, force: true });
}
