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
	let wire,conversationId;const responses=[];
	await page.routeWebSocket('**/ws', route => {
		wire=route;const upstream=route.connectToServer();
		upstream.onMessage(raw=>{const message=JSON.parse(String(raw));if(message.type==='snapshot')conversationId=message.state.conversationId;route.send(raw);});
		route.onMessage(raw=>{const message=JSON.parse(String(raw));if(message.type==='dialog_response'){responses.push(message);route.send(JSON.stringify({type:'dialog_closed',id:message.id,conversationId:message.conversationId}));}else upstream.send(raw);});
	});
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
	for(const requestId of ['auth-one','auth-two']) {
		wire.send(JSON.stringify({type:'provider_auth',state:{requestId,provider:'fixture',phase:'error',message:'Local authentication fixture'}}));
		const auth=page.locator('.provider-auth-modal');await auth.waitFor();
		await auth.locator('.modal-actions button').focus();await page.keyboard.press('Tab');
		assert(await auth.evaluate(el=>el.contains(document.activeElement)));
		await page.keyboard.press('Escape');await auth.waitFor({state:'detached'});
		assert(await modal.isVisible(),'Escape closes only the top dialog');
		assert(await modal.evaluate(el=>el.contains(document.activeElement)));
	}
	const last=modal.locator('button:visible').last();await last.focus();
	await page.keyboard.press('Tab');
	assert(await modal.evaluate(el=>el.contains(document.activeElement)), 'Tab stays in the dialog');
	await modal.locator('.modal-head button').focus();
	await page.keyboard.press('Shift+Tab');
	assert(await modal.evaluate(el=>el.contains(document.activeElement)), 'Shift+Tab stays in the dialog');
	for(const width of [1440,1024,768,375]) {
		await page.setViewportSize({width,height:900});
		for(const theme of ['light','dark']) {
			await page.evaluate(theme=>document.documentElement.dataset.appearance=theme,theme);
			const contrasts=await page.evaluate(()=>{
				const probe=document.createElement('span');document.body.append(probe);
				const ctx=document.createElement('canvas').getContext('2d');
				const luminance=token=>{probe.style.color=`var(${token})`;ctx.fillStyle=getComputedStyle(probe).color;ctx.fillRect(0,0,1,1);const rgb=[...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
				const results=[];for(const bg of ['--bg','--bg-elev'])for(const fg of ['--text','--text-dim','--text-faint']){const a=luminance(bg),b=luminance(fg);results.push({bg,fg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});}probe.remove();return results;
			});
			for(const result of contrasts)assert(result.ratio>=4.5,`${theme} ${result.fg}/${result.bg} contrast ${result.ratio}`);
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
	await page.emulateMedia({reducedMotion:'reduce'});
	await page.setViewportSize({width:844,height:390});
	await page.evaluate(()=>document.documentElement.style.fontSize='20px');
	assert(await modal.locator('.modal-head button').isVisible());
	assert(await modal.evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight));
	await page.screenshot({path:'tests/scratch/polish-settings-landscape-scaled.png'});
	await page.evaluate(()=>document.documentElement.style.fontSize='');
	await page.setViewportSize({width:1440,height:900});
	await modal.locator('.modal-head button').click();
	assert(await settings.evaluate(el=>document.activeElement===el), 'closing restores opener focus');
	await page.locator('.tree-search').click();
	await page.locator('.gs-input-row input').waitFor();
	await page.keyboard.press('Shift+Tab');
	assert(await page.locator('.gs-modal').evaluate(el=>el.contains(document.activeElement)));
	await page.locator('.gs-close').click();
	assert(await page.locator('.tree-search').evaluate(el=>document.activeElement===el));
	for(const kind of ['select','confirm','input','editor']) {
		wire.send(JSON.stringify({type:'dialog',conversationId,source:'fixture',id:kind,kind,title:'Local request',args:kind==='select'?[['First','Second']]:['Initial text']}));
		const panel=page.locator('.dialog-inline');await panel.waitFor();
		assert.equal(await panel.getAttribute('role'),'region');
		if(kind==='input'||kind==='editor') {
			await panel.getByRole('textbox',{name:'Local request'}).fill(kind==='editor'?'Line one\nLine two':'Answer');
			await panel.getByRole('button',{name:'确定',exact:true}).focus();await page.keyboard.press('Enter');
		} else if(kind==='select') {await panel.getByRole('button',{name:'Second',exact:true}).focus();await page.keyboard.press('Enter');}
		else {await panel.getByRole('button',{name:'确定',exact:true}).focus();await page.keyboard.press('Enter');}
		await panel.waitFor({state:'detached'});
		assert.equal(responses.at(-1).value,{select:'Second',confirm:true,input:'Answer',editor:'Line one\nLine two'}[kind]);
		assert.equal(responses.at(-1).conversationId,conversationId);
	}
	assert.deepEqual(errors,[]);
	console.log('PASS polish dialogs: focus entry, tab boundaries, opener restoration, settings pages at 375/768/1024/1440 light/dark');
} finally { await browser?.close();server?.kill('SIGTERM');await sleep(300);rmSync(root,{recursive:true,force:true}); }
