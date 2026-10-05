// Real Chromium regression for slash aliases, heading levels and persisted selection colors.
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
	const failures = [], errors = [];
	page.on('pageerror', error => errors.push(error.message));
	const check = (condition, message) => { console.log(condition ? 'PASS' : 'FAIL', message); if (!condition) failures.push(message); };
	const aliases = [['zw', '正文'], ['zhengwen', '正文'], ['bg', '插入表格'], ['biaoge', '插入表格'], ['dmk', '代码块'], ['daimakuai', '代码块'], ['glk', '高亮块'], ['gaoliangkuai', '高亮块'], ['lb', '列表'], ['liebiao', '列表'], ['bh', '编号'], ['bianhao', '编号'], ['rw', '任务列表'], ['renwuliebiao', '任务列表'], ['yy', '引用'], ['yinyong', '引用'], ['fgx', '分隔线'], ['fengexian', '分隔线']];
	for (const [alias, label] of aliases) {
		await editor.locator('p').last().fill('');
		await page.keyboard.type(`/${alias}`);
		check(await page.getByRole('option', { name: label, exact: true }).count() === 1, `/${alias} matches ${label}`);
		await page.keyboard.press('Escape');
	}
	for (let level = 1; level <= 6; level++) {
		await editor.locator('p').last().fill('');
		await page.keyboard.type(`/bt${level}`);
		await page.getByRole('option', { name: `标题 ${level}`, exact: true }).click();
		await page.keyboard.type(`Heading ${level}`);
		check(await editor.locator(`h${level}`).last().textContent() === `Heading ${level}`, `H${level} inserts correct heading level`);
		await page.getByRole('toolbar', { name: '文档格式' }).getByRole('button', { name: '正文', exact: true }).click();
	}
	await editor.locator('p').last().fill('Before marked words after');
	const selectWords = async () => {
		await editor.locator('p').last().evaluate(p => {
			p.closest('[contenteditable]').focus();
			const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
			let node, start, end, offset = 0;
			while (node = walker.nextNode()) {
				if (!start && offset + node.length > 7) start = [node, 7 - offset];
				if (!end && offset + node.length >= 19) end = [node, 19 - offset];
				offset += node.length;
			}
			const range = document.createRange(); range.setStart(...start); range.setEnd(...end);
			getSelection().removeAllRanges(); getSelection().addRange(range);
		});
	};
	const yellow = page.getByRole('button', { name: '黄色背景', exact: true });
	await selectWords(); await yellow.click();
	check(await editor.locator('p').last().locator('span').evaluateAll(spans => spans.some(span => span.textContent === 'marked words' && span.style.backgroundColor === 'rgb(255, 243, 163)')), 'selection receives yellow background');
	await page.getByRole('button', { name: '撤销', exact: true }).click();
	check(await editor.locator('p').last().locator('span[style*="background-color"]').count() === 0, 'highlight supports native undo');
	await page.getByRole('button', { name: '重做', exact: true }).click();
	await page.locator('.wiki-toolbar-actions').getByRole('button', { name: '编辑源码', exact: true }).click();
	let source = await page.locator('.fp-editor').inputValue();
	check(source.includes('Before <mark style="background-color: #fff3a3">marked words</mark> after'), 'selected background persists as mark HTML');
	await page.locator('.wiki-toolbar-actions').getByRole('button', { name: '保存', exact: true }).click();
	for (let i = 0; i < 50 && readFileSync(join(base, 'note.md'), 'utf8') !== source; i++) await new Promise(r => setTimeout(r, 100));
	check(readFileSync(join(base, 'note.md'), 'utf8') === source, 'highlight saved to disk');
	await page.reload();
	await page.locator('.setup-modal .modal-close').click();
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	await editor.locator('p').last().waitFor();
	check(await editor.locator('p').last().locator('span').evaluateAll(spans => spans.some(span => span.style.backgroundColor === 'rgb(255, 243, 163)')), 'highlight survives reload');
	await selectWords(); await page.getByRole('button', { name: '蓝色背景', exact: true }).click();
	check(await editor.locator('p').last().locator('span').evaluateAll(spans => spans.some(span => span.style.backgroundColor === 'rgb(200, 228, 255)')), 'reopened highlight can change color');
	await selectWords(); await page.getByRole('button', { name: '清除背景标记', exact: true }).click();
	await page.locator('.wiki-toolbar-actions').getByRole('button', { name: '编辑源码', exact: true }).click();
	source = await page.locator('.fp-editor').inputValue();
	check(source.includes('Before marked words after') && !source.includes('<mark'), 'clear removes color without losing text');
	assert.deepEqual(errors, []);
	assert.deepEqual(failures, []);
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(base, { recursive: true, force: true });
}
