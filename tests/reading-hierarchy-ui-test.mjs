/** Design 14: real app with a deterministic, model-free command transcript. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { deriveTaskProgress } from '../dist/server/task-progress.js';
const port = 8998;
assert.equal(await portUp(port), false, `Port ${port} busy`);
const root = mkdtempSync(join(tmpdir(), 'pi-design14-'));
const cwd = join(root, 'workspace'); mkdirSync(cwd);
writeFileSync(join(cwd, 'README.md'), '# Design review\n\n## Overview\n\nA local test document.\n');
const time = Date.now();
const calls = Array.from({ length: 10 }, (_, i) => ({ type: 'toolCall', id: `cmd-${i}`, name: 'bash', argumentsText: JSON.stringify({ command: i === 9 ? "python3 - <<'PY'\nprint('ready')\nPY" : `cd '${cwd}' && git show /Users/alice/projects/demo/src/file-${i}.ts` }) }));
let messages = [{ id: 'user', role: 'user', timestamp: time, content: [{ type: 'text', text: '核对项目最近的改动与命令结果。' }] }, ...calls.flatMap((call, i) => [
	{ id: `a-${i}`, role: 'assistant', timestamp: time + i * 10, content: [call] },
	{ id: `r-${i}`, role: 'toolResult', toolCallId: call.id, toolName: 'bash', isError: i === 8, details: { exitCode: i === 8 ? 128 : 0, ...(i === 7 ? { fullOutputPath: '/tmp/fixture.log' } : {}) }, ...(i === 7 ? { toolOutputUrl: '/api/tool-output?clientId=test&conversationId=test&toolCallId=cmd-7' } : {}), content: [{ type: 'text', text: i === 8 ? 'fatal: invalid revision\nCommand exited with code 128\n' : Array.from({ length: 12 }, (_, line) => `output ${line + 1}`).join('\n') + '\n' }] },
])];
let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = ''; server.stderr.on('data', data => log += data); server.stdout.on('data', data => log += data);
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	assert(await portUp(port), log);
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
	const page = await context.newPage(); page.setDefaultTimeout(10000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	let socket, snapshot;
	let forceRunning = false;
	const submitted = [];
	await page.routeWebSocket('**/ws', route => {
		socket = route; const upstream = route.connectToServer();
		route.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (['prompt', 'abort', 'recall_queue'].includes(message.type)) {
				submitted.push(message);
				if (message.type === 'prompt') route.send(JSON.stringify({ type: 'prompt_result', requestId: message.requestId, conversationId: snapshot.state.conversationId, ok: true }));
				return;
			}
			upstream.send(wire);
		});
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === 'snapshot') {
				Object.assign(message.state, { messages, piConfigured: true, isStreaming: forceRunning });
				if (forceRunning) message.state.queue = { steering: ["skill:server-ops"], followUp: ["pending message"] };
				message.state.taskProgress = { id: 'task', conversationId: message.state.conversationId, sourceMessageId: 'user', title: '核对项目', status: 'failed', startedAt: time - 42000, endedAt: time, completed: 9, steps: calls.map((call, i) => ({ id: call.id, messageId: `a-${i}`, title: '运行命令', status: i === 8 ? 'failed' : 'done', startedAt: time, endedAt: time, artifacts: [{ toolCallId: call.id, kind: 'bash', label: JSON.parse(call.argumentsText).command, outputLines: 12 }] })) };
				snapshot = structuredClone(message);
			}
			if (message.type !== 'snapshot_delta') route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://localhost:${port}`);
	await page.locator(".bash-group-head").waitFor();
	messages = [
		{ id: 'request', role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: 'Check the source' }] },
		{ id: 'intro', role: 'assistant', content: [{type:'text', text:'我先检查用户映射。'}, {type:'toolCall',id:'attempt-1',name:'bash',argumentsText:JSON.stringify({command:'echo "=== 用户映射 ===" && cat src/openai.py'})}] },
		{ id: 'retry', role: 'assistant', content: [{type:'toolCall',id:'attempt-2',name:'bash',argumentsText:JSON.stringify({command:'echo "=== 用户映射 ===" && sed -n \'1580,1620p\' src/openai.py'})}] },
		{ id: 'retry-result', role: 'toolResult',toolName:'bash',toolCallId:'attempt-2',content:[{type:'text',text:'mapping result'}]},
		{ id: 'read-more', role:'assistant',content:[{type:'toolCall',id:'read-3',name:'bash',argumentsText:JSON.stringify({command:"sed -n '40,70p' src/auth.py"})}]},
		{ id: 'read-result', role:'toolResult',toolName:'bash',toolCallId:'read-3',content:[{type:'text',text:'auth result'}]},
	];
	forceRunning = true;
	snapshot.state.messages = messages;
	snapshot.state.isStreaming = true;
	snapshot.state.taskProgress = deriveTaskProgress(snapshot.state.conversationId, messages, null, true);
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('.bash-attempt-count', { hasText: '试了 2 次' }).waitFor();
	assert.equal(await page.locator('.bash-group').count(), 1);
	assert.equal(await page.locator('.bash-group-location').count(), 0);
	assert.equal(await page.locator('.bash-readable-title', { hasText: 'auth.py 40–70 行' }).count(), 1);
	assert.equal(await page.locator('.process-narration').count(), 1);
	assert.equal(await page.locator('.process-narration .md').evaluate(el=>getComputedStyle(el).fontSize), '12.5px');
	assert.equal(await page.locator('.task-file-result').count(), 0);
	assert.equal(await page.locator('.task-artifact-row').count(), 0);
	await page.locator('[data-tool-call-id="attempt-2"] > .bash-row-head').click();
	assert.match(await page.locator('[data-tool-call-id="attempt-1"] .bash-row-stats').innerText(), /0 行/);
	assert(await page.locator('[data-tool-call-id="attempt-1"]').evaluate(el=>el.classList.contains('empty')));
	for (const id of ['attempt-2','read-3']) socket.send(JSON.stringify({type:'tool_status',conversationId:snapshot.state.conversationId,toolCallId:id,toolName:'bash',isError:false,running:false,durationMs:50}));
	assert(!(await page.locator('.bash-row-stats').allTextContents()).some(text=>text.includes('0.0s') || text.includes('<0.1s')));
	await page.locator('.trailing-working .waiting-indicator', { hasText: '阅读命令结果' }).waitFor();
	const spacing = await page.evaluate(() => { const card = document.querySelector('.bash-group').getBoundingClientRect(); const status = document.querySelector('.trailing-working .waiting-indicator').getBoundingClientRect(); return { gap: status.top - card.bottom, offset: status.left - card.left }; });
	assert(spacing.gap >= 0 && spacing.gap < 18 && Math.abs(spacing.offset) <= 2, JSON.stringify(spacing));
	await page.screenshot({path:'/tmp/pi-reading-hierarchy.png'});
	await page.setViewportSize({width:390,height:900}); await page.waitForTimeout(300);
	assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
	await page.screenshot({path:'/tmp/pi-reading-hierarchy-mobile.png'});
	// Read and edit of the same file produce one result with actual diff counts.
	snapshot.state.messages.push({id:'edit-call',role:'assistant',content:[{type:'toolCall',id:'edit-file',name:'edit',argumentsText:JSON.stringify({path:'src/openai.py',oldText:'old',newText:'new'})}]},{id:'edit-result',role:'toolResult',toolName:'edit',toolCallId:'edit-file',content:[{type:'text',text:'Updated'}]});
	snapshot.state.taskProgress = deriveTaskProgress(snapshot.state.conversationId, snapshot.state.messages, null, true);
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.setViewportSize({width:1440,height:1000});
	await page.locator('.task-file-counts').waitFor();
	assert.equal(await page.locator('.task-file-result').count(),1);
	assert.match(await page.locator('.task-file-counts').innerText(), /\+1.*−1/);
	// A single command has no redundant group header; the conclusion stays black.
	snapshot.state.messages = [messages[0],messages[4],messages[5],{id:'conclusion',role:'assistant',content:[{type:'text',text:'检查通过，权限映射正确。'}]}];
	snapshot.state.isStreaming = false; snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('.trailing-working .waiting-indicator').waitFor({state:'detached'});
	assert.equal(await page.locator('.bash-group-head').count(),0);
	assert.equal(await page.locator('.process-narration').count(),0);
	// 31a: deterministic phase clocks, instant content handoff, reduced motion and native stop.
	await page.clock.install();
	await page.clock.pauseAt(new Date());
	const publish = async (patch) => {
		Object.assign(snapshot.state, patch); snapshot.state.rev += 1;
		socket.send(JSON.stringify(snapshot)); await page.waitForTimeout(60);
	};
	await publish({messages:[{id:'waiting-user',role:'user',content:[{type:'text',text:'Waiting fixture'}]}],isStreaming:true,streamingMessage:null,queue:{steering:[],followUp:[]}});
	assert.equal(await page.locator('.waiting-indicator').count(),0);
	await page.clock.runFor(299);
	assert.equal(await page.locator('.waiting-indicator').count(),0);
	await page.clock.runFor(1);
	await page.locator('.waiting-label',{hasText:'理解你的问题'}).waitFor();
	assert.equal(await page.locator('.waiting-brand i').count(),3);
	assert.equal(await page.locator('.waiting-duration').count(),0);
	await page.clock.runFor(3700);
	assert.equal(await page.locator('.waiting-duration').innerText(),'4 秒');
	await page.clock.runFor(61000);
	assert.equal(await page.locator('.waiting-duration').innerText(),'1 分 05 秒');
	await page.locator('.waiting-stop').click();
	assert.equal(submitted.at(-1).type,'abort');
	await page.emulateMedia({reducedMotion:'reduce'});
	assert.equal(await page.locator('.waiting-brand i').first().evaluate(el=>getComputedStyle(el).animationName),'none');
	assert.equal(await page.locator('.waiting-label').evaluate(el=>getComputedStyle(el).animationName),'none');
	await publish({streamingMessage:{id:'live-wait',role:'assistant',content:[{type:'text',text:'Content arrived'}]}});
	assert.equal(await page.locator('.waiting-indicator').count(),0);
	assert.equal(await page.locator('.trailing-working').evaluate(el=>getComputedStyle(el).display),'none');
	await publish({streamingMessage:null,queue:{steering:['Please check auth'],followUp:[]}});
	await publish({messages:[...snapshot.state.messages,{id:'steered-user',role:'user',content:[{type:'text',text:'Please check auth'}]}],queue:{steering:[],followUp:[]}});
	await page.clock.runFor(300);
	await page.locator('.waiting-label',{hasText:'处理你的插话'}).waitFor();
	await publish({isStreaming:false});
	assert.equal(await page.locator('.waiting-indicator').count(),0);
	assert.deepEqual(errors,[]);
	console.log('PASS reading hierarchy: labels, retries, grouping, files, waiting and narrow layout');

} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
	rmSync(root, { recursive: true, force: true });
}
