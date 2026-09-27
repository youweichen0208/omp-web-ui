/** Focused browser regression for quiet-run status and grouped write cards. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';

const port = 8997;
const root = mkdtempSync(join(tmpdir(), 'pi-write-stall-'));
const cwd = join(root, 'workspace');
mkdirSync(join(cwd, 'youwei_core/api'), { recursive: true });
mkdirSync(join(cwd, 'youwei_core/worker'), { recursive: true });
writeFileSync(join(cwd, 'youwei_core/api/main.py'), 'print(1)\n');
writeFileSync(join(cwd, 'youwei_core/worker/__init__.py'), '');
let server, browser;
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = ''; server.stderr.on('data', (chunk) => { stderr += chunk; });
	for (let i = 0; i < 80 && !await portUp(port); i++) await sleep(200);
	assert(await portUp(port), stderr);
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
	let socket, state;
	const sent = [];
	await page.routeWebSocket('**/ws', (route) => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage((wire) => { const msg = JSON.parse(wire.toString()); sent.push(msg); if (msg.type !== 'retry_silent_prompt') upstream.send(wire); });
		upstream.onMessage((wire) => { const msg = JSON.parse(wire.toString()); if (msg.type === 'snapshot') state = msg.state; route.send(wire); });
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.inputbox textarea').waitFor();
	for (let i = 0; i < 50 && !state; i++) await sleep(100);
	assert(state, 'initial snapshot');
	const write = (id, path, content) => ({ type: 'toolCall', id, name: 'write', argumentsText: JSON.stringify({ path, content }) });
	const messages = [
		{ id: 'user', role: 'user', content: [{ type: 'text', text: '写入两个文件' }] },
		{ id: 'writes', role: 'assistant', content: [write('w1', 'youwei_core/api/main.py', 'print(1)\n'), write('w2', 'youwei_core/worker/__init__.py', '')] },
		{ id: 'r1', role: 'toolResult', toolCallId: 'w1', toolName: 'write', isError: false, content: [{ type: 'text', text: 'Successfully wrote 9 bytes' }] },
		{ id: 'r2', role: 'toolResult', toolCallId: 'w2', toolName: 'write', isError: false, content: [{ type: 'text', text: 'Successfully wrote 0 bytes' }] },
	];
	const taskProgress = { id: 'task:user', conversationId: state.conversationId, sourceMessageId: 'user', title: '写入两个文件', status: 'running', startedAt: Date.now() - 2000, completed: 1, steps: [{ id: 'writes:0', messageId: 'writes', title: '写入两个文件', status: 'done', startedAt: Date.now() - 1000, artifacts: [{ toolCallId: 'w1', kind: 'write', label: 'youwei_core/api/main.py', path: 'youwei_core/api/main.py' }, { toolCallId: 'w2', kind: 'write', label: 'youwei_core/worker/__init__.py', path: 'youwei_core/worker/__init__.py' }] }] };
	state = { ...state, rev: state.rev + 1, messages, taskProgress, isStreaming: true, streamingMessage: null, piConfigured: true };
	socket.send(JSON.stringify({ type: 'snapshot', state }));
	await page.locator('.write-group-head', { hasText: '写入 2 个文件' }).waitFor();
	await page.locator('.task-progress-head', { hasText: '写入两个文件' }).waitFor();
	await page.locator('.task-step-head', { hasText: '写入两个文件' }).click();
	await page.locator('.task-artifact', { hasText: 'main.py' }).click();
	await page.locator('.fp-embedded').waitFor();
	await page.locator('.fp-back').click();
	await page.locator('.panel-lower-tabs button', { hasText: '本次对话涉及' }).click();
	assert.equal(await page.locator('.write-file-row').count(), 2);
	assert.equal(await page.locator('.write-group .toolcall-output').count(), 0);
	await page.locator('.write-file-head').last().click();
	await page.locator('.write-file-empty', { hasText: '__init__.py' }).waitFor();
	await page.locator('.conversation-file-directory-title', { hasText: 'youwei_core/api' }).waitFor();
	await page.locator('.conversation-file-directory-title', { hasText: 'youwei_core/worker' }).waitFor();
	const since = Date.now() - 192000;
	socket.send(JSON.stringify({ type: 'agent_silence', conversationId: state.conversationId, phase: 'silent', since, activity: 'model' }));
	await page.locator('.agent-silence', { hasText: '未收到模型响应' }).waitFor();
	assert.equal(await page.locator('.agent-silence button', { hasText: '重试' }).isDisabled(), true, 'completed writes must not be retried');
	assert((await page.locator('.status-item.working').textContent()).includes('模型未响应'));
	assert((await page.locator('.inputbox textarea').getAttribute('placeholder')).includes('模型暂时没有响应'));
	await page.locator('.agent-silence button', { hasText: '继续等待' }).click();
	await page.locator('.agent-silence button', { hasText: '操作' }).waitFor();
	socket.send(JSON.stringify({ type: 'agent_silence', conversationId: state.conversationId, phase: 'active', since: Date.now(), activity: 'model' }));
	await page.locator('.agent-silence').waitFor({ state: 'hidden' });
	state = { ...state, rev: state.rev + 1, messages: [messages[0]], taskProgress: { ...taskProgress, steps: [{ id: 'user:pending', messageId: 'user', title: '正在分析请求', status: 'running', startedAt: Date.now(), artifacts: [] }], completed: 0 }, isStreaming: true };
	socket.send(JSON.stringify({ type: 'snapshot', state }));
	socket.send(JSON.stringify({ type: 'agent_silence', conversationId: state.conversationId, phase: 'silent', since, activity: 'model' }));
	await page.locator('.agent-silence button', { hasText: '重试' }).waitFor();
	assert.equal(await page.locator('.agent-silence button', { hasText: '重试' }).isEnabled(), true);
	await page.locator('.agent-silence button', { hasText: '重试' }).click();
	assert(sent.some((msg) => msg.type === 'retry_silent_prompt' && msg.conversationId === state.conversationId));
	socket.send(JSON.stringify({ type: 'agent_silence', conversationId: state.conversationId, phase: 'silent', since, activity: 'tool' }));
	await page.locator('.agent-silence', { hasText: '命令或工具已运行' }).waitFor();
	assert.equal(await page.locator('.agent-silence button', { hasText: '重试' }).isDisabled(), true);
	await page.locator('.agent-silence button', { hasText: '停止' }).click();
	assert(sent.some((msg) => msg.type === 'abort'));
	const longCommand = Array.from({ length: 24 }, (_, i) => `echo section_${i} very_long_argument_for_command_preview`).join('; ');
	state = { ...state, rev: state.rev + 1, messages: [messages[0], { id: 'long-bash', role: 'assistant', content: [{ type: 'toolCall', id: 'long-command', name: 'bash', argumentsText: JSON.stringify({ command: longCommand }) }] }], taskProgress: null, isStreaming: false };
	socket.send(JSON.stringify({ type: 'snapshot', state }));
	const preview = page.locator('.bash-command-preview');
	await preview.waitFor();
	const compactHeight = await preview.locator('.clipped').evaluate((element) => element.getBoundingClientRect().height);
	await preview.getByRole('button', { name: '展开完整命令' }).click();
	const expandedHeight = await preview.locator('.full').evaluate((element) => element.getBoundingClientRect().height);
	assert(expandedHeight > compactHeight + 20, `expanding command must reveal content: ${compactHeight} -> ${expandedHeight}`);
	await preview.getByRole('button', { name: '收起' }).click();
	const collapsedHeight = await preview.locator('.clipped').evaluate((element) => element.getBoundingClientRect().height);
	assert(collapsedHeight < expandedHeight - 20, `collapsing command must hide content: ${expandedHeight} -> ${collapsedHeight}`);
	console.log('write/stall UI passed');
} finally {
	await browser?.close();
	if (server?.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(2000)]); }
	rmSync(root, { recursive: true, force: true });
}
