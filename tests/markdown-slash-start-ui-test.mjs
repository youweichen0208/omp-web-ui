import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';
const base=mkdtempSync(join(tmpdir(),'pi-slash-start-'));
const port=8994;
writeFileSync(join(base,'note.md'),'# Highlight test\n\nOriginal paragraph.\n');
let server,browser;
try {
	assert.equal(await portUp(port),false);
	server=spawn(process.execPath,['dist/server/index.js'],{env:{...process.env,PORT:String(port),PI_WEB_CWD:base,PI_WEB_DATA_DIR:join(base,'data'),PI_CODING_AGENT_DIR:join(base,'agent')},stdio:'ignore'});
	for(let i=0;i<100&&!await portUp(port);i++) await sleep(100);
	browser=await chromium.launch({executablePath:CHROME_PATH});
	const page=await browser.newPage({viewport:{width:1440,height:950}});
	await page.goto(`http://localhost:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	await page.locator('.file-name',{hasText:'note.md'}).click();
	await page.locator('.fp-more').evaluate(e=>e.open=true);
	await page.locator('.fp-more-actions').getByRole('button',{name:'编辑文件'}).click();
	const editor=page.locator('.fp-rich-document');
	const menu=page.locator('.fp-slash-menu');
	for (const prefix of ['正文', '正文 ', '正文，', 'path/to', ' ', '1. ', '2. ', '3. ', '* ', '*']) {
		await editor.fill(prefix);
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.type('/table');
		assert.equal(await menu.count(),0,`must stay literal after ${JSON.stringify(prefix)}`);
		assert.equal((await editor.innerText()).replace(/\u00a0/g,' '),prefix+'/table');
	}
	await editor.evaluate(root=>{
		root.innerHTML='<p><strong>加粗前文</strong><span></span></p>';
		const text=document.createTextNode('');root.querySelector('span').append(text);
		const range=document.createRange();range.setStart(text,0);range.collapse(true);
		const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
	});
	await page.keyboard.type('/table');
	assert.equal(await menu.count(),0,'a new inline text node is not a paragraph start');
	assert.equal(await editor.innerText(),'加粗前文/table');
	for (const tag of ['ol', 'ul']) {
		await editor.evaluate((root, tag)=>{
			root.replaceChildren();
			const list=document.createElement(tag),li=document.createElement('li');
			const text=document.createTextNode('');li.append(text);list.append(li);root.append(list);
			const range=document.createRange();range.setStart(text,0);range.collapse(true);
			const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
		},tag);
		await page.keyboard.type('/table');
		assert.equal(await menu.count(),0,`no slash menu inside ${tag}`);
		assert.equal(await editor.locator('li').innerText(),'/table');
	}
	await editor.evaluate(root=>{root.innerHTML='<p><br></p>';});
	await editor.fill('前一段');
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.press('Enter');
	await page.keyboard.type('/table');
	await page.getByRole('option',{name:'插入表格',exact:true}).waitFor({timeout:2000});
	await page.keyboard.press('Enter');
	assert.equal(await editor.locator('table').count(),1);
	await editor.fill('');
	await page.keyboard.type('/');
	await menu.waitFor();
	await page.keyboard.press('Escape');
	assert.equal(await menu.count(),0);
	assert.equal(await editor.innerText(),'/');
	console.log('PASS slash triggers only at block start, mid-text/spaces/punctuation/format boundaries stay literal, new paragraph inserts table, Escape preserves slash');

} finally {
	await browser?.close();
	server?.kill('SIGTERM');
}
