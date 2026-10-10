import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';
const port=9260, root=mkdtempSync(join(tmpdir(),'pi-fluid-'));
const cwd=join(root,'pi-harness');mkdirSync(cwd);writeFileSync(join(cwd,'README.md'),'# Project\n');
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
	const settings=page.locator('#sidebar-settings-slot .dropdown > button');
	await settings.click();
	await page.locator('.workspace-settings-menu .dd-item').first().click();
	const modal=page.locator('.settings-modal');
	await modal.waitFor();
	await sleep(100);
	assert(await modal.evaluate(el=>el.contains(document.activeElement)), 'opening settings moves keyboard focus inside');
	const last=modal.locator('button:visible').last();await last.focus();
	await page.keyboard.press('Tab');
	assert(await modal.evaluate(el=>el.contains(document.activeElement)), 'Tab stays in the dialog');
	await modal.locator('.modal-head button').focus();
	await page.keyboard.press('Shift+Tab');
	assert(await modal.evaluate(el=>el.contains(document.activeElement)), 'Shift+Tab stays in the dialog');
	for(const width of [1440,768,375]) {
		await page.setViewportSize({width,height:900});
		for(const theme of ['light','dark']) {
			await page.evaluate(theme=>document.documentElement.dataset.appearance=theme,theme);
			for(const index of [0,1,2,3,4]) {
				const tab=modal.locator('.settings-tab').nth(index);
				await tab.click();
				assert.equal(await tab.getAttribute('aria-current'),'page');
				assert(await tab.locator('.settings-tab-label').isVisible());
				await sleep(350);
				assert(await modal.evaluate(el=>el.getBoundingClientRect().right<=innerWidth+1));
				await page.screenshot({path:`tests/scratch/polish-settings-${index}-${width}-${theme}.png`});
			}
		}
	}
	await page.setViewportSize({width:1440,height:900});
	await modal.locator('.modal-head button').click();
	assert(await settings.evaluate(el=>document.activeElement===el), 'closing restores opener focus');
	await page.locator('.tree-search').click();
	await page.locator('.gs-input-row input').waitFor();
	await page.keyboard.press('Shift+Tab');
	assert(await page.locator('.gs-modal').evaluate(el=>el.contains(document.activeElement)));
	await page.locator('.gs-close').click();
	assert(await page.locator('.tree-search').evaluate(el=>document.activeElement===el));
	assert.deepEqual(errors,[]);
	console.log('PASS polish dialogs: focus entry, tab boundaries, opener restoration, settings pages at 375/768/1440 light/dark');
} finally { await browser?.close();server?.kill('SIGTERM');await sleep(300);rmSync(root,{recursive:true,force:true}); }
