/** Model-free regression for empty reasoning rows and DSML suffixes in the real renderer. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
	const submitted = [];
	let selectedModel;
	let messages = [text('question', '检查配置。', 'user'), ...Array.from({ length: 6 }, (_, i) => [
		{ id: `call-${i}`, role: 'assistant', content: [{ type: 'toolCall', id: `tool-${i}`, name: 'bash', argumentsText: JSON.stringify({ command: `sed -n '1,10p' profiles-${i}.py` }) }] },
		{ id: `result-${i}`, role: 'toolResult', toolCallId: `tool-${i}`, toolName: 'bash', content: [{ type: 'text', text: 'file contents' }] },
		text(`empty-${i}`, '</think>\n</think>'),
	]).flat(), text('suffix', suffix), text('answer', `检查完成。\n${suffix}`)];
	let streaming = null;
	const task = { id: 'task', sourceMessageId: 'question', title: '扩展配置', status: 'waiting', startedAt: Date.now(), completed: 0, steps: [], plan: { revision: 1, added: 0, removed: 0, items: [{ id: 'step', title: '扩展多 profile', status: 'running' }] } };
	const send = () => socket.send(JSON.stringify({ type: 'snapshot', state: { ...baseState, piConfigured: true, messages, streamingMessage: streaming, isStreaming: !!streaming, taskProgress: { ...task, conversationId: baseState.conversationId } } }));
	await page.routeWebSocket('**/ws', route => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage(wire => {
			const message = JSON.parse(wire.toString());
			if (message.type === 'prompt') {
				submitted.push(message);
				route.send(JSON.stringify({ type: 'prompt_result', requestId: message.requestId, ok: true, conversationId: baseState.conversationId }));
				return;
			}
			if (message.type === 'set_model') { selectedModel = message.modelId; return; }
			if (message.type === 'list_models') {
				route.send(JSON.stringify({ type: 'models', models: [{ id: 'fixture/other', name: 'Other model', provider: 'fixture', reasoning: false, vision: true }] }));
				return;
			}
			upstream.send(wire);
		});
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
	messages = [...messages, { ...text('unexecuted', `让我写扩展。\n${instruction}`), model: 'DeepSeek V4 Pro' }]; send();
	await page.locator('.unexecuted-tool').waitFor();
	assert.match(await page.locator('.unexecuted-tool').innerText(), /工具调用解析失败/);
	assert.equal(await page.locator('.msg[data-msg-id="unexecuted"] .change-card').count(), 0);
	await page.locator('.unexecuted-tool summary').click();
	assert.equal(await page.locator('.unexecuted-tool pre').textContent(), instruction);
	// Manual recovery resends the original question and its frozen attachments only.
	const question = messages.find(message => message.id === 'user-code');
	question.questionText = '扩展多 profile';
	question.userAttachments = [{ path: 'config.yaml', mode: 'inline', nativeRef: { entryId: 'user-code', index: 0 } }];
	send();
	await page.locator('.header-task-progress.interrupted').waitFor();
	await page.locator('.task-progress-status.interrupted').waitFor();
	assert.equal(await page.locator('.task-progress-status.interrupted').innerText(), '中断');
	assert.equal(await page.locator('.task-plan-step.interrupted .task-plan-mark').innerText(), '×');
	const draft = page.locator('.inputbar textarea');
	await draft.fill('保留我的草稿');
	await page.locator('.tool-recovery-primary').click();
	await page.waitForFunction(() => !document.querySelector('.tool-recovery-primary')?.disabled);
	assert.equal(submitted.length, 1);
	assert.equal(submitted[0].text, '扩展多 profile');
	assert.deepEqual(submitted[0].attachments, question.userAttachments);
	assert.equal(await draft.inputValue(), '保留我的草稿');
	assert.equal(await page.locator('.bash-row').count(), 6);
	await page.locator('.tool-recovery-actions select').focus();
	await page.locator('.tool-recovery-actions select option[value="fixture/other"]').waitFor({ state: 'attached' });
	await page.locator('.tool-recovery-actions select').selectOption('fixture/other');
	await sleep(100);
	assert.equal(selectedModel, 'fixture/other');
	assert.equal(submitted.length, 1, 'must await model confirmation before prompting');
	baseState.model = { ...baseState.model, provider: 'fixture', id: 'other', name: 'Other model' }; send();
	await page.waitForFunction(() => !document.querySelector('.tool-recovery-primary')?.disabled);
	assert.equal(submitted.length, 2);
	assert.equal(submitted[1].text, '扩展多 profile');
	assert.notEqual(submitted[0].requestId, submitted[1].requestId);
	assert.match(await page.locator('.unexecuted-tool p').innerText(), /DeepSeek V4 Pro/);
	baseState.tree = { ...baseState.tree, externallyModified: true }; send();
	await page.waitForFunction(() => document.querySelector('.tool-recovery-primary')?.disabled);
	baseState.tree.externallyModified = false; send();
	await page.waitForFunction(() => !document.querySelector('.tool-recovery-primary')?.disabled);
	mkdirSync('tests/scratch', { recursive: true });
	await page.locator('.unexecuted-tool pre').scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'tests/scratch/design19-recovery-light.png' });
	// The complete original payload remains readable in a short, narrow window.
	await page.setViewportSize({ width: 820, height: 500 });
	assert.equal(await page.locator('.unexecuted-tool pre').evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap');
	await page.evaluate(() => document.documentElement.dataset.appearance = 'dark');
	assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase()), '#5ba3d6');
	assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-fg').trim()), '#fff');
	await page.screenshot({ path: 'tests/scratch/design19-recovery-dark-narrow.png' });
	baseState.model = { ...baseState.model, id: 'original' }; send();
	await page.locator('.tool-recovery-actions select').selectOption('fixture/other');
	assert.equal(submitted.length, 2);
	messages.push(text('user-instruction', instruction, 'user'), text('example-instruction', `\`\`\`xml\n${instruction}\n\`\`\``)); send();
	await page.locator('.msg[data-msg-id="example-instruction"] pre').waitFor();
	assert.equal(await page.locator('.unexecuted-tool').count(), 1);
	assert.equal(await page.locator('.tool-recovery-actions').count(), 0);
	assert.equal(await page.locator('.header-task-progress.interrupted').count(), 0);
	baseState.model = { ...baseState.model, id: 'other' }; send();
	await sleep(100);
	assert.equal(submitted.length, 2, 'a new user turn cancels pending model-switch recovery');
	messages.push(text('diagram', '```mermaid\nflowchart LR\n A[Question] --> B[Answer]\n```')); send();
	await page.locator('.mermaid-svg svg').waitFor();
	const darkDiagram = await page.locator('.mermaid-svg').innerHTML();
	await page.evaluate(() => document.documentElement.dataset.appearance = 'light');
	await page.waitForFunction(previous => document.querySelector('.mermaid-svg')?.innerHTML !== previous && !!document.querySelector('.mermaid-svg svg'), darkDiagram);
	assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase()), '#2f7aae');
	assert.deepEqual(errors, []);
	console.log('PASS: six empty reasoning fragments, DSML suffix, answer preservation, inspectable reasoning, code/user text, streaming, manual recovery with attachments, model confirmation, interrupted plan, theme and Mermaid');
} finally {
	await browser?.close();
	if (server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; }
	rmSync(root, { recursive: true, force: true });
}
