/** Real SDK subprocesses and host protocol; isolated local model, no paid calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { portUp } from './lib/port-utils.mjs';
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const [executable = process.execPath, appRoot = process.cwd()] = process.argv.slice(2).map(p => resolve(p));
const { SubagentManager, defaultSubagentConfig } = await import(pathToFileURL(join(appRoot, "dist/server/subagents.js")));
const port = Number(process.env.PI_BUILTIN_SUBAGENT_PORT || 9191);
for (const candidate of [port, port + 1]) { assert(candidate >= 8900); assert.equal(await portUp(candidate), false, `Port ${candidate} occupied`); }
const root = mkdtempSync(join(tmpdir(), 'pi-built-in-subagents-'));
const agentDir = join(root, 'agent'), cwd = join(root, 'work');
mkdirSync(agentDir); mkdirSync(cwd); mkdirSync(join(agentDir, 'extensions')); writeFileSync(join(agentDir, 'extensions/pi-subagents.ts'), `export default pi => pi.registerTool({ name: 'legacy_delegate', label: 'Legacy fixture', description: 'Test only', parameters: { type: 'object', properties: {} }, async execute() { return { content: [{ type: 'text', text: 'legacy' }] }; } });`); writeFileSync(join(cwd, 'probe.txt'), 'READ_FIXTURE');writeFileSync(join(cwd,'code.ts'),'export function greet(name: string) { return name.length; }');
const model = { provider: 'fixture', id: 'local' };
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port + 1}/v1`, apiKey: 'isolated', models: [{ id: 'local', name: 'Local fixture', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'isolated' } }));
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'local', defaultThinkingLevel: 'off', retry: { enabled: false }, compaction: { enabled: false } }));
let fail, server, ws, log = '', parentCalls = 0;
const holds = new Map(); const held = new Set();
const payloads = [];
function respond(res, payload, delta, finish = 'stop') {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: finish }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [choice] })}\n\n`);
	res.end('data: [DONE]\n\n');
}
let callSequence = 0;
const call = (name, args, id = `fixture-call-${++callSequence}`) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const mock = createServer(async (req, res) => {
	try {
		let body = ''; for await (const part of req) body += part;
		const payload = JSON.parse(body); payloads.push(payload);
		const tools = payload.tools?.map(t => t.function.name) ?? [];
		const text = JSON.stringify(payload.messages);
		if (!tools.length) { respond(res, payload, { content: '测试标题' }); return; }
		if (text.includes('LEGACY_CHECK')) { assert(tools.includes('legacy_delegate')); assert(!tools.includes('web_subagent')); respond(res, payload, { content: 'LEGACY_VISIBLE' }); return; }
		if (tools.includes('web_subagent')) {
			assert(!tools.includes('legacy_delegate'), 'upstream extension must be excluded while built-in mode is enabled');
			parentCalls++;
			const userIndex = payload.messages.findLastIndex(m => m.role === 'user');
			const userText = JSON.stringify(payload.messages[userIndex]);
			const results = payload.messages.slice(userIndex + 1).filter(m => m.role === 'tool');
			if(userText.includes('CODE_PARENT')){respond(res,payload,results.length?{content:'CODE_PARENT_DONE'}:call('web_subagent',{action:'spawn',role:'analysis',task:'CODE_QUERY'}),results.length?'stop':'tool_calls');return;}
			if (userText.includes('AUTO_QUOTA')) { respond(res, payload, results.length ? { content: 'AUTO_ROUND_DONE' } : call('web_subagent', { action: 'spawn', role: 'analysis', task: `AUTO_CHILD_${parentCalls}` }), results.length ? 'stop' : 'tool_calls'); return; }
			if (userText.includes('BOUNDED_WAIT')) { if (!results.length) respond(res, payload, call('web_subagent', { action: 'spawn', role: 'analysis', task: 'WAIT_CHILD_HOLD' }), 'tool_calls'); else if (results.length < 4) { const id = JSON.parse(results[0].content).id; respond(res, payload, call('web_subagent', { action: 'wait', taskId: id }), 'tool_calls'); } else respond(res, payload, { content: 'BOUNDED_PARENT_IDLE' }); return; }
			if (userText.includes('FINAL_WAIT')) { if (!results.length) respond(res, payload, call('web_subagent', { action: 'spawn', role: 'analysis', task: 'READ_STEPS' }), 'tool_calls'); else if (results.length === 1 || JSON.parse(results.at(-1).content).status === 'running') respond(res, payload, call('web_subagent', { action: 'wait', taskId: JSON.parse(results[0].content).id }), 'tool_calls'); else respond(res, payload, { content: 'FINAL_PARENT_IDLE' }); return; }
			if (userText.includes('MUTATE_HOST')) { respond(res, payload, results.length ? { content: 'LOCK_CHECK_DONE' } : call('edit', { path: 'probe.txt', oldText: 'READ_FIXTURE', newText: 'SHOULD_NOT_WRITE' }), results.length ? 'stop' : 'tool_calls'); return; }
			if (userText.includes('LOCK_PARENT')) { respond(res, payload, results.length ? { content: 'PARENT_IDLE' } : call('web_subagent', { action: 'spawn', role: 'development', task: 'WRITE_HOST_HOLD' }), results.length ? 'stop' : 'tool_calls'); return; }
			if (!results.length) respond(res, payload, call('web_subagent', { action: 'spawn', role: 'analysis', task: 'HOST_CHILD_HOLD' }), 'tool_calls');
			else respond(res, payload, { content: 'PARENT_IDLE' });
		} else {
			assert(!tools.some(t => /subagent|spawn_agent|delegate_agent/.test(t)));
			if(text.includes('CODE_QUERY')){assert(tools.includes('code'));if(!payload.messages.some(m=>m.role==='tool'))respond(res,payload,call('code',{action:'read_symbol',path:'code.ts',line:1,symbol:'greet'}),'tool_calls');else {assert(text.includes('function greet'));respond(res,payload,{content:'CODE_QUERY_DONE'});}return;}
			const marker = ['WAIT_CHILD_HOLD', 'CAPABILITY', 'WRITE_HOST_HOLD', 'SECOND_LOOP', 'STUCK', 'SLOT_0', 'SLOT_1', 'SLOT_2', 'SLOT_3', 'SLOT_4', 'HOST_CHILD_HOLD', 'HOLD_A', 'HOLD_B', 'WRITE_HOLD', 'WRITE_NEXT', 'READ_STEPS', 'TIMEOUT', 'SKILL_BOUNDARY'].find(m => text.includes(m));
			if (text.includes('LONG_RECORD')) { respond(res, payload, { content: 'Long Unicode result 😀'.repeat(7000) }); return; }
			if (marker === 'CAPABILITY' && !payload.messages.some(m => m.role === 'tool')) respond(res, payload, call('write', { path: 'unauthorized.txt', content: 'must not be written' }), 'tool_calls');
			else if (marker === 'STUCK') respond(res, payload, call('stuck', {}), 'tool_calls');
			else if (marker === 'READ_STEPS' && !payload.messages.some(m => m.role === 'tool')) respond(res, payload, call('read', { path: 'probe.txt' }), 'tool_calls');
			else if (marker === 'SKILL_BOUNDARY' && !text.includes('SECOND_LOOP')) respond(res, payload, { content: 'FIRST_LOOP' });
			else if (marker && /HOLD|TIMEOUT|SECOND_LOOP|SLOT_/.test(marker) && !held.has(marker) && !payload.messages.some(m => m.role === 'tool')) { held.add(marker); holds.set(marker, () => respond(res, payload, { content: marker + '_DONE' })); }
			else respond(res, payload, { content: `CHILD_DONE ${marker ?? ''}` });
		}
	} catch (e) { fail = e; if (!res.headersSent) res.writeHead(500); res.end(String(e)); }
});
async function wait(fn, label = 'condition') { for (let n = 0; n < 400; n++) { if (fail) throw fail; const value = await fn(); if (value) return value; await sleep(25); } throw Error(`Timeout: ${label}\n${log}`); }
const mgr = new SubagentManager(); mgr.initialize(join(root, 'manager')); mgr.configure({ ...defaultSubagentConfig(), enabled: true });
const base = { clientId: 'one', conversationId: 'c1', parentSessionId: 'parent', parentRound: 'round1', cwd, agentDir, model, thinking: 'off', roleId: 'analysis', task: '' };
const done = task => !['queued', 'running', 'stopping'].includes(task.status);
let sockets = [];
try {
	await new Promise((r, j) => { mock.once('error', j); mock.listen(port + 1, '127.0.0.1', r); });
	const a = mgr.spawn({ ...base, task: 'HOLD_A' }), b = mgr.spawn({ ...base, task: 'HOLD_B' });
	await wait(() => holds.has('HOLD_A') && holds.has('HOLD_B'), 'parallel model requests');
	assert.equal(a.status, 'running'); assert.equal(b.status, 'running');
	await mgr.message(a.id, 'one', 'c1', 'FOLLOWUP_FIXTURE', 'followUp');
	await mgr.message(b.id, 'one', 'c1', 'STEER_FIXTURE', 'steer');
	assert.throws(() => mgr.get(a.id, 'other', 'c1'));
	holds.get('HOLD_A')(); holds.get('HOLD_B')();
	await Promise.all([mgr.wait(a.id, 'one', 'c1'), mgr.wait(b.id, 'one', 'c1')]);
	assert(payloads.some(p => JSON.stringify(p.messages).includes('FOLLOWUP_FIXTURE')));
	assert(payloads.some(p => JSON.stringify(p.messages).includes('STEER_FIXTURE')));
	const read = mgr.spawn({ ...base, task: 'READ_STEPS' }); await mgr.wait(read.id, 'one', 'c1'); assert.equal(read.status, 'completed', read.error); assert((await mgr.detail(read.id, 'one', 'c1')).records.some(r => r.type === 'tool_execution_end'));
	const writing = mgr.spawn({ ...base, roleId: 'development', task: 'WRITE_HOLD' }); await wait(() => holds.has('WRITE_HOLD'));
	const next = mgr.spawn({ ...base, clientId: 'two', conversationId: 'c7', roleId: 'development', task: 'WRITE_NEXT' }); assert.equal(next.status, 'queued');
	assert.match(mgr.enter(cwd, 'host-other-client', 'edit1', 'edit'), /write lock/);
	assert.equal(mgr.enter(cwd, 'host-other-client', 'read1', 'read'), undefined);
	const queued = mgr.spawn({ ...base, roleId: 'development', task: 'CANCEL_QUEUED' }); mgr.stop(queued.id, 'one'); assert.equal(queued.status, 'cancelled');
	mgr.stop(writing.id, 'one'); await mgr.wait(writing.id, 'one', 'c1'); assert.equal(writing.status, 'cancelled'); await mgr.wait(next.id, 'two', 'c7'); assert.equal(next.status, 'completed', next.error);
	assert.equal(mgr.enter(cwd, 'host-other-client', 'edit2', 'edit'), undefined); mgr.leave(cwd, 'host-other-client');
	mgr.enter(cwd, 'host-busy', 'existing', 'bash'); const waitsForHost = mgr.spawn({ ...base, roleId: 'development', task: 'WRITE_AFTER_HOST' }); assert.equal(waitsForHost.status, 'queued'); mgr.leave(cwd, 'host-busy', 'existing'); assert.equal(waitsForHost.status, 'queued', 'host retains priority between edits'); mgr.leave(cwd, 'host-busy'); await mgr.wait(waitsForHost.id, 'one', 'c1'); assert.equal(waitsForHost.status, 'completed', waitsForHost.error);
	mgr.configure({ ...mgr.config, timeoutMs: 1000 }); const timeout = mgr.spawn({ ...base, task: 'TIMEOUT' }); await mgr.wait(timeout.id, 'one', 'c1'); assert.equal(timeout.status, 'failed'); assert.match(timeout.error, /timed out/);
	mgr.configure({ ...mgr.config, timeoutMs: 20000, roles: [...mgr.config.roles, { ...mgr.config.roles[0], id: 'missing', model: { provider: 'missing', id: 'absent' } }] }); const missing = mgr.spawn({ ...base, roleId: 'missing', task: 'missing model' }); await mgr.wait(missing.id, 'one', 'c1'); assert.equal(missing.status, 'failed'); assert.match(missing.error, /Requested model unavailable/);

	const extension = join(agentDir, 'boundary.mjs');
	writeFileSync(extension, `export default pi => {
		pi.on('agent_start', (_event, ctx) => { if (JSON.stringify(ctx.sessionManager.getBranch()).includes('CAPABILITY')) pi.setActiveTools(['read', 'write']); });
		pi.on('agent_end', event => { if (event.messages.some(m => m.role === 'assistant' && m.content.some(b => b.type === 'text' && b.text === 'FIRST_LOOP'))) pi.sendMessage({ customType: 'second-loop', content: 'SECOND_LOOP', display: true }, { triggerTurn: true, deliverAs: 'followUp' }); });
		pi.registerTool({ name: 'stuck', label: 'Stuck fixture', description: 'Test only', parameters: { type: 'object', properties: {} }, async execute() { return new Promise(() => {}); } });
	}`);
	mgr.configure({ ...mgr.config, roles: [...mgr.config.roles, { ...mgr.config.roles[0], id: 'boundary', extensions: [extension] }, { ...mgr.config.roles[0], id: 'stuck-role', tools: ['read', 'stuck'], extensions: [extension] }] });
	const boundary = mgr.spawn({ ...base, parentRound: 'boundary', roleId: 'boundary', task: 'SKILL_BOUNDARY' });
	await wait(() => holds.has('SECOND_LOOP'), 'extension starts second SDK loop'); assert.equal(boundary.status, 'running', 'agent_end must not finish task'); holds.get('SECOND_LOOP')(); await mgr.wait(boundary.id, 'one', 'c1'); assert.equal(boundary.status, 'completed', boundary.error);
	const capability = mgr.spawn({ ...base, parentRound: 'capability', roleId: 'boundary', task: 'CAPABILITY' }); await mgr.wait(capability.id, 'one', 'c1'); assert.equal(capability.status, 'completed', capability.error); assert.equal(existsSync(join(cwd, 'unauthorized.txt')), false); assert((await mgr.detail(capability.id, 'one', 'c1')).records.some(r => { if (r.type !== 'message') return false; const msg = JSON.parse(r.text); return msg.role === 'toolResult' && msg.isError; }));
	const stuck = mgr.spawn({ ...base, parentRound: 'force', roleId: 'stuck-role', task: 'STUCK' });
	await wait(async () => (await mgr.detail(stuck.id, 'one', 'c1')).records.some(r => r.type === 'tool_execution_start'), 'stuck tool started');
	const stoppingAt = Date.now(); mgr.stop(stuck.id, 'one', 'cancelled', 'Original stop reason'); mgr.stop(stuck.id, 'one'); assert.equal(stuck.error, 'Original stop reason'); assert.equal(stuck.status, 'stopping'); assert.match(mgr.enter(cwd, 'blocked-host', 'w', 'write'), /write lock/); await mgr.wait(stuck.id, 'one', 'c1'); assert.equal(stuck.status, 'cancelled'); assert(Date.now() - stoppingAt >= 4800, 'uncooperative tool must reach force-kill deadline'); assert.equal(mgr.enter(cwd, 'blocked-host', 'w', 'write'), undefined); mgr.leave(cwd, 'blocked-host');
	const slots = Array.from({ length: 5 }, (_, i) => mgr.spawn({ ...base, clientId: 'slots', parentRound: 'slots', task: `SLOT_${i}` }));
	await wait(() => [0, 1, 2, 3].every(i => holds.has(`SLOT_${i}`)), 'four occupied slots'); assert.equal(slots[4].status, 'queued'); mgr.cancel('slots'); await Promise.all(slots.map(t => mgr.wait(t.id, 'slots', 'c1')));
	mgr.enter(cwd, 'quota-host', 'existing', 'edit');
	const quota = Array.from({ length: 16 }, (_, i) => mgr.spawn({ ...base, clientId: 'quota', parentRound: 'quota', roleId: 'development', task: `Quota ${i}` })); assert.throws(() => mgr.spawn({ ...base, clientId: 'quota', parentRound: 'quota', task: '17th' }), /Maximum 16/);
	const crashDir = join(root, 'crash'); mkdirSync(join(crashDir, 'subagents'), { recursive: true }); writeFileSync(join(crashDir, 'subagents/tasks.json'), JSON.stringify({ tasks: quota, inputs: quota.map(t => [t.id, base]) }));
	const recovered = new SubagentManager(); recovered.initialize(crashDir); assert(recovered.state('quota').tasks.every(t => t.status === 'interrupted')); await recovered.shutdown();
	mgr.cancel('quota'); mgr.leave(cwd, 'quota-host');
	console.log('PASS agent_end boundary, forced process termination, lock held until exit, four slots, per-round quota and crash recovery');

	mgr.configure({ ...mgr.config, roles: [...mgr.config.roles, { ...mgr.config.roles[0], id: 'missing-skill', skills: ['missing-skill-fixture'] }, { ...mgr.config.roles[0], id: 'missing-tool', tools: ['nonexistent_tool'] }, { ...mgr.config.roles[0], id: 'missing-extension', extensions: [join(root, 'missing-extension.mjs')] }] });
	for (const roleId of ['missing-skill', 'missing-tool', 'missing-extension']) { const task = mgr.spawn({ ...base, parentRound: roleId, roleId, task: roleId }); await mgr.wait(task.id, 'one', 'c1'); assert.equal(task.status, 'failed', roleId); assert.match(task.error, /unavailable|extension|ENOENT/i); }

	const broken = join(root, 'broken.mjs'); writeFileSync(broken, `export default pi => { pi.on('agent_start', () => { throw new Error('EXT_RUNTIME_FIXTURE'); }); };`);
	mgr.configure({ ...mgr.config, roles: [...mgr.config.roles, { ...mgr.config.roles[0], id: 'broken-runtime', extensions: [broken] }] });
	const brokenTask = mgr.spawn({ ...base, parentRound: 'broken-runtime', roleId: 'broken-runtime', task: 'Broken runtime fixture' }); await mgr.wait(brokenTask.id, 'one', 'c1'); assert.equal(brokenTask.status, 'failed'); assert.match(brokenTask.error, /EXT_RUNTIME_FIXTURE/);
	await mgr.flush(); const nativeRole = { ...mgr.config.roles[0], id: 'native', extensions: ['builtin:mcp', 'builtin:tool-search', 'builtin:codemode'] }; mgr.configure({ ...mgr.config, roles: [...mgr.config.roles, nativeRole] }); const native = mgr.spawn({ ...base, parentRound: 'native', roleId: 'native', task: 'READ_STEPS' }); await mgr.wait(native.id, 'one', 'c1'); assert.equal(native.status, 'completed', native.error);
	const longRecord = mgr.spawn({ ...base, parentRound: 'long-record', task: 'LONG_RECORD' }); await mgr.wait(longRecord.id, 'one', 'c1'); assert.equal(longRecord.status, 'completed', longRecord.error); const longDetails = await mgr.detail(longRecord.id, 'one', 'c1'); assert(longDetails.records.some(r => r.type === 'message' && JSON.parse(r.text).truncated === true));
	await mgr.flush(); const restored = new SubagentManager(); restored.initialize(join(root, 'manager')); assert.equal(restored.state('one').tasks.find(t => t.id === read.id).status, 'completed'); await restored.shutdown();
	const taskDirectory = join(root, 'manager/subagents/tasks'), backupDirectory = taskDirectory + '-backup';
	await mgr.flush(); const oldResult = mgr.onResult; const deliveredAfterFailure = new Set(); mgr.onResult = async t => { deliveredAfterFailure.add(t.id); };
	const diskErrors = [], oldLog = console.error; console.error = (...args) => diskErrors.push(args);
	try {
		renameSync(taskDirectory, backupDirectory); writeFileSync(taskDirectory, 'temporarily blocked');
		const failedLaunch = mgr.spawn({ ...base, parentRound: 'disk-error', task: 'Cannot save launch' });
		await assert.rejects(mgr.whenLaunched(failedLaunch)); assert.equal(failedLaunch.status, 'failed'); assert.equal(mgr.has('one'), false);
		rmSync(taskDirectory); renameSync(backupDirectory, taskDirectory);
		const recoveredTask = mgr.spawn({ ...base, parentRound: 'disk-recovered', task: 'READ_STEPS' });
		const logPath = join(root, 'manager/subagents', recoveredTask.id + '.jsonl'); mkdirSync(logPath); // Fail append, not the outcome save.
		await mgr.whenLaunched(recoveredTask); await mgr.wait(recoveredTask.id, 'one', 'c1'); assert.equal(recoveredTask.status, 'completed', recoveredTask.error);
		await mgr.flush(); await wait(() => deliveredAfterFailure.has(recoveredTask.id), 'result delivery after persistence recovery');
		rmSync(logPath, { recursive: true }); assert.equal((await mgr.detail(recoveredTask.id, 'one', 'c1')).task.status, 'completed');
		await mgr.markDelivered(recoveredTask); assert.equal(JSON.parse(readFileSync(join(taskDirectory, recoveredTask.id + '.json'), 'utf8')).task.delivered, true);
		assert(diskErrors.length > 0);
	} finally { console.error = oldLog; mgr.onResult = oldResult; if (existsSync(backupDirectory)) { rmSync(taskDirectory, { recursive: true, force: true }); renameSync(backupDirectory, taskDirectory); } }
	console.log('PASS launch-write and journal failures recover, new SDK tasks run and outcomes are delivered and acknowledged');
	console.log('PASS real SDK parallel reads, follow-up/steer, write locks, queued cancellation, timeout, missing model, records and persistence');

	writeFileSync(join(agentDir, 'extensions/auto-rounds.ts'), `export default pi => { let count = 0; pi.on('agent_settled', (_e, ctx) => { if (JSON.stringify(ctx.sessionManager.getBranch()).includes('AUTO_QUOTA') && ++count < 17) pi.sendUserMessage('AUTO_QUOTA: next autonomous round'); }); };`);
	server = spawn(executable, [join(appRoot, 'dist/server/index.js')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: String(port), PI_WEB_HOST: '127.0.0.1', PI_WEB_TOKEN: '', PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'host'), PI_CODING_AGENT_DIR: agentDir, PI_WEB_TOOL_TIMEOUT_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'] }); server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
	await wait(async () => { try { const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); assert.equal(health.pid, server.pid); return health.ok; } catch { return false; } }, 'server ready');
	const received = []; let taskState;
	function receive(wire) { const msg = JSON.parse(wire); if (msg.type === 'subagent_state') taskState = msg; if (msg.type === 'subagent_delta' && taskState) { const tasks = new Map(taskState.tasks.map(t => [t.id, t])); for (const id of msg.removed) tasks.delete(id); for (const t of msg.tasks) tasks.set(t.id, t); taskState = { ...taskState, version: msg.version, config: msg.config ?? taskState.config, tasks: [...tasks.values()] }; received.push(taskState); } received.push(msg); }
	async function connect() { const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(socket); socket.on('message', b => receive(b)); await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', clientId: 'host-fixture' })); return socket; }
	ws = await connect(); await wait(() => received.some(m => m.type === 'ready'));
	const send = msg => ws.send(JSON.stringify(msg));
	async function snapshot(fn) { return wait(async () => { const n = received.length; send({ type: 'get_state' }); await sleep(30); return received.slice(n).findLast(m => m.type === 'snapshot' && fn(m.state))?.state; }); }
	const first = await snapshot(s => !!s.conversationId);
	const request = (action, extra = {}) => { const requestId = `request-${Math.random()}`; send({ type: 'subagent_request', conversationId: first.conversationId, requestId, action, ...extra }); return requestId; };
	assert.equal(received.findLast(m => m.type === 'subagent_state').config.enabled, true);
	const configId = request('configure', { config: { ...defaultSubagentConfig(), enabled: true, roles: [...defaultSubagentConfig().roles, { ...defaultSubagentConfig().roles[0], id: 'native-host', extensions: ['builtin:mcp', 'builtin:tool-search', 'builtin:codemode'] }] } }); await wait(() => received.some(m => m.type === 'subagent_response' && m.requestId === configId && m.accepted));

	send({ type: 'prompt', text: 'BOUNDED_WAIT: wait longer than the host watchdog without cancelling the child.' });
	const bounded = await snapshot(s => !s.isStreaming && s.messages.some(m => JSON.stringify(m).includes('BOUNDED_PARENT_IDLE')));
	const waited = taskState.tasks.find(t => t.task === 'WAIT_CHILD_HOLD'); assert.equal(waited.status, 'running');
	const waitReturns = bounded.messages.filter(m => m.role === 'toolResult' && m.toolName === 'web_subagent' && JSON.stringify(m).includes(waited.id));
	assert.equal(waitReturns.length, 4); assert(!waitReturns.some(m => m.isError));
	for (const m of waitReturns) { const v = JSON.parse(m.content.find(b => b.type === 'text').text); assert(!('background' in v)); assert(!('cwd' in v)); assert(!('task' in v)); }
	const stopWait = request('stop', { taskId: waited.id }); await wait(() => received.some(m => m.type === 'subagent_response' && m.requestId === stopWait && m.accepted)); await wait(() => taskState.tasks.find(t => t.id === waited.id).status === 'cancelled');
	send({ type: 'prompt', text: 'FINAL_WAIT: wait for the child final output.' });
	const waitedFinal = await snapshot(s => !s.isStreaming && s.messages.some(m => JSON.stringify(m).includes('FINAL_PARENT_IDLE')));
	const finalWaitTask = taskState.tasks.find(t => t.task === 'READ_STEPS'); assert.equal(finalWaitTask.status, 'completed');
	assert(!waitedFinal.messages.some(m => m.customType === 'web-subagent-result' && m.details?.taskId === finalWaitTask.id), 'completed wait must not inject a second result');
	console.log('PASS repeated bounded wait beyond host deadline, compact results, native capabilities and final-wait delivery dedup');
	send({ type: 'prompt', text: 'Delegate HOST_CHILD_HOLD to analysis and finish without waiting.' });
	await wait(() => holds.has('HOST_CHILD_HOLD'));
	const idle = await snapshot(s => !s.isStreaming && s.messages.some(m => JSON.stringify(m).includes('PARENT_IDLE')));
	const task = received.findLast(m => m.type === 'subagent_state').tasks.find(t => t.task === 'HOST_CHILD_HOLD'); assert.equal(task.status, 'running', 'spawn result must not mark child complete');
	ws.close(); await once(ws, 'close'); ws = await connect(); await wait(() => received.findLast(m => m.type === 'subagent_state')?.tasks.find(t => t.task === 'HOST_CHILD_HOLD')?.status === 'running');

	const alternate = join(root, 'alternate'); mkdirSync(alternate); send({ type: 'set_cwd', path: alternate, source: 'ui', requestId: 'project-switch' });
	const otherProject = await snapshot(s => s.cwd === alternate); assert.notEqual(otherProject.conversationId, first.conversationId); assert.equal(received.findLast(m => m.type === 'subagent_state').tasks.find(t => t.task === 'HOST_CHILD_HOLD').status, 'running');
	const beforeComplete = parentCalls; holds.get('HOST_CHILD_HOLD')();

	await wait(() => received.findLast(m => m.type === 'subagent_state')?.tasks.find(t => t.task === 'HOST_CHILD_HOLD')?.status === 'completed');

	const otherFinished = await snapshot(s => s.cwd === alternate && !s.isStreaming); assert(!otherFinished.messages.some(m => m.customType === 'web-subagent-result'), 'result must not leak into selected project');
	send({ type: 'set_cwd', path: cwd, source: 'ui', requestId: 'project-back' });
	const final = await snapshot(s => s.cwd === cwd && s.messages.some(m => m.customType === 'web-subagent-result'));

	assert.equal(final.messages.filter(m => m.customType === 'web-subagent-result').length, 1); assert.equal(parentCalls, beforeComplete, 'result must not awaken idle parent');
	request('list'); const detailId = request('detail', { taskId: task.id }); await wait(() => received.some(m => m.type === 'subagent_response' && m.requestId === detailId && m.records?.length));
	ws.close(); await once(ws, 'close'); ws = await connect(); await snapshot(s => s.messages.filter(m => m.customType === 'web-subagent-result').length === 1);
	const badId = request('detail', { conversationId: 'other', taskId: task.id }); await wait(() => received.some(m => m.type === 'subagent_response' && m.requestId === badId && m.error));


	send({ type: 'prompt', text: 'LOCK_PARENT: start a writing child and return immediately.' }); await wait(() => holds.has('WRITE_HOST_HOLD'));
	await snapshot(s => !s.isStreaming); const writingHost = received.findLast(m => m.type === 'subagent_state').tasks.find(t => t.task === 'WRITE_HOST_HOLD'); assert.equal(writingHost.status, 'running');
	const secondReceived = []; const second = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(second); second.on('message', wire => secondReceived.push(JSON.parse(wire))); await once(second, 'open'); second.send(JSON.stringify({ type: 'hello', clientId: 'host-second-tab' })); await wait(() => secondReceived.some(m => m.type === 'ready'));
	second.send(JSON.stringify({ type: 'prompt', text: 'MUTATE_HOST: edit the fixture.' }));
	await wait(async () => { second.send(JSON.stringify({ type: 'get_state' })); await sleep(30); return secondReceived.findLast(m => m.type === 'snapshot' && !m.state.isStreaming && m.state.messages.some(msg => msg.role === 'toolResult' && msg.toolName === 'edit' && msg.isError && JSON.stringify(msg).includes('write lock'))); });
	assert.equal(readFileSync(join(cwd, 'probe.txt'), 'utf8'), 'READ_FIXTURE');
	const stopId = request('stop', { taskId: writingHost.id }); await wait(() => received.some(m => m.type === 'subagent_response' && m.requestId === stopId && m.accepted)); await wait(() => received.findLast(m => m.type === 'subagent_state').tasks.find(t => t.id === writingHost.id)?.status === 'cancelled');
	second.close(); await once(second, 'close');
	console.log('PASS actual separate browser clients share SDK mutation lock and explicit stop');
	send({ type: 'prompt', text: 'AUTO_QUOTA: delegate one read task per autonomous round.' });
	await wait(() => taskState.tasks.filter(t => t.task.startsWith('AUTO_CHILD_')).length === 17, '17 autonomous rounds');
	await snapshot(s => !s.isStreaming);
	const autoDetailIds = taskState.tasks.filter(t => t.task.startsWith('AUTO_CHILD_')).map(t => request('detail', { taskId: t.id }));
	await wait(() => autoDetailIds.every(id => received.some(m => m.type === 'subagent_response' && m.requestId === id && m.task)));
	assert.equal(new Set(autoDetailIds.map(id => received.find(m => m.type === 'subagent_response' && m.requestId === id).task.parentRound)).size, 17);
	console.log('PASS sendUserMessage autonomous continuation resets per-round delegation quota');
	held.delete('HOST_CHILD_HOLD'); holds.delete('HOST_CHILD_HOLD');
	const rerunId = request('rerun', { taskId: task.id }); await wait(() => received.some(m => m.type === 'subagent_response' && m.requestId === rerunId && m.accepted)); await wait(() => holds.has('HOST_CHILD_HOLD'));
	const rerun = received.findLast(m => m.type === 'subagent_state').tasks.find(t => t.id !== task.id && t.task === 'HOST_CHILD_HOLD'); assert(rerun); const durableRerun = request('detail', { taskId: rerun.id }); await wait(() => received.some(m => m.type === 'subagent_response' && m.requestId === durableRerun && m.task)); assert.equal(rerun.status, 'running');
	const crashed = server; const crashedExit = once(crashed, 'exit'); crashed.kill('SIGKILL'); await crashedExit;
	server = spawn(executable, [join(appRoot, 'dist/server/index.js')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: String(port), PI_WEB_HOST: '127.0.0.1', PI_WEB_TOKEN: '', PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'host'), PI_CODING_AGENT_DIR: agentDir, PI_WEB_TOOL_TIMEOUT_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'] }); server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
	await wait(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).pid === server.pid; } catch { return false; } });
	ws = await connect(); await wait(() => received.findLast(m => m.type === 'subagent_state')?.tasks.find(t => t.id === rerun.id)?.status === 'interrupted');
	const recoveredDetail = request('detail', { taskId: rerun.id }); await wait(() => received.some(m => m.type === 'subagent_response' && m.requestId === recoveredDetail && !m.error));
	console.log('PASS rerun creates new identity and actual service crash marks unfinished task interrupted');

	send({type:'prompt',text:'CODE_PARENT'});await snapshot(s=>!s.isStreaming&&s.messages.some(m=>JSON.stringify(m).includes('CODE_PARENT_DONE')));await wait(()=>taskState.tasks.find(t=>t.task==='CODE_QUERY')?.status==='completed','subagent code IPC');const codeDetailId=request('detail',{taskId:taskState.tasks.find(t=>t.task==='CODE_QUERY').id});await wait(()=>received.some(m=>m.type==='subagent_response'&&m.requestId===codeDetailId&&m.task));assert.match(received.find(m=>m.type==='subagent_response'&&m.requestId===codeDetailId).task.result,/CODE_QUERY_DONE/);console.log('PASS subagent code tool queries the shared host language service over IPC');
	const offId = request('configure', { config: { ...defaultSubagentConfig(), enabled: false } }); await wait(() => received.some(m => m.type === 'subagent_response' && m.requestId === offId && m.accepted));
	send({ type: 'prompt', text: 'LEGACY_CHECK: confirm the original extension is available.' }); await snapshot(s => !s.isStreaming && s.messages.some(m => JSON.stringify(m).includes('LEGACY_VISIBLE')));
	console.log('PASS project-switch ownership and upstream extension exclusion/restoration');
	console.log('PASS host SDK delegation, truthful background status, reconnect, owned detail requests, exactly-once result and idle parent');
} finally {
	for (const socket of sockets) socket.terminate();
	if (server && server.exitCode === null && server.signalCode === null) { const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit; }
	await mgr.shutdown(); mock.closeAllConnections(); await new Promise(r => mock.close(r)); rmSync(root, { recursive: true, force: true });
}
