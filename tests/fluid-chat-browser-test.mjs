import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';
const port=9249, root=mkdtempSync(join(tmpdir(),'pi-fluid-'));
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
	await page.routeWebSocket('**/ws', route=>{
		const upstream=route.connectToServer();
		route.onMessage(wire=>upstream.send(wire));
		upstream.onMessage(wire=>{
			const message=JSON.parse(wire.toString());
			if(message.type==='snapshot'||message.type==='snapshot_delta') {
				const timestamp=Date.now();
				message.state.messages=[
					{id:'question',role:'user',timestamp,content:[{type:'text',text:'整理这份技术文档，保留来源和待验证的结论。'}]},
					{id:'tools',role:'assistant',timestamp,content:[{type:'toolCall',id:'read-doc',name:'read',argumentsText:JSON.stringify({path:'README.md'})}]},
					{id:'result',role:'toolResult',timestamp,toolCallId:'read-doc',toolName:'read',content:[{type:'text',text:'# Project\n文档来源与版本信息'}]},
					{id:'reply',role:'assistant',timestamp,content:[{type:'text',text:'已完成原始资料检查，正在整理候选知识。\n\n### 来源与可信度\n\n每条结论都保留原始路径和适用版本。对于尚未交叉验证的内容，会在文档中明确标注。\n\n| 内容 | 处理方式 |\n| --- | --- |\n| 原文事实 | 保留引用位置 |\n| 推断结论 | 标记待验证 |\n\n下一步检查重复知识与版本冲突，再生成可复审的 Markdown 草稿。'}]},
				];
				message.state.taskProgress={id:'v2-task',conversationId:message.state.conversationId,sourceMessageId:'question',title:'整理知识文档',status:'waiting',startedAt:timestamp,completed:1,steps:[],plan:{revision:1,added:0,removed:0,items:['检查原始资料与来源','提取候选知识并交叉验证','生成可复审的 Markdown'].map((title,i)=>({id:`step-${i}`,title,status:i===0?'done':'pending'}))}};
			}
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://localhost:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	await page.locator('.workspace-group-manager input').fill('Engineering');
	await page.locator('.workspace-group-actions button[type=submit]').click();
	await page.locator('.workspace-outside button').click();
	await page.locator('.project-item.active').waitFor();
	await page.locator('.inputbox textarea').fill('继续检查来源引用和版本信息');
	assert.equal(await page.locator('.inputbox textarea').evaluate(el=>getComputedStyle(el).outlineStyle),'none');
	await page.locator('.task-section-count').first().waitFor();
	assert.equal(await page.locator('.task-section-count').first().textContent(),'1/3');
	const heading=page.locator('.task-section-heading').first();
	const section=await heading.getAttribute('aria-controls');
	assert(await page.locator(`[id="${section}"]`).count());
	await heading.click();
	assert.equal(await heading.getAttribute('aria-expanded'),'false');
	assert.equal(await page.locator('.task-section-count').first().textContent(),'1/3');
	await heading.focus();await page.keyboard.press('Enter');
	assert.equal(await heading.getAttribute('aria-expanded'),'true');
	for(const theme of ['light','dark']) {
		await page.evaluate(theme=>document.documentElement.dataset.appearance=theme,theme);
		await sleep(350);
		await page.screenshot({path:`tests/scratch/fluid-v2-${theme}.png`});
	}
	await page.setViewportSize({width:390,height:844});
	await sleep(350);
	assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
	assert(await page.locator('.inputbox').evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
	await page.screenshot({path:'tests/scratch/fluid-v2-mobile.png'});
	assert.deepEqual(errors,[]);
	await page.close();
	console.log('PASS fluid v2: real-content layout, composer focus, task counts, keyboard disclosure, themes and mobile overflow');
} finally { await browser?.close();server?.kill('SIGTERM');await sleep(300);rmSync(root,{recursive:true,force:true}); }
