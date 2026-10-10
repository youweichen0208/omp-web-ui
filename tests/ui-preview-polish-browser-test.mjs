import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';
const port=9262, root=mkdtempSync(join(tmpdir(),'pi-fluid-'));
const cwd=join(root,'pi-harness');mkdirSync(cwd);writeFileSync(join(cwd,'README.md'),'# Project\n');
writeFileSync(join(cwd,'sample.ts'),'export const ready = true;\n');
let server,browser;
try {
	assert.equal(await portUp(port),false);
	server=spawn(process.execPath,['dist/server/index.js'],{env:{...process.env,PORT:String(port),PI_WEB_CWD:cwd,PI_WEB_DATA_DIR:join(root,'data'),PI_CODING_AGENT_DIR:join(root,'agent')},stdio:'ignore'});
	for(let i=0;i<100&&!await portUp(port);i++)await sleep(150);
	assert(await portUp(port));
	browser=await chromium.launch({executablePath:CHROME_PATH});
	mkdirSync('tests/scratch',{recursive:true});
	const page=await browser.newPage({viewport:{width:1440,height:960}});
	const errors=[];page.on('pageerror',e=>errors.push(String(e)));
	await page.goto(`http://localhost:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	await page.locator('.workspace-group-manager input').fill('Engineering');
	await page.locator('.workspace-group-actions button[type=submit]').click();
	await page.locator('.workspace-outside button').click();
	await page.locator('.project-item.active').waitFor();
	await page.locator('[data-tree-node="sample.ts"]').click();
	const editor=page.locator('.fp-editor');await editor.waitFor();
	await editor.fill('export const ready = false;\n');
	await page.locator('.fp-header-save').click();
	await page.waitForFunction(()=>!document.querySelector('.fp-header-save'));
	assert.equal(readFileSync(join(cwd,'sample.ts'),'utf8'),'export const ready = false;\n');
	for(const width of [1440,1024,768,375]) {
		await page.setViewportSize({width,height:900});
		await sleep(350);
		if(width<=768) {
			const box=await editor.boundingBox();
			if(box.x>=width || box.x+box.width<=0) await page.locator('.topbar-actions > .panel-toggle').click();
		}
		for(const theme of ['light','dark']) {
			await page.evaluate(theme=>document.documentElement.dataset.appearance=theme,theme);await sleep(350);
			assert(await editor.isVisible());
			const box=await editor.boundingBox();assert(box.x<width && box.x+box.width>0,'editor intersects the viewport');
			assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
			await page.screenshot({path:`tests/scratch/polish-preview-${width}-${theme}.png`});
		}
	}
	await page.emulateMedia({reducedMotion:'reduce'});
	await page.setViewportSize({width:844,height:390});
	assert(await editor.isVisible());
	assert.deepEqual(errors,[]);
	console.log('PASS code preview: editing and disk save, three widths, light/dark, landscape and reduced motion');
} finally { await browser?.close();server?.kill('SIGTERM');await sleep(300);rmSync(root,{recursive:true,force:true}); }
