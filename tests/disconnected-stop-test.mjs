/** Browser regression: a lost WebSocket must not leave a live timer or drop Stop. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';

const PORT=8997;
const root=mkdtempSync(join(tmpdir(),'disconnected-stop-'));
const cwd=join(root,'workspace');mkdirSync(cwd);
let server,browser;
try {
	assert.equal(await portUp(PORT),false);
	server=spawn(process.execPath,['dist/server/index.js'],{env:{...process.env,PORT:String(PORT),PI_WEB_CWD:cwd,PI_WEB_DATA_DIR:join(root,'data'),PI_CODING_AGENT_DIR:join(root,'agent')},stdio:['ignore','pipe','pipe']});
	let stderr='';server.stderr.on('data',data=>stderr+=data);
	for(let n=0;n<80&&!await portUp(PORT);n++)await sleep(250);
	assert(await portUp(PORT),stderr);
	browser=await chromium.launch({executablePath:CHROME_PATH});
	const page=await browser.newPage();
	const sent=[];let socket,conversations=0,otherConversation=false;
	await page.routeWebSocket('**/ws',route=>{
		socket=route;conversations++;
		const upstream=route.connectToServer();
		route.onMessage(wire=>{const msg=JSON.parse(wire.toString());sent.push(msg);upstream.send(wire)});
		upstream.onMessage(wire=>{
			const msg=JSON.parse(wire.toString());
			if(msg.type==='snapshot')Object.assign(msg.state,{
				...(otherConversation?{conversationId:'another-conversation'}:{}),
				isStreaming:true,streamingMessage:null,piConfigured:true,
				messages:[{id:'user-question',role:'user',content:[{type:'text',text:'Check this'}]}],
			});
			route.send(JSON.stringify(msg));
		});
	});
	await page.goto(`http://localhost:${PORT}`);
	await page.locator('.agent-working').waitFor();
	const firstConversation=conversations;
	assert.equal(sent.filter(msg=>msg.type==='abort').length,0);
	// Keep the reconnect offline long enough to click Stop and inspect the state.
	socket.close();
	await page.locator('.agent-working.disconnected',{hasText:'连接已中断'}).waitFor();
	assert.equal(await page.locator('.agent-working .working-duration').count(),0);
	await page.locator('.input-tools .stop').click();
	await page.locator('.notices',{hasText:'重连后将尝试停止当前对话'}).waitFor();
	for(let n=0;n<80&&conversations===firstConversation;n++)await sleep(100);
	assert(conversations>firstConversation,'WebSocket reconnected');
	for(let n=0;n<80&&sent.filter(msg=>msg.type==='abort').length===0;n++)await sleep(100);
	assert.equal(sent.filter(msg=>msg.type==='abort').length,1,'queued Stop was sent after the fresh snapshot');
	// A queued request must not stop a different conversation selected on reconnect.
	const secondConversation=conversations;
	socket.close();
	await page.locator('.agent-working.disconnected').waitFor();
	await page.locator('.input-tools .stop').click();
	otherConversation=true;
	for(let n=0;n<80&&conversations===secondConversation;n++)await sleep(100);
	assert(conversations>secondConversation,'second WebSocket reconnected');
	await page.locator('.agent-working.disconnected').waitFor({state:'detached'});
	assert.equal(sent.filter(msg=>msg.type==='abort').length,1,'queued Stop did not target another conversation');
	console.log('PASS disconnected stop: status, no stale timer, queued abort on reconnect');
} finally {
	await browser?.close();server?.kill('SIGTERM');await sleep(200);
}
