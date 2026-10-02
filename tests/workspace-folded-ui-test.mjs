import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';

const port=8994;
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
	await page.locator('.panel-right .panel-title').waitFor();
	await page.locator('.tree-filter', { hasText: /^(改动|Changes)(?:\s|$)/ }).waitFor({state:'detached'});
	assert.equal(await page.locator('.panel-right .panel-title').getByRole('button', { name: '文件', exact: true }).count(), 1);
	assert.equal(await page.locator('.panel-right .panel-title').getByRole('button', { name: '问题', exact: true }).count(), 1);
	assert.equal(await page.locator('.tree-filter', { hasText: /^(改动|Changes)(?:\s|$)/ }).count(),0);
	await page.locator('.time-gap').waitFor();
	assert.equal(await page.locator('.time-gap').count(),1);
	assert.equal(await page.getByText('本次对话涉及').count(),0);
	assert.equal(await page.locator('.conversation-files').count(),0);
	await page.locator('.status-branch-name', {hasText:'非 Git 仓库'}).waitFor();
	await page.locator('.msg-collapsed').first().waitFor();
	const widths=await page.evaluate(()=>Object.fromEntries(['.msg-collapsed','.msg','.inputbox'].map(s=>[s,document.querySelector(s).getBoundingClientRect().width])));
	assert.equal(widths['.msg-collapsed'],widths['.msg']);
	assert.equal(widths['.msg'],widths['.inputbox']);
	const marker=await page.evaluate(()=>{
		const rail=document.querySelector('.qn-rail').getBoundingClientRect();
		const pane=document.querySelector('.messages-wrap').getBoundingClientRect();
		return pane.right-rail.right;
	});
	assert(marker>=0 && marker<15,`question rail is ${marker}px from scrollbar edge`);
	const thinking=await page.locator('.thinking-toggle').evaluateAll(nodes=>nodes.slice(0,2).map(node=>{
		const icon=node.querySelector('svg').getBoundingClientRect();
		const label=node.querySelector('.thinking-label').getBoundingClientRect();
		return {iconCenter:icon.y+icon.height/2,labelCenter:label.y+label.height/2,labelX:label.x};
	}));
	assert.equal(thinking.length,2);
	assert(Math.abs(thinking[0].iconCenter-thinking[0].labelCenter)<2);
	assert(Math.abs(thinking[1].iconCenter-thinking[1].labelCenter)<2);
	assert(Math.abs(thinking[0].labelX-thinking[1].labelX)<1);
	assert.equal(await page.locator('.composer-hint').count(),0);
	await page.locator('.inputbox textarea').focus();
	await page.waitForTimeout(250);
	const emptyFocusBorder=await page.locator('.inputbox').evaluate(el=>getComputedStyle(el).borderColor);
	assert.equal(await page.locator('.composer-hint').count(),0);
	await page.locator('.inputbox textarea').evaluate(el=>el.blur());
	await page.waitForTimeout(250);
	const idleBorder=await page.locator('.inputbox').evaluate(el=>getComputedStyle(el).borderColor);
	const borderDifference=await page.evaluate(([a,b])=>{
		const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
		const context=canvas.getContext('2d');
		const rgb=color=>{context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3)};
		return Math.max(...rgb(a).map((value,index)=>Math.abs(value-rgb(b)[index])));
	},[emptyFocusBorder,idleBorder]);
	assert(borderDifference<=1,`empty focus changed the border by ${borderDifference}`);
	await page.locator('.inputbox textarea').focus();
	await page.locator('.inputbox textarea').fill('test');
	await page.waitForTimeout(250);
	assert.notEqual(await page.locator('.inputbox').evaluate(el=>getComputedStyle(el).borderColor),idleBorder);
	assert.equal(await page.locator('.msg-collapsed-role.role-assistant').first().evaluate(e=>getComputedStyle(e,'::before').content),'"π"');
	assert.equal(await page.locator('.msg-collapsed-action svg polyline').first().getAttribute('points'),'9 18 15 12 9 6');
	const foldedMeta = await page.locator('.msg-collapsed-role.role-assistant').first().locator('..').evaluate((row) => {
		const preview = row.querySelector('.msg-collapsed-preview').getBoundingClientRect();
		const chips = row.querySelector('.msg-collapsed-chips').getBoundingClientRect();
		return {previewBottom:preview.bottom, chipsTop:chips.top};
	});
	assert(foldedMeta.chipsTop >= foldedMeta.previewBottom, 'folded metadata sits below the message preview');
	const lines=page.locator('.bash-output-line');
	assert.equal(await lines.first().locator('.bash-line-number').textContent(),'15');
	assert.equal(await lines.nth(1).locator('.bash-line-number').textContent(),'27');
	await page.locator('.bash-output-lines.has-overflow').waitFor();
	assert((await page.locator('.bash-output-lines').first().evaluate(el=>getComputedStyle(el).maskImage)).includes('gradient'));
	await page.locator('.toolcall-bash').last().hover();
	await page.setViewportSize({width:1200,height:900});
	const bashHeader = await page.locator('.toolcall-bash').last().locator('.toolcall-head').evaluate((head) => ({height:head.getBoundingClientRect().height, labels:[...head.querySelectorAll('button')].map((button)=>({height:button.getBoundingClientRect().height, scrollWidth:button.scrollWidth, width:button.clientWidth}))}));
	assert(bashHeader.height <= 50 && bashHeader.labels.every((label)=>label.height <= 32 && label.scrollWidth <= label.width + 1), `bash actions stay on one line: ${JSON.stringify(bashHeader)}`);
	await page.setViewportSize({width:1600,height:900});
	const buttonAlignment=await page.evaluate(()=>{
		const center=s=>{const r=document.querySelector(s).getBoundingClientRect();return r.y+r.height/2};
		return Math.abs(center('.toolcall-bash .toolcall-wrap')-center('.toolcall-bash .toolcall-copy'));
	});
	assert(buttonAlignment<3,`command controls differ by ${buttonAlignment}px`);
	await page.locator('.messages').evaluate(el=>el.scrollTop=0);
	await page.locator('.scroll-bottom').waitFor();
	const bottom=await page.evaluate(()=>{
		const jump=document.querySelector('.scroll-bottom').getBoundingClientRect();
		const input=document.querySelector('.inputbox').getBoundingClientRect();
		return {edge:Math.abs(jump.right-input.right),gap:input.top-jump.bottom};
	});
	assert(bottom.edge<2 && bottom.gap>=0,JSON.stringify(bottom));
	await page.locator('.msg-collapsed').first().click();
	assert.equal(await page.locator('.msg-collapse-btn svg polyline').first().getAttribute('points'),'6 9 12 15 18 9');
	await page.locator('button[data-tree-node="AGENTS.md"]').click();
	await page.locator('.fp-markdown h1').waitFor();
	console.log('PASS non-Git state, shared widths, folded avatars and file tree preview');
} finally { await browser?.close();server?.kill('SIGTERM');await sleep(200); }
