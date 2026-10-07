/** Service-global switch, live background deferral, reconnect/restart and readonly deferral. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
const root = mkdtempSync(join(tmpdir(), 'pi-plan-settings-')), agent = join(root, 'agent');
mkdirSync(agent, { recursive: true });
let child, logs = '', held, hold = false;
const sockets = [], requests = [];
let directClient;
const model = createServer(async (req, res) => {
	let raw = ""; for await (const chunk of req) raw += chunk; requests.push(JSON.parse(raw));
	const respond = () => {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		for (const choice of [{ index: 0, delta: { content: 'local fixture' }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [choice] })}\n\n`);
		res.end('data: [DONE]\n\n');
	};
	if (hold) { hold = false; held = respond; } else respond();
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(test, label = 'condition') { const until = Date.now() + 20000; while (Date.now() < until) { if (test()) return; if (child?.exitCode != null) throw new Error(logs); await sleep(25); } throw new Error(`Timeout ${label}\n${logs}`); }
let port;
async function start() {
	child = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_DATA_DIR: root, PI_WEB_CWD: root, PI_CODING_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
	child.stdout.on('data', c => { logs += c; }); child.stderr.on('data', c => { logs += c; });
	for (let i = 0; i < 150; i++) { try { const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); if (health.pid === child.pid) return; } catch {} await sleep(50); }
	throw new Error(logs);
}
async function stop() { for (const ws of sockets) ws.terminate(); if (child?.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited; } child = undefined; }
async function connect(id) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(ws);
	const client = { ws, state: null, wire: [], send: m => ws.send(JSON.stringify(m)) };
	ws.on('message', raw => { const m = JSON.parse(raw); client.wire.push(m); if (m.type === 'snapshot') client.state = m.state; if (m.type === 'snapshot_delta' && client.state) client.state = { ...client.state, ...m.state, messages: [...client.state.messages, ...m.appended] }; });
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	client.send({ type: 'hello', clientId: id, protocolVersion: 40 }); client.send({ type: 'get_state' }); await wait(() => client.state?.planSettings && !client.state.tree?.verifying);
	client.toggle = enabled => client.send({ type: 'set_plan_enabled', conversationId: client.state.conversationId, enabled });
	return client;
}
try {
	await new Promise(r => model.listen(0, '127.0.0.1', r)); assert(model.address().port >= 8900);
	const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); port = probe.address().port; assert(port >= 8900); await new Promise(r => probe.close(r));
	writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${model.address().port}`, apiKey: 'fixture', models: [{ id: 'fixture', contextWindow: 32000, maxTokens: 100 }] } } }));
	writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', retry: { enabled: false }, compaction: { enabled: false } }));
	await start(); const a = await connect('a'), b = await connect('b');
	assert.deepEqual(a.state.planSettings, { enabled: false, available: true, effective: false, pending: false });
	a.toggle(true); await wait(() => a.state.planSettings.effective && b.state.planSettings.effective, 'global on');
	hold = true; a.send({ type: 'prompt', text: 'Hold fixture' }); await wait(() => held && a.state.isStreaming, 'running');
	const active = a.state.conversationId;
	a.send({ type: 'new_chat', fresh: true }); await wait(() => a.state.conversationId !== active && !a.state.tree?.verifying, 'background');
	b.toggle(false); await wait(() => !a.state.planSettings.effective && !b.state.planSettings.effective, 'idle off');
	a.send({ type: 'switch_conversation', id: active }); await wait(() => a.state.conversationId === active);
	assert.deepEqual(a.state.planSettings, { enabled: false, available: true, effective: true, pending: true });
	held(); held = undefined;
	await wait(() => !a.state.isStreaming && !a.state.planSettings.effective && !a.state.planSettings.pending, 'settled off');
	const historyLeaf = a.state.tree.leafId;
	a.toggle(true); await wait(() => a.state.planSettings.effective && b.state.planSettings.effective);
	a.toggle(false); await wait(() => !a.state.planSettings.effective);
	// Reload and navigation must re-coordinate even when old tool declarations enable plan.
	a.send({ type: 'prompt', text: '/reload', requestId: 'plan-reload' }); await wait(() => a.wire.some(m => m.type === 'reload_status' && m.status === 'done') || a.wire.some(m => m.type === 'reload_status' && m.phase === 'done'), 'reload');
	a.send({ type: 'tree_navigate', conversationId: active, reqId: 'plan-tree', targetId: historyLeaf, summary: 'none' });
	await wait(() => a.wire.some(m => m.type === 'tree_navigate_result' && m.reqId === 'plan-tree'));
	assert.equal(a.state.planSettings.effective, false);
	const file = a.state.sessionFile;
	await wait(() => !a.state.tree.verifying);
	appendFileSync(file, JSON.stringify({ type: 'custom', id: 'foreign', parentId: a.state.tree.leafId, timestamp: new Date().toISOString(), customType: 'foreign', data: {} }) + '\n');
	await wait(() => a.state.tree.externallyModified, 'read-only');
	const notices = a.wire.length; a.toggle(true); await wait(() => a.state.planSettings.enabled && b.state.planSettings.effective, 'readonly preference save');
	assert.equal(JSON.parse(readFileSync(join(root, 'plan-settings.json'))).enabled, true);
	assert(!a.wire.slice(notices).some(m => m.type === 'notice' && m.level === 'error'));
	assert.equal(a.state.planSettings.effective, false); assert.equal(a.state.planSettings.pending, true);
	a.send({ type: 'session_reopen', conversationId: active, reqId: 'reopen' }); await wait(() => !a.state.tree.externallyModified && a.state.planSettings.effective, 'writable reapply');
	const reconnected = await connect('b'); assert(reconnected.state.planSettings.effective);
	await stop(); await start(); const restarted = await connect('restart'); assert(restarted.state.planSettings.enabled && restarted.state.planSettings.effective);
	await stop();
	// Exercise the actual host boundary without allowing snapshots to repair a stale loadout.
	const hostRoot = join(root, 'direct-host'); mkdirSync(hostRoot);
	process.env.PI_WEB_DATA_DIR = hostRoot; process.env.PI_CODING_AGENT_DIR = agent;
	const { ClientSession } = await import('../dist/server/agent-service.js');
	const { ClientStateStore } = await import('../dist/server/client-state.js');
	const { ThinkingDurationStore } = await import('../dist/server/thinking-timing.js');
	const { planSettings } = await import('../dist/server/plan/settings.js');
	directClient = await ClientSession.create('plan-direct', hostRoot, new ClientStateStore(join(hostRoot, 'state.json')), new ThinkingDurationStore(join(hostRoot, 'thinking.json')));
	const conv = directClient.conv, session = conv.session;
	for (const enabled of [false, true]) {
		await conv.tree.waitForVerification();
		planSettings().set(enabled);
		const tools = session.getActiveToolNames().filter(name => name !== 'plan');
		session.setActiveToolsByName(enabled ? tools : [...tools, 'plan']);
		directClient.flushSnapshot();
		assert.equal(session.getActiveToolNames().includes('plan'), !enabled, 'snapshot must not mutate the loadout');
		const count = requests.length;
		await directClient.prompt('Read the current tool declaration');
		assert(requests.length > count, 'the host must send a model request');
		assert.equal(requests.at(-1).tools.some(tool => tool.function.name === 'plan'), enabled, 'prompt must coordinate before sending');
	}
	console.log('PASS snapshot read-only behavior and prompt-time activation/deactivation');
	console.log('PASS plan global settings: multi-client, background settled, reload/tree, readonly, reconnect and restart');
} finally { held?.(); await directClient?.dispose(); await stop(); model.closeAllConnections(); await new Promise(r => model.close(r)); rmSync(root, { recursive: true, force: true }); }
