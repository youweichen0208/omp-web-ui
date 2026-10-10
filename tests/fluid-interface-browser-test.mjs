import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';
const port=9248, root=mkdtempSync(join(tmpdir(),'pi-fluid-'));
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
	const resize=page.locator('.resize-left');
	const before=await page.locator('.panel-left').evaluate(el=>el.getBoundingClientRect().width);
	await resize.focus(); await page.keyboard.press('ArrowRight');
	assert.equal(Math.round(await page.locator('.panel-left').evaluate(el=>el.getBoundingClientRect().width)),Math.round(before+16));
	await page.locator('.inputbox textarea').focus();
	await page.screenshot({path:'tests/scratch/fluid-web-light.png'});
	await page.evaluate(()=>document.documentElement.dataset.appearance='dark');
	await sleep(300);
	await page.screenshot({path:'tests/scratch/fluid-web-dark.png'});
	await page.evaluate(()=>document.documentElement.dataset.appearance='light');
	await page.setViewportSize({width:390,height:844});
	const toggle=page.locator('.topbar .brand .panel-toggle');
	const drawer=page.locator('.drawer-left');
	await page.waitForFunction(()=>document.querySelector(".drawer-left").inert);
	await toggle.click();
	await page.waitForFunction(()=>Math.abs(document.querySelector('.drawer-left').getBoundingClientRect().x)<1);
	assert.equal(await drawer.evaluate(el=>el.inert),false);
	assert(await drawer.locator('.fluid-drawer-close').evaluate(el=>el===document.activeElement));
	// A real pointer drag follows the pointer, then release momentum dismisses.
	const grip=await drawer.locator('.fluid-drawer-grip').boundingBox();
	await page.mouse.move(grip.x+160,grip.y+20);await page.mouse.down();
	await page.mouse.move(grip.x+75,grip.y+20,{steps:5});
	const dragged=await drawer.boundingBox();assert(dragged.x < -60 && dragged.x > -100);
	await page.mouse.up();
	await page.waitForFunction(()=>document.querySelector('.drawer-left').inert);
	await toggle.click();
	await page.waitForFunction(()=>Math.abs(document.querySelector('.drawer-left').getBoundingClientRect().x)<1);
	await page.mouse.move(grip.x+160,grip.y+20);await page.mouse.down();
	await page.mouse.move(grip.x+100,grip.y+20,{steps:3});
	await drawer.locator('.fluid-drawer-grip').dispatchEvent('pointercancel',{pointerId:1});
	await page.mouse.up();
	await page.waitForFunction(()=>Math.abs(document.querySelector('.drawer-left').getBoundingClientRect().x)<1);
	await page.screenshot({path:'tests/scratch/fluid-mobile.png'});
	await page.keyboard.press('Escape');
	await page.waitForFunction(()=>document.querySelector('.drawer-left').inert);
	assert(await toggle.evaluate(el=>el===document.activeElement));
	// Interrupt a closing spring with an immediate reopen, without waiting for transitionend.
	await toggle.click(); await sleep(70);
	await drawer.locator('.fluid-drawer-close').evaluate(el=>el.click());
	await sleep(30);
	const closingX=await drawer.evaluate(el=>el.getBoundingClientRect().x);
	await toggle.evaluate(el=>el.click());
	const reopenedX=await drawer.evaluate(el=>el.getBoundingClientRect().x);
	assert(Math.abs(reopenedX-closingX)<65, 'reopening does not snap to the closed endpoint');
	await page.waitForFunction(()=>Math.abs(document.querySelector('.drawer-left').getBoundingClientRect().x)<1);
	await page.emulateMedia({reducedMotion:'reduce'});
	await drawer.locator('.fluid-drawer-close').click();
	assert(await drawer.evaluate(el=>el.inert));
	await toggle.click();
	assert(Math.abs((await drawer.boundingBox()).x)<1);
	await page.emulateMedia({contrast:'more'});
	assert.equal(await drawer.evaluate(el=>getComputedStyle(el).backdropFilter),'none');
	assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
	assert.deepEqual(errors,[]);
	await page.close();
	// Desktop shell geometry: titlebar controls stay outside the navigation hit area.
	for(const platform of ['darwin','win32']) {
		const desktop=await browser.newPage({viewport:{width:1100,height:850}});
		await desktop.addInitScript(platform=>{window.electronAPI={platform,windowAction(){},onWindowState(){return()=>{};}};},platform);
		await desktop.goto(`http://localhost:${port}`);
		await desktop.locator('.setup-modal .modal-close').click();
		const controls=desktop.locator('.desktop-window-controls');
		if(platform==='win32') {
			const c=await controls.boundingBox(), a=await desktop.locator('.topbar-actions').boundingBox();
			assert(a.x+a.width<=c.x+1);
		}
		await desktop.screenshot({path:`tests/scratch/fluid-desktop-${platform}.png`});
		await desktop.close();
	}
	console.log('PASS fluid interface: Web light/dark, keyboard resize, pointer tracking, momentum, interruption, focus restoration, reduced motion, contrast and desktop shells');
} finally { await browser?.close();server?.kill('SIGTERM');await sleep(300);rmSync(root,{recursive:true,force:true}); }
