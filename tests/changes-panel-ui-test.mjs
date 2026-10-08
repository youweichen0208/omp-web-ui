/** 35a: real browser + isolated Git repository, deterministic SDK transcript. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
const port = 8999;
assert.equal(await portUp(port), false, `Port ${port} busy`);
const root = mkdtempSync(join(tmpdir(), 'pi-changes-'));
const cwd = join(root, 'workspace'); mkdirSync(cwd);
const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
writeFileSync(join(cwd, 'app.ts'), Array.from({length: 120}, (_, n) => `const value${n} = "old";`).join('\n')+'\n'); git('add', '.'); git('commit', '-m', 'initial');
git('checkout', '-b', 'feature');
writeFileSync(join(cwd, 'app.ts'), Array.from({length: 120}, (_, n) => `const value${n} = "${n === 5 || n === 25 ? 'new' : 'old'}";`).join('\n')+'\n'); git('commit', '-am', 'edit');
writeFileSync(join(cwd, 'untracked.txt'), 'new file\n');
const messages = [
	{ id:'user', role:'user', content:[{type:'text',text:'Update the application'}] },
	{ id:'intro', role:'assistant', content:[{type:'text',text:'先检查应用配置。'}] },
	{ id:'cmd', role:'assistant', content:[{type:'toolCall',id:'bash1',name:'bash',argumentsText:JSON.stringify({command:'git status --short'})}] },
	{ id:'cmd-result', role:'toolResult',toolCallId:'bash1',content:[{type:'text',text:'app.ts'}] },
	{ id:'edit',role:'assistant',content:[{type:'toolCall',id:'edit1',name:'edit',argumentsText:JSON.stringify({path:'app.ts',oldText:'const value5 = "old";',newText:'const value5 = "new";'})}] },
	{ id:'edit-result',role:'toolResult',toolCallId:'edit1',details:{diff:'-6 const value5 = "old";\n+6 const value5 = "new";',firstChangedLine:6},content:[] },
	{ id:'answer',role:'assistant',timestamp:Date.now(),content:[{type:'text',text:'Updated the configuration in app.ts.'}] },
];
let server, browser, snapshot, socket, upstreamSocket, forceNotRepo = false, terminalReady = false, regenerated;
try {
	server = spawn(process.execPath,['dist/server/index.js'],{env:{...process.env,PORT:String(port),PI_WEB_CWD:cwd,PI_WEB_DATA_DIR:join(root,'data'),PI_CODING_AGENT_DIR:join(root,'agent')},stdio:['ignore','pipe','pipe']});
	let log=''; server.stdout.on('data', data=>log+=data); server.stderr.on('data',data=>log+=data);
	for(let n=0;n<100&&!await portUp(port);n++) await sleep(100); assert(await portUp(port),log);
	browser=await chromium.launch({executablePath:CHROME_PATH});
	const page=await browser.newPage({viewport:{width:1440,height:1000}}); page.setDefaultTimeout(10000);
	const errors=[]; page.on('pageerror',error=>errors.push(error.message));
	await page.routeWebSocket('**/ws',route=>{
		socket = route; const upstream=route.connectToServer(); upstreamSocket = upstream; route.onMessage(wire=>{ const message = JSON.parse(String(wire)); if (message.type === 'edit_message') { regenerated = message; return; } upstream.send(wire); });
		upstream.onMessage(wire=>{
			const msg=JSON.parse(String(wire));
			if(msg.type==='snapshot') Object.assign(msg.state,{messages,piConfigured:true,isStreaming:false,taskProgress:{id:'task',conversationId:msg.state.conversationId,sourceMessageId:'user',title:'Update',status:'done',startedAt:1,completed:1,steps:[{id:'step',messageId:'edit',title:'Edit',status:'done',startedAt:1,artifacts:[{toolCallId:'edit1',kind:'edit',path:'app.ts',label:'app.ts'}]}]}});
			if (msg.type === 'terminal_list' && msg.terminals.some(item => item.id === 'changes-fixture')) terminalReady = true;
			if (msg.type === 'snapshot') snapshot = structuredClone(msg);
			if (forceNotRepo && msg.type === 'scm_data' && msg.kind === 'status') Object.assign(msg, { notRepo: true, files: [], branches: [] });
			if(msg.type!=='snapshot_delta') route.send(JSON.stringify(msg));
		});
	});
	await page.goto(`http://localhost:${port}`);
	await page.locator('.change-summary').waitFor();
	assert.equal(await page.locator('.change-card').count(),0);
	assert.equal(await page.locator('.bash-group.historical-step').count(),1);
	assert.match(await page.locator('.bash-group-head').textContent(),/先检查应用配置/);
	await page.locator('.bash-group-head').click(); assert.equal(await page.locator('.bash-row').count(),1);
	await page.locator('.change-summary-file').click();
	await page.locator('.changes-line mark').first().waitFor();
	assert.equal(await page.locator('.change-summary-file.selected').count(),1);
	await page.locator('.app.left-collapsed').waitFor();
	let box=await page.locator('.changes-panel').boundingBox(); assert.equal(box.x,600); assert.equal(box.width,840);
	await page.locator('.changes-panel').getByRole('button',{name:'文件列表',exact:true}).click();
	assert.equal(await page.locator('.changes-files .selected').count(),1);
	await page.getByRole('button',{name:'整个分支',exact:true}).click();
	await page.locator('.changes-gap').first().waitFor();
	assert.equal(await page.locator('.changes-line.add').count(),2);
	await page.locator('.changes-gap').first().click();
	assert((await page.locator('.changes-line.context').count())>10);
	while (await page.locator('.changes-gap').count()) await page.locator('.changes-gap').first().click();
	await page.locator('.changes-diffs').evaluate(el=>el.scrollTop=0);
	await page.locator('.changes-panel').focus(); await page.keyboard.press('j'); await page.keyboard.press('j');
	const afterNext = await page.locator('.changes-diffs').evaluate(el=>el.scrollTop); assert(afterNext > 0);
	await page.keyboard.press('k'); assert((await page.locator('.changes-diffs').evaluate(el=>el.scrollTop)) < afterNext);
	await page.getByRole('button',{name:'未提交',exact:true}).click();
	await page.locator('.changes-file-head code',{hasText:'untracked.txt'}).waitFor();
	await page.getByRole('button',{name:'在改动里搜索',exact:true}).click();
	await page.getByRole('textbox',{name:'在改动里搜索',exact:true}).fill('missing-query');
	assert.equal(await page.locator('.changes-file').count(),0);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	assert(await page.locator('.inputbox textarea').evaluate(el => el === document.activeElement));
	await page.getByRole('button',{name:'本轮',exact:true}).click();
	await page.locator('.changes-line mark').first().waitFor();
	await page.screenshot({path:'/tmp/pi-changes-35a-wide.png'});
	await page.setViewportSize({width:1100,height:850});
	box=await page.locator('.changes-panel').boundingBox(); assert.equal(box.width,720); assert.equal(box.x,380);
	await page.screenshot({path:'/tmp/pi-changes-35a-drawer.png'});
	await page.setViewportSize({width:1440,height:1000});
	await page.keyboard.press('Meta+d'); await page.locator('.changes-panel').waitFor({state:'detached'});
	await page.locator('.app.left-collapsed').waitFor({state:'detached'});
	await page.keyboard.press('Meta+d'); await page.locator('.changes-panel').waitFor();
	await page.evaluate(()=>document.documentElement.dataset.appearance='dark');
	await page.screenshot({path:'/tmp/pi-changes-35a-dark.png'});
	await page.getByRole('button',{name:'重新生成',exact:true}).click();
	for (let n=0;n<20&&!regenerated;n++) await sleep(25);
	assert.equal(regenerated?.text, 'Update the application'); assert.equal(regenerated?.messageId, 'user');
	// Manual sidebar choice overrides automatic restoration.
	await page.locator('.project-panel-toggle').click();
	await page.locator('.app.left-collapsed').waitFor({state:'detached'});
	await page.keyboard.press('Meta+d'); await page.locator('.changes-panel').waitFor({state:'detached'});
	assert.equal(await page.locator('.app.left-collapsed').count(),0);
	await page.keyboard.press('Meta+d'); await page.locator('.changes-panel').waitFor();
	// Running changes append immediately and large files start collapsed.
	snapshot.state.isStreaming = true;
	const content = Array.from({length:401},(_,n)=>`line ${n}`).join('\n');
	snapshot.state.messages.push({id:'new-write',role:'assistant',content:[{type:'toolCall',id:'write2',name:'write',argumentsText:JSON.stringify({path:'large.txt',content})}]},{id:'write-result',role:'toolResult',toolCallId:'write2',content:[]});
	snapshot.state.taskProgress.steps[0].artifacts.push({toolCallId:'write2',kind:'write',path:'large.txt',label:'large.txt'});
	snapshot.state.rev++; socket.send(JSON.stringify(snapshot));
	await page.locator('.changes-file-head code',{hasText:'large.txt'}).waitFor();
	assert.equal(await page.locator('[data-change-file="large.txt"] .changes-line').count(),0);
	await page.locator('[data-change-file="large.txt"] .changes-gap').click();
	assert.equal(await page.locator('[data-change-file="large.txt"] .changes-line').count(),401);
	assert.equal(await page.locator('.change-summary').count(),0);
	// Preferences are isolated per conversation and restored when returning.
	const original = snapshot.state.conversationId;
	upstreamSocket.send(JSON.stringify({type:'terminal_create',terminalId:'changes-fixture',cwd,cols:80,rows:24,conversationId:original}));
	for (let i=0;i<100&&!terminalReady;i++) await sleep(50); assert(terminalReady);
	upstreamSocket.send(JSON.stringify({type:'new_chat'}));
	await page.waitForFunction(id => JSON.parse(sessionStorage.getItem(`pi-harness:changes:${id}`)).open, original);
	await page.locator('.changes-panel').waitFor({state:'detached'});
	upstreamSocket.send(JSON.stringify({type:'switch_conversation',id:original}));
	await page.locator('.changes-panel').waitFor();
	// Desktop window controls must not overlap the changes close button.
	await page.addInitScript(() => { window.electronAPI = { platform:'win32', windowAction(){}, onWindowState(){return ()=>{};} }; });
	await page.reload(); await page.locator('.changes-panel').waitFor();
	const controls = await page.locator('.desktop-window-controls').boundingBox();
	const close = await page.locator('.changes-toolbar > button').last().boundingBox();
	assert(close.x + close.width <= controls.x, 'changes toolbar overlaps window controls');
	await page.screenshot({path:'/tmp/pi-changes-35a-windows.png'});
	// Non-Git workspaces retain tool changes and hide Git scope controls.
	forceNotRepo = true; await page.reload(); await page.locator('.changes-panel').waitFor();
	await page.locator('.changes-scopes').waitFor({state:'detached'});
	assert.equal(await page.locator('.changes-file-head code',{hasText:'app.ts'}).count(),1);
	assert.deepEqual(errors,[]); console.log('35a changes panel browser checks passed');
} finally {
	await browser?.close(); server?.kill('SIGTERM');
	if(server) await new Promise(resolve=>{server.once('exit',resolve);setTimeout(resolve,4000).unref();});
	rmSync(root,{recursive:true,force:true});
}
