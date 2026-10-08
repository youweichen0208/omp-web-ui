/**
 * A reply that ends with a tool call written as text (the call never ran) is
 * continued automatically: the model is asked to re-issue it, the tool then runs
 * and the task finishes. Without real tool progress in between it is asked once only.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// The shape seen in the field: leaked reasoning, then only the tail of the call.
const LEAKED = '先验证改动。</think>\n<parameter name="command">echo AUTO_OK</parameter>\n</invoke>';

async function scenario(port, replies) {
	const root = mkdtempSync(join(tmpdir(), 'pi-tooltext-'));
	const cwd = join(root, 'ws'); mkdirSync(cwd);
	let calls = 0;
	const model = createServer(async (req, res) => {
		for await (const _ of req) { /* drain */ }
		const reply = replies(++calls);
		const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		if (reply.tool) res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: reply.tool }) } }] }, null));
		else res.write(chunk({ role: 'assistant', content: reply.text }, null));
		res.write(chunk({}, reply.tool ? 'tool_calls' : 'stop'));
		res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
		res.end('data: [DONE]\n\n');
	});
	await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
	const agent = join(root, 'agent'); mkdirSync(agent);
	writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'x', models: [{ id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 64000, maxTokens: 1024 }] } } }));
	writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', compaction: { enabled: false }, retry: { enabled: false } }));
	const server = spawn(process.execPath, [join(REPO, 'dist', 'server', 'index.js')], {
		env: { ...process.env, PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: agent, HOME: root },
		stdio: 'ignore', windowsHide: true,
	});
	try {
		for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {} await sleep(100); }
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		const notices = []; let snapshot = null;
		await new Promise(resolve => ws.on('open', resolve));
		ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'notice') notices.push(m.text); if (m.type === 'snapshot') snapshot = m.state; });
		ws.send(JSON.stringify({ type: 'hello', clientId: randomUUID() }));
		await sleep(1500);
		ws.send(JSON.stringify({ type: 'prompt', text: 'verify the change', requestId: 'r1' }));
		let stableSince = Date.now(), lastCalls = -1;
		for (let i = 0; i < 300; i++) {
			if (calls !== lastCalls) { lastCalls = calls; stableSince = Date.now(); }
			ws.send(JSON.stringify({ type: 'get_state' }));
			await sleep(100);
			if (calls > 0 && snapshot && !snapshot.isStreaming && Date.now() - stableSince > 2500) break;
		}
		ws.close();
		return { calls, notices, text: JSON.stringify(snapshot?.messages ?? []) };
	} finally {
		server.kill(); model.close();
		await sleep(300);
		rmSync(root, { recursive: true, force: true });
	}
}

// 1) The call written as text is re-issued after one automatic request and runs.
const fixed = await scenario(8974, n => n === 1 ? { text: LEAKED } : n === 2 ? { tool: 'echo AUTO_OK' } : { text: '验证完成。' });
assert.equal(fixed.calls, 3, 'leaked reply, re-issued tool call, final answer');
assert(fixed.text.includes('没有被执行'), 'the automatic request is a visible user message');
assert(/AUTO_OK/.test(fixed.text.replace(/echo AUTO_OK/g, '')), 'the tool actually ran and returned its output');
assert(fixed.notices.some(t => t.includes('已自动请它重新调用')), 'the user is told why the run continued');

// 2) Progress resets the guard: leak, run, leak again, run, finish (the field case).
const repeated = await scenario(8978, n => [null, { text: LEAKED }, { tool: 'echo AUTO_OK' }, { text: LEAKED }, { tool: 'echo AUTO_OK' }, { text: '完成。' }][n] ?? { text: '完成。' });
assert.equal(repeated.calls, 5, 'each leak after real progress is continued');
assert.equal(repeated.notices.filter(t => t.includes('已自动请它重新调用')).length, 2);

// 3) A model that keeps writing calls as text without running anything is asked once, then stops.
const stubborn = await scenario(8976, () => ({ text: LEAKED }));
assert.equal(stubborn.calls, 2, 'one automatic continuation, no loop');

// 4) A normal answer is never continued.
const plain = await scenario(8977, () => ({ text: '这是一个普通回答。' }));
assert.equal(plain.calls, 1, 'plain answers end the run as before');

console.log('PASS tool calls written as text are continued (guarded by real progress) and then executed');
