import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';

const port=9245;
const root=mkdtempSync(join(tmpdir(),'folded-ui-'));
const cwd=join(root,'notes');mkdirSync(cwd);mkdirSync(join(cwd,'docs'));
writeFileSync(join(cwd,'AGENTS.md'),'# Guide\n');
writeFileSync(join(cwd,'docs/spec.md'),'# Spec\n');
const timestamp=Date.now();
const earlier=timestamp-2*60*60*1000;
const messages=[
	...Array.from({length:34},(_,i)=>({id:`old-${i}`,role:i%2?'assistant':'user',timestamp:earlier,content:[{type:'text',text:`历史消息 ${i}`},...(i===1?[{type:'thinking',thinking:'分析文件'}]:[])]})),
	{id:'q',role:'user',timestamp,content:[{type:'text',text:'查看两个文件'}]},
	{id:'read',role:'assistant',timestamp,model:'glm-5.3',content:[{type:'thinking',thinking:'先看文件'},{type:'thinking',thinking:'再看结果',durationMs:2000},{type:'toolCall',id:'r',name:'read',argumentsText:JSON.stringify({path:'AGENTS.md'})},{type:'toolCall',id:'b',name:'bash',argumentsText:JSON.stringify({command:'grep -n pattern docs/spec.md'})},{type:'toolCall',id:'sed',name:'bash',argumentsText:JSON.stringify({command:"sed -n '35,50p' youwei_core/ledger/monthly.py"})}]},
	{id:'result',role:'toolResult',timestamp,toolCallId:'b',toolName:'bash',content:[{type:'text',text:`15: ${'很长的匹配内容'.repeat(40)}\n27: 匹配二\n`}]},
	{id:'sed-result',role:'toolResult',timestamp,toolCallId:'sed',toolName:'bash',content:[{type:'text',text:Array.from({length:16},(_,i)=>`source line ${i+35}`).join('\n')}]},
	{id:'answer',role:'assistant',timestamp,content:[{type:'text',text:'已经查看。'}]},
];
let server,browser;
try {
	assert.equal(await portUp(port),false);
	server=spawn(process.execPath,['dist/server/index.js'],{env:{...process.env,PORT:String(port),PI_WEB_CWD:cwd,PI_WEB_DATA_DIR:join(root,'data'),PI_CODING_AGENT_DIR:join(root,'agent')},stdio:['ignore','pipe','pipe']});
	let log='';server.stderr.on('data',chunk=>log+=chunk);
	for(let i=0;i<80&&!await portUp(port);i++)await sleep(250);
	assert(await portUp(port),log);
	browser=await chromium.launch({executablePath:CHROME_PATH});
	const page=await browser.newPage({viewport:{width:1600,height:900}});
	await page.routeWebSocket('**/ws',route=>{
		const upstream=route.connectToServer();
		route.onMessage(wire=>upstream.send(wire));
		upstream.onMessage(wire=>{
			const message=JSON.parse(wire.toString());
			if(message.type==='snapshot')Object.assign(message.state,{messages,piConfigured:true,model:{id:'glm-5.3',name:'GLM 5.3',provider:'volc-glm'}});
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://localhost:${port}`);
	await page.locator('.msg-collapsed').first().waitFor();
	if (await page.locator('.setup-modal .modal-close').count()) await page.locator('.setup-modal .modal-close').click();
	await page.locator('.messages').evaluate(el => el.scrollTop = 0);
	const row = page.locator('.msg-collapsed[data-msg-id="old-1"]');
	await row.waitFor();
	assert.equal(await row.locator('.msg-collapsed-chips').count(), 0);
	assert((await row.getAttribute('title')).includes('思考'));
	assert((await row.boundingBox()).height <= 30);
	assert.equal(await row.getAttribute('aria-expanded'), 'false');
	await row.focus();
	await page.keyboard.press('Enter');
	await page.locator('.msg[data-msg-id="old-1"]').waitFor();
	assert.equal(await page.locator('.msg[data-msg-id="old-1"] .thinking-toggle').count(), 1);
	await page.locator('.msg[data-msg-id="old-1"] .msg-collapse-btn').click();
	await row.waitFor();
	mkdirSync('tests/scratch', {recursive:true});
	await page.screenshot({path:'tests/scratch/chat-history-55.png'});
	await page.setViewportSize({width:390,height:844});
	await page.locator('.messages').evaluate(el => el.scrollTop = 0);
	assert((await row.boundingBox()).height <= 30);
	assert(await row.evaluate(el => el.scrollWidth <= el.clientWidth));
	await row.click();
	await page.locator('.msg[data-msg-id="old-1"]').waitFor();
	console.log('PASS compact history: single line, statistics tooltip, keyboard/touch expansion, narrow layout');
} finally { await browser?.close();server?.kill('SIGTERM');await sleep(200); }
