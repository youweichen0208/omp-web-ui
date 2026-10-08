/** Model-free regression for empty reasoning rows and DSML suffixes in the real renderer. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';

const port = 31000 + Math.floor(Math.random() * 10000);
const probe = createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
await new Promise(resolve => probe.close(resolve));
const root = mkdtempSync(join(tmpdir(), 'pi-protocol-noise-'));
const server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser;
server.stdout.on('data', chunk => logs += chunk);
server.stderr.on('data', chunk => logs += chunk);
const suffix = '</｜DSML｜parameter> </invoke> </｜DSML｜tool_calls>';
const text = (id, body, role = 'assistant') => ({ id, role, content: [{ type: 'text', text: body }] });
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null) throw new Error(logs);
		try { const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); assert.equal(health.pid, server.pid); ready = true; break; } catch { await sleep(100); }
	}
	assert(ready, logs);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	page.setDefaultTimeout(10000);
	const errors = [];
	page.on('pageerror', error => errors.push(String(error)));
	let socket, baseState;
	let messages = [text('question', '检查配置。', 'user'), ...Array.from({ length: 6 }, (_, i) => [
		{ id: `call-${i}`, role: 'assistant', content: [{ type: 'toolCall', id: `tool-${i}`, name: 'bash', argumentsText: JSON.stringify({ command: `sed -n '1,10p' profiles-${i}.py` }) }] },
		{ id: `result-${i}`, role: 'toolResult', toolCallId: `tool-${i}`, toolName: 'bash', content: [{ type: 'text', text: 'file contents' }] },
		text(`empty-${i}`, '</think>\n</think>'),
	]).flat(), text('suffix', suffix), text('answer', `检查完成。\n${suffix}`)];
	let streaming = null;
	const send = () => socket.send(JSON.stringify({ type: 'snapshot', state: { ...baseState, piConfigured: true, messages, streamingMessage: streaming, isStreaming: !!streaming, taskProgress: null } }));
	await page.routeWebSocket('**/ws', route => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage(message => upstream.send(message));
		upstream.onMessage(wire => {
			const message = JSON.parse(wire.toString());
			if (message.type === 'snapshot' || message.type === 'snapshot_delta') { baseState = { ...baseState, ...message.state }; send(); }
			else route.send(wire);
		});
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.msg-text', { hasText: '检查完成。' }).waitFor();
	assert.equal(await page.locator('.thinking.leaked').count(), 0);
	assert.equal(await page.locator('.bash-row').count(), 6);
	assert(!(await page.locator('.messages').innerText()).includes('DSML'));
	// Meaningful reasoning remains inspectable, and user/code examples are not filtered.
	messages = [...messages, text('reasoning', '检查实现</think>\n结果正确'), text('code', `\`\`\`xml\n${suffix}\n</think>\n\`\`\``), text('user-code', '`</think>`', 'user')]; send();
	await page.locator('.thinking.leaked').waitFor();
	assert.equal(await page.locator('.thinking.leaked').count(), 1);
	await page.locator('.thinking.leaked button').click();
	assert.equal(await page.locator('.thinking.leaked .thinking-body').textContent(), '检查实现</think>');
	assert.match(await page.locator('.msg[data-msg-id="code"] pre').textContent(), /DSML/);
	assert.equal(await page.locator('.msg[data-msg-id="user-code"] code').textContent(), '</think>');
	// Streaming text takes the same guard path as saved messages.
	streaming = text('live', `流式结果\n${suffix}`); send();
	await page.locator('.msg-text', { hasText: '流式结果' }).waitFor();
	assert.equal(await page.locator('.msg-text', { hasText: '流式结果' }).textContent(), '流式结果');
	const instruction = '<invoke name="edit"> <parameter name="path">fixture.py</parameter> <parameter name="edits">[{"oldText":"default","newText":"multi"}]</parameter> </invoke>';
	streaming = null;
	messages = [...messages, text('unexecuted', `让我写扩展。\n${instruction}`)]; send();
	await page.locator('.unexecuted-tool').waitFor();
	assert.match(await page.locator('.unexecuted-tool').innerText(), /工具指令未执行/);
	assert.equal(await page.locator('.msg[data-msg-id="unexecuted"] .change-card').count(), 0);
	await page.locator('.unexecuted-tool summary').click();
	assert.equal(await page.locator('.unexecuted-tool pre').textContent(), instruction);
	messages.push(text('user-instruction', instruction, 'user'), text('example-instruction', `\`\`\`xml\n${instruction}\n\`\`\``)); send();
	await page.locator('.msg[data-msg-id="example-instruction"] pre').waitFor();
	assert.equal(await page.locator('.unexecuted-tool').count(), 1);
	assert.deepEqual(errors, []);
	console.log('PASS: six empty reasoning fragments, DSML suffix, answer preservation, inspectable reasoning, code/user text, streaming and unexecuted tool warning');
} finally {
	await browser?.close();
	if (server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; }
	rmSync(root, { recursive: true, force: true });
}
