import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
const port=9198; assert.equal(await portUp(port),false);
const root=mkdtempSync(join(tmpdir(),'pi-one-ui-'));
const server=spawn(process.execPath,['dist/server/index.js'],{env:{...process.env,PORT:String(port),PI_WEB_TOKEN:'',PI_WEB_CWD:root,PI_WEB_DATA_DIR:join(root,'data'),PI_CODING_AGENT_DIR:join(root,'agent')},stdio:'ignore'});
let browser;
try {
	for(let i=0;i<100;i++){if(await portUp(port)) break; await new Promise(r=>setTimeout(r,100));}
	browser=await chromium.launch({executablePath:CHROME_PATH || chromium.executablePath()});
	for(const locale of ['zh','en']) {
		const page=await browser.newPage({viewport:{width:900,height:800}}),errors=[];
		page.on('pageerror',error=>errors.push(error.message));
		await page.addInitScript(locale=>{localStorage.setItem('pi-web-ui:lang',locale);window.electronAPI={platform:'darwin',windowAction(){},onWindowState(){return()=>{};}};},locale);
		await page.routeWebSocket('**/ws', route => { const upstream=route.connectToServer(); route.onMessage(m=>upstream.send(m)); upstream.onMessage(wire=>{ const message=JSON.parse(wire.toString()); if(message.type==='snapshot'||message.type==='snapshot_delta') message.state.piConfigured=true; route.send(JSON.stringify(message)); }); });
		await page.goto(`http://127.0.0.1:${port}`); await page.waitForTimeout(600);
		assert.equal(await page.getByRole('tab',{name:locale==='zh'?'生图':'Images',exact:true}).count(),0);
		await page.getByRole('button',{name:locale==='zh'?'设置':'Settings',exact:true}).first().click();
		await page.getByText(locale==='zh'?'所有设置':'All settings',{exact:true}).click();
		await page.getByText(locale==='zh'?'MCP 与 Codemode':'MCP & Codemode',{exact:true}).first().click();
		await page.getByRole('button',{name:locale==='zh'?'+ 新建服务':'+ New server',exact:true}).click();
		await page.locator('.mcp-editor input').fill(`fixture-${locale}`);
		await page.locator('.mcp-editor textarea').fill(JSON.stringify({command:'echo',enabled:false}));
		await page.locator('.mcp-editor').getByRole('button',{name:locale==='zh'?'更新配置草稿':'Update draft'}).click();
		await page.locator('.mcp-save-row').getByRole('button',{name:locale==='zh'?'保存并应用':'Save and apply'}).click();
		await page.waitForFunction(() => document.querySelector('.mcp-save-row button')?.disabled);
		await page.locator('.mcp-server-toggle strong').filter({hasText:`fixture-${locale}`}).waitFor();
		assert(!await page.locator('.native-mcp-panel [role="alert"]').count(),(await page.locator('.native-mcp-panel [role="alert"]').allTextContents()).join('; '));
		await page.screenshot({path:`tests/scratch/codemode-mcp-${locale}.png`,fullPage:true});
		assert.deepEqual(errors,[]); await page.close();
	}
	console.log('PASS Chinese/English native MCP views without the image-generation tab, keyboard fields and desktop narrow viewport');
} finally {await browser?.close();const exited=once(server,'exit');server.kill();await exited;rmSync(root,{recursive:true,force:true});}
