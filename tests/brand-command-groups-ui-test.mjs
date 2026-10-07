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
const port = 8997;
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
	await page.routeWebSocket('**/ws', route => {
		socket = route; const upstream = route.connectToServer();
		route.onMessage(wire => { assert.notEqual(JSON.parse(String(wire)).type, 'prompt'); upstream.send(wire); });
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === 'snapshot') {
				Object.assign(message.state, { messages, piConfigured: true, isStreaming: false });
				message.state.taskProgress = { id: 'task', conversationId: message.state.conversationId, sourceMessageId: 'user', title: '核对项目', status: 'failed', startedAt: time - 42000, endedAt: time, completed: 9, steps: calls.map((call, i) => ({ id: call.id, messageId: `a-${i}`, title: '运行命令', status: i === 8 ? 'failed' : 'done', startedAt: time, endedAt: time, artifacts: [{ toolCallId: call.id, kind: 'bash', label: JSON.parse(call.argumentsText).command, outputLines: 12 }] })) };
				snapshot = structuredClone(message);
			}
			if (message.type !== 'snapshot_delta') route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://localhost:${port}`);
	await page.locator('.bash-group-head', { hasText: '运行了 10 条命令' }).waitFor();
	assert.equal(await page.locator('.bash-group').count(), 1);
	assert.equal(await page.locator('.bash-row').count(), 8);
	assert.equal(await page.locator('.bash-row.err .bash-row-head').getAttribute('aria-expanded'), 'true');
	assert.equal(await page.locator('.bash-row.ok .bash-numbered-output').count(), 0);
	assert.match(await page.locator('.bash-group-head').textContent(), /1 条失败/);
	assert.match(await page.locator('.bash-row.err .bash-row-stats').textContent(), /退出码 128/);
	assert.equal(await page.locator('.bash-numbered-line.error').count(), 1);
	assert.equal(await page.locator('.bash-row-head code').first().textContent(), 'git show …/file-2.ts');
	const last = page.locator('[data-tool-call-id="cmd-9"]');
	await last.locator('.bash-row-head').click();
	assert.equal(await last.locator('.bash-numbered-line').count(), 6);
	assert.equal(await last.locator('.bash-full-command').textContent(), JSON.parse(calls[9].argumentsText).command);
	await last.getByRole('button', { name: '展开其余 6 行' }).click();
	assert.equal(await last.locator('.bash-numbered-line').count(), 12);
	await last.getByRole('button', { name: '复制命令', exact: true }).click();
	assert.equal(await page.evaluate(() => navigator.clipboard.readText()), JSON.parse(calls[9].argumentsText).command);
	assert.equal(await last.getByRole('button', { name: '下载完整输出', exact: true }).count(), 0);
	const truncated = page.locator('[data-tool-call-id="cmd-7"]');
	await truncated.locator('.bash-row-head').click();
	assert.equal(await truncated.getByRole('button', { name: '下载完整输出', exact: true }).count(), 1);
	await page.locator('.bash-group-head').click();
	assert.equal(await page.locator('.bash-row').count(), 0);
	await page.locator('.task-artifact-row button').first().click();
	await page.locator('[data-tool-call-id="cmd-0"] .bash-numbered-output').waitFor();
	assert.equal(await page.locator('.bash-row').count(), 10);
	assert.equal(await page.locator('.task-progress-source').count(), 0);
	assert.match(await page.locator('.task-progress-meta').textContent(), /10 条命令/);
	assert.equal(await page.locator('.task-artifact-row').first().evaluate(el => getComputedStyle(el).display), 'flex');
	const colors = await page.evaluate(() => { const s = getComputedStyle(document.documentElement); return ['--green', '--red', '--yellow-fg', '--accent'].map(key => s.getPropertyValue(key).trim()); });
	assert.deepEqual(colors, ['#3e9b5f', '#c9483a', '#8a5a00', '#2f7aae']);
	await page.locator('.usage-trigger').click();
	await page.locator('.usage-popover').waitFor();
	await page.keyboard.press('Escape');
	await page.mouse.move(0, 0);
	await page.waitForTimeout(1800);
	assert.match(await page.locator('.task-artifact-row code').first().textContent(), /^git show/);
	await page.screenshot({ path: '/tmp/pi-design14-light.png' });
	await page.evaluate(() => document.documentElement.dataset.appearance = 'dark');
	await page.waitForTimeout(350);
	const sendButton = page.locator('.input-tools .btn.send').first();
	assert(await sendButton.isDisabled());
	assert.equal(await sendButton.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(45, 45, 43)');
	await page.screenshot({ path: '/tmp/pi-design14-dark.png' });
	for (const width of [900, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await page.waitForTimeout(350);
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow at ${width}`);
		assert(await page.locator('.input-tools .btn.send').first().isVisible());
	}
	await page.screenshot({ path: '/tmp/pi-design14-mobile.png' });
	// A result replaces the live status, retaining measured duration for display.
	await page.setViewportSize({ width: 1440, height: 1000 });
	socket.send(JSON.stringify({ type: 'tool_status', conversationId: snapshot.state.conversationId, toolCallId: 'cmd-9', toolName: 'bash', isError: false, durationMs: 321, running: false }));
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('[data-tool-call-id="cmd-9"] .bash-row-stats', { hasText: '0.3s' }).waitFor();
	await page.locator('.bash-group-head').click();
	await page.keyboard.press('ControlOrMeta+f');
	await page.locator('.search-input').fill('file-4.ts');
	await page.locator('[data-tool-call-id="cmd-4"] .bash-numbered-output').waitFor();
	await page.keyboard.press('Escape');
	snapshot.state.isStreaming = true;
	snapshot.state.streamingMessage = { id: 'a-live', role: 'assistant', content: [{ type: 'toolCall', id: 'live-call', name: 'bash', argumentsText: '{"command":"sleep 1"}' }] };
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('.bash-group-head', { hasText: '正在运行 11 条命令' }).waitFor();
	assert.equal(await page.locator('.bash-group').count(), 1);
	assert.equal(await page.locator('.bash-row.run').count(), 1);
	// A previous interrupted tool must not become running again on a new turn.
	snapshot.state.messages.push(snapshot.state.streamingMessage, { id: 'user-next', role: 'user', content: [{ type: 'text', text: 'Next task' }] });
	snapshot.state.streamingMessage = null;
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('[data-tool-call-id="live-call"].err').waitFor();
	assert.equal(await page.locator('.bash-row.run').count(), 0);
	assert.deepEqual(errors, []);
	console.log('Design 14 browser checks passed: grouping, failure, output, copy, download, jump, timing, themes and mobile.');
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
	rmSync(root, { recursive: true, force: true });
}
