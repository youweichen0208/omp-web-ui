/** Actual SDK loop + local model, isolated from user sessions and credentials. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { portUp } from './lib/port-utils.mjs';

const port = Number(process.argv[2] || 9161);
assert(Number.isInteger(port) && port >= 8900 && port < 65535, 'Use isolated test ports >= 8900');
for (const candidate of [port, port + 1]) assert.equal(await portUp(candidate), false, `Port ${candidate} is occupied; refusing to touch its owner`);
const root = mkdtempSync(join(tmpdir(), 'pi-tool-recovery-'));
let scenario = 'success', phase = 'initial', count = 0, sawRead = false, modelError, releaseModel;
let server, ws, log = '';
const received = [];
const xml = '现在读取 runtime.py。\n\n<invoke name="read">\n<parameter name="path">runtime.py</parameter>\n</invoke>';
const holdModel = () => new Promise(resolve => { releaseModel = resolve; });
const mock = createServer(async (req, res) => {
	try {
		let body = ''; for await (const chunk of req) body += chunk;
		const payload = JSON.parse(body);
		let delta = { content: '测试标题' }, finish = 'stop';
		if (payload.tools?.length) {
			const n = ++count;
			if ((['abort-before', 'user-queue', 'user-steer'].includes(scenario) && n === 3) || (scenario === 'abort-after' && n === 4)) {
				await holdModel(); if (res.destroyed) return;
			}
			const tool = (name, args) => { finish = 'tool_calls'; delta = { tool_calls: [{ index: 0, id: `call-${scenario}-${phase}-${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; };
			if (phase === 'continuation') {
				if (n === 1) delta = { content: scenario === 'resume-waiting' ? '请确认是否可以继续。' : '继续 A 切片。我刚才在查 usage 暴露方式。让我继续核实。' };
				else if (n === 2 && scenario === 'resume-repeat-promise') delta = { content: '让我继续核实。' };
				else if (n === 2) tool('read', { path: 'runtime.py' });
				else delta = { content: '核实完成。' };
			} else if (scenario === 'no-todo' || scenario === 'first-call') {
				if (n === 1 && scenario === 'first-call') delta = { content: xml };
				else if (n === 1) tool('read', { path: 'runtime.py' });
				else if (n === 2 && scenario === 'first-call') tool('read', { path: 'runtime.py' });
				else if (scenario === 'first-call') delta = { content: '核实完成。' };
				else if (n === 2) delta = { content: xml };
				else if (n === 3) tool('read', { path: 'runtime.py' });
				else delta = { content: '核实完成。' };
			} else if (phase === 'probe') {
				if (n === 1) delta = { content: xml };
				else delta = { content: '这是 XML 格式示例，按你的要求只解释，不执行。' };
			} else if (n === 1) tool('todo', { action: 'create', subject: '读取并验证文件' });
			else if (n === 2) tool('todo', { action: 'update', id: 1, status: 'in_progress' });
			else if (n === 3) {
				if (scenario === 'completed') tool('todo', { action: 'update', id: 1, status: 'completed' });
				else delta = { content: ['waiting', 'stale'].includes(scenario) ? '请确认方案后再继续。' : scenario === 'indented' ? xml.split('\n').map(line => `    ${line}`).join('\n') : scenario === 'todo-error' ? '<invoke name="todo"><parameter name="action">update</parameter><parameter name="id">99</parameter><parameter name="status">completed</parameter></invoke>' : `${scenario === 'extension-queue' ? 'extension-queue\n' : ''}${xml}` };
			} else if (scenario === 'completed' || scenario === 'repeat' || (scenario === 'later-repeat' && n === 5)) delta = { content: xml };
			else if (['extension-queue', 'user-queue', 'user-steer'].includes(scenario)) {
				assert(!JSON.stringify(payload.messages).includes('only automatic correction'), 'no extra recovery behind an existing queue');
				delta = { content: '已处理排队消息。' };
			} else if (n === 4) {
				assert(JSON.stringify(payload.messages).includes('That invocation was NOT executed'), 'correction reaches actual model context');
				if (scenario === 'plain-stop' || scenario.startsWith('resume-')) delta = { content: '我会继续处理。' };
				else if (scenario === 'todo-error') tool('todo', { action: 'update', id: 99, status: 'completed' });
				else if (scenario === 'mixed-results') {
					tool('read', { path: 'missing-file.py' });
					delta.tool_calls.push({ index: 1, id: 'read-success', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'runtime.py' }) } });
				}
				else tool('read', { path: scenario === 'tool-error' ? 'missing-file.py' : 'runtime.py' });
			} else if (['tool-error', 'todo-error', 'mixed-results'].includes(scenario)) delta = { content: '工具返回错误，等待处理。' };
			else if (n === 5) {
				sawRead = JSON.stringify(payload.messages).includes('RECOVERY_FILE_READ');
				tool('todo', { action: 'update', id: 1, status: 'completed' });
			} else delta = { content: '验证完成。' };
			assert(n <= 7, 'automatic correction must be bounded');
		}
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: finish }]) res.write(`data: ${JSON.stringify({ id: 'recovery', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [choice] })}\n\n`);
		res.end('data: [DONE]\n\n');
	} catch (error) { modelError = error; res.writeHead(500); res.end('Mock assertion failed'); }
});
async function wait(predicate) {
	for (let i = 0; i < 300; i++) {
		if (modelError) throw modelError;
		assert(server.exitCode === null && server.signalCode === null, `Test server exited: ${log}`);
		const value = await predicate(); if (value) return value;
		await sleep(50);
	}
	throw Error(`Timed out (${scenario}): ${log}`);
}
const send = message => ws.send(JSON.stringify(message));
async function snapshot(predicate) {
	return wait(async () => {
		const after = received.length;
		send({ type: 'get_state' });
		await sleep(50);
		const state = received.slice(after).findLast(m => m.type === 'snapshot')?.state;
		return state && predicate(state) ? state : undefined;
	});
}
const repairStatuses = state => state.messages.filter(m => m.customType === 'tool-call-recovery').map(m => m.details.status);
try {
	const agent = join(root, 'agent'), work = join(root, 'work');
	mkdirSync(agent); mkdirSync(work); mkdirSync(join(agent, 'extensions'));
	writeFileSync(join(work, 'runtime.py'), 'RECOVERY_FILE_READ\n');
	writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { main: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port + 1}`, apiKey: 'local-test', models: [{ id: 'recovery-mock', name: 'Recovery mock', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
	writeFileSync(join(agent, 'auth.json'), JSON.stringify({ main: { type: 'api_key', key: 'local-test' } }));
	writeFileSync(join(agent, 'extensions', 'queue.ts'), `export default function(pi) {
		pi.on('turn_end', async (event) => {
			if (event.message.role === 'assistant' && event.message.content.some(p => p.type === 'text' && p.text.includes('extension-queue'))) {
				pi.sendMessage({ customType: 'test-extension-queue', display: true, content: '扩展要求先等待，不再执行工具。' }, { deliverAs: 'followUp', triggerTurn: true });
			}
		});
	}`);
	await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(port + 1, '127.0.0.1', resolve); });
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_HOST: '127.0.0.1', PI_WEB_TOKEN: '', PI_WEB_CWD: work, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: agent }, stdio: ['ignore', 'ignore', 'pipe'] });
	server.on('error', error => { modelError = error; });
	server.stderr.on('data', chunk => { log += chunk; });
	await wait(async () => {
		let health;
		try { health = await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })).json(); } catch { return false; }
		assert.equal(health.pid, server.pid, 'health response must belong to our child, never an existing service');
		return health.ok;
	});
	ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	ws.on('message', wire => received.push(JSON.parse(wire.toString())));
	await once(ws, 'open'); send({ type: 'hello', clientId: 'tool-recovery-test' });
	await wait(() => received.some(m => m.type === 'ready'));
	send({ type: 'set_model', modelId: 'main/recovery-mock' });
	await snapshot(state => state.model?.id === 'recovery-mock');
	const cases = {
		success: [6, ['retrying', 'resumed']],
		repeat: [4, ['retrying', 'failed']],
		'later-repeat': [5, ['retrying', 'resumed', 'failed']],
		'plain-stop': [4, ['retrying', 'unverified']],
		'tool-error': [5, ['retrying', 'failed']],
		'todo-error': [5, ['retrying', 'failed']],
		'mixed-results': [5, ['retrying', 'failed']],
		waiting: [3, []],
		indented: [3, []],
		completed: [5, ['retrying', 'failed']],
		'no-todo': [4, ['retrying', 'resumed']],
		'first-call': [3, ['retrying', 'resumed']],
		'resume-promise': [4, ['retrying', 'unverified']],
		'resume-waiting': [4, ['retrying', 'unverified']],
		'resume-repeat-promise': [4, ['retrying', 'unverified']],
		'resume-new-topic': [4, ['retrying', 'unverified']],
		'extension-queue': [4, ['deferred']],
		'user-queue': [4, ['deferred']],
		'user-steer': [4, ['deferred']],
		'abort-before': [3, []],
		'abort-after': [4, ['retrying', 'cancelled']],
		stale: [3, []],
	};
	for (scenario of Object.keys(cases).filter(name => process.argv.length <= 3 || process.argv.slice(3).includes(name))) {
		if (scenario !== 'success') { send({ type: 'prompt', text: '/new' }); await snapshot(state => !state.messages.length); }
		count = 0; sawRead = false; phase = 'initial'; releaseModel = undefined;
		send({ type: 'prompt', text: '读取文件并验证，完成后更新任务。' });
		if (scenario.startsWith('abort-') || scenario.startsWith('user-')) {
			await wait(() => releaseModel);
			if (scenario.startsWith('abort-')) {
				send({ type: 'abort' });
				await snapshot(state => !state.isStreaming);
			} else {
				send({ type: 'prompt', text: '暂停实施，只解释格式。', queue: scenario === 'user-queue' });
				await snapshot(state => state.queue.followUp.length + state.queue.steering.length > 0);
			}
			releaseModel();
		}
		const [expectedCalls, expectedStatuses] = cases[scenario];
		const state = await snapshot(state => count > 0 && !state.isStreaming);
		let finalState = state;
		assert.equal(count, expectedCalls, scenario);
		assert.deepEqual(repairStatuses(state), expectedStatuses, `${scenario}: ${JSON.stringify(state.messages.filter(m => m.role === "custom"))}`);
		if (scenario === 'success') { assert(sawRead); assert.equal(state.taskProgress.status, 'done'); }
		if (['repeat', 'plain-stop'].includes(scenario)) assert.equal(state.taskProgress.status, 'waiting');
		if (scenario === 'tool-error') assert.equal(state.taskProgress.status, 'failed');
		if (scenario.startsWith('abort-')) assert.equal(state.taskProgress.status, 'cancelled');
		if (['extension-queue', 'user-queue', 'user-steer'].includes(scenario)) {
			assert.equal(state.messages.find(m => m.customType === 'tool-call-recovery').details.reason, 'queued-message');
		}
		if (scenario === 'stale') {
			phase = 'probe'; count = 0;
			send({ type: 'prompt', text: '暂停实施，只解释 XML 格式。' });
			const after = await snapshot(state => count >= 2 && !state.isStreaming);
			finalState = after;
			assert.equal(count, 2, 'format correction must not force implementation from historical todo');
			assert.deepEqual(repairStatuses(after), ['retrying', 'unverified']);
			assert(!after.messages.slice(state.messages.length).some(m => m.role === 'toolResult'), 'explanation-only request must not execute tools');
		}
		if (scenario.startsWith('resume-')) {
			// Reopen from disk: continuation recovery cannot depend on a live WeakMap.
			const path = state.sessionFile;
			send({ type: 'prompt', text: '/new' }); await snapshot(state => !state.messages.length);
			send({ type: 'switch_session', path }); await snapshot(state => state.sessionFile === path);
			phase = 'continuation'; count = 0;
			send({ type: 'prompt', text: scenario === 'resume-new-topic' ? '暂停实施，只解释原因。' : '怎么卡住了 可以帮我继续吗' });
			const after = await snapshot(state => count > 0 && !state.isStreaming);
			finalState = after;
			assert.equal(count, scenario === 'resume-promise' ? 3 : scenario === 'resume-repeat-promise' ? 2 : 1, scenario);
			assert.deepEqual(repairStatuses(after), scenario === 'resume-promise' ? ['retrying', 'unverified', 'retrying', 'resumed'] : scenario === 'resume-repeat-promise' ? ['retrying', 'unverified', 'retrying', 'unverified'] : ['retrying', 'unverified']);
		}
		console.log(`PASS ${scenario}: model calls=${count}, recovery=${repairStatuses(finalState).join(',') || 'none'}`);
	}
} finally {
	releaseModel?.();
	ws?.terminate();
	if (server?.pid && server.exitCode === null && server.signalCode === null) {
		const exit = once(server, 'exit'); server.kill();
		const force = setTimeout(() => server.kill('SIGKILL'), 5000);
		await exit; clearTimeout(force);
	}
	mock.closeAllConnections();
	await new Promise(resolve => mock.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
