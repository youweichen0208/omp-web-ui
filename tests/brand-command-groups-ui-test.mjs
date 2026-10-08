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
	await page.locator('.bash-group.historical-step .bash-group-head').waitFor();
	await page.locator('.bash-group-head').click();
	await page.locator('.bash-group-head', { hasText: '运行了 10 条命令' }).waitFor();
	assert.equal(await page.locator('.bash-group').count(), 1);
	assert.equal(await page.locator('.bash-row').count(), 8);
	assert.equal(await page.locator('.bash-row.err .bash-row-head').getAttribute('aria-expanded'), 'true');
	assert.equal(await page.locator('.bash-row.ok .bash-numbered-output').count(), 0);
	assert.match(await page.locator('.bash-group-head').textContent(), /1 条失败/);
	assert.match(await page.locator('.bash-row.err .bash-row-stats').textContent(), /退出码 128/);
	assert.equal(await page.locator('.bash-numbered-line.error').count(), 1);
	assert.equal(await page.locator('.bash-readable-title').first().textContent(), 'git show …/file-2.ts');
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
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pi:reveal-tool', { detail: { toolCallId: 'cmd-0' } })));
	await page.locator('[data-tool-call-id="cmd-0"] .bash-numbered-output').waitFor();
	assert.equal(await page.locator('.bash-row').count(), 10);
	assert.equal(await page.locator('.task-plan-list').count(), 0);
	assert.equal(await page.locator('.task-progress-meta').count(), 0);
	assert.equal(await page.locator('.task-artifact-row').count(), 0);
	const colors = await page.evaluate(() => { const s = getComputedStyle(document.documentElement); return ['--green', '--red', '--yellow-fg', '--accent'].map(key => s.getPropertyValue(key).trim()); });
	assert.deepEqual(colors, ['#3e9b5f', '#c9483a', '#8a5a00', '#2f7aae']);
	assert.equal(await page.locator('.usage-trigger').count(), 0, 'zero usage stays hidden');
	await page.mouse.move(0, 0);
	await page.waitForTimeout(1800);
	assert.equal(await page.locator('.bash-group-location').count(), 0);
	await page.screenshot({ path: '/tmp/pi-design14-light.png' });
	await page.evaluate(() => document.documentElement.dataset.appearance = 'dark');
	await page.waitForTimeout(350);
	const sendButton = page.locator('.input-tools .composer-action.send').first();
	assert(await sendButton.isDisabled());
	assert.notEqual(await sendButton.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(47, 122, 174)');
	await page.screenshot({ path: '/tmp/pi-design14-dark.png' });
	for (const width of [900, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await page.waitForTimeout(350);
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow at ${width}`);
		assert(await page.locator('.input-tools .composer-action.send').first().isVisible());
	}
	await page.screenshot({ path: '/tmp/pi-design14-mobile.png' });
	// A result replaces the live status, retaining measured duration for display.
	await page.setViewportSize({ width: 1440, height: 1000 });
	socket.send(JSON.stringify({ type: 'tool_status', conversationId: snapshot.state.conversationId, toolCallId: 'cmd-9', toolName: 'bash', isError: false, durationMs: 321, running: false }));
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	assert.equal(await page.locator('.bash-row-stats', { hasText: '0.3s' }).count(), 0);
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
	await page.locator('.bash-group.historical-step .bash-group-head').click();
	await page.locator('[data-tool-call-id="live-call"].err').waitFor();
	assert.equal(await page.locator('.bash-row.run').count(), 0);
	// Completed tools remain part of a running turn until the model settles.
	const reads = ['progress.json', 'ARCHITECTURE.md'].map((name, i) => ({ type: 'toolCall', id: `read-${i}`, name: 'bash', argumentsText: JSON.stringify({ command: `git show feat/hermes-design-package:docs/architecture/decisions/${name} 2>/dev/null` }) }));
	snapshot.state.messages = [{ id: 'u-reads', role: 'user', timestamp: Date.now() - 26000, content: [{ type: 'text', text: 'Read project decisions' }] }, ...reads.flatMap((call, i) => [
		{ id: `a-read-${i}`, role: 'assistant', content: [call] },
		{ id: `r-read-${i}`, role: 'toolResult', toolCallId: call.id, toolName: 'bash', content: [{ type: 'text', text: 'result' }] },
	])];
	snapshot.state.streamingMessage = null;
	snapshot.state.isStreaming = true;
	snapshot.state.taskProgress = deriveTaskProgress(snapshot.state.conversationId, snapshot.state.messages, null, true);
	snapshot.state.stats = { ...snapshot.state.stats, tokens: { input: 6, cacheRead: 94, cacheWrite: 0, output: 10 }, contextUsage: { tokens: 600, contextWindow: 10000, percent: 6 } };
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('.task-progress.running').waitFor();
	assert.equal(await page.locator('.task-progress.done').count(), 0);
	assert.equal(await page.locator('.task-file-result').count(), 0);
	assert.equal(await page.locator('.task-artifact-row').count(), 0);
	for (let i = 0; i < reads.length; i++) socket.send(JSON.stringify({ type: 'tool_status', conversationId: snapshot.state.conversationId, toolCallId: reads[i].id, toolName: 'bash', isError: false, durationMs: i * 80, running: false }));
	assert.equal(await page.locator('.bash-group-duration').count(), 0);
	assert.equal(await page.locator('.bash-row-stats', { hasText: '<0.1s' }).count(), 0);
	assert.equal(await page.locator('.bash-readable-title').first().innerText(), 'progress.json');
	await page.locator('[data-tool-call-id="read-0"] .bash-row-head').click();
	assert.equal(await page.locator('[data-tool-call-id="read-0"] .bash-full-command').textContent(), JSON.parse(reads[0].argumentsText).command);
	await page.locator('[data-tool-call-id="read-0"]').getByRole('button', { name: '复制命令', exact: true }).click();
	assert.equal(await page.evaluate(() => navigator.clipboard.readText()), JSON.parse(reads[0].argumentsText).command);
	assert.match(await page.locator('.usage-cache-short').innerText(), /缓存 94%/);
	await page.locator('.usage-trigger').click();
	await page.locator('.usage-popover').waitFor();
	await page.keyboard.press('Escape');

	await page.locator('.inputbox textarea').first().focus();
	assert.match(await page.locator('.inputbox').evaluate(el => getComputedStyle(el).boxShadow), /^(none|rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)$/); // CSS minification may serialize none as a transparent zero-sized shadow.
	await page.evaluate(() => document.documentElement.dataset.appearance = 'light');
	await page.screenshot({ path: '/tmp/pi-command-refinement-light.png' });
	for (const width of [900, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await page.waitForTimeout(200);
		const leaf = page.locator('[data-tool-call-id="read-1"] .bash-readable-title');
		assert.equal(await leaf.textContent(), 'ARCHITECTURE.md');
		assert(await leaf.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `filename clipped at ${width}`);
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
	}
	await page.screenshot({ path: '/tmp/pi-command-refinement-mobile.png' });
	await page.setViewportSize({ width: 1440, height: 1000 });
	snapshot.state.isStreaming = false;
	snapshot.state.taskProgress = deriveTaskProgress(snapshot.state.conversationId, snapshot.state.messages, null, false, Date.now());
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('.task-progress.done').waitFor();
	// A failed plan completion after successful commands is not a successful turn.
	snapshot.state.messages.push({ id: 'a-plan-error', role: 'assistant', content: [{ type: 'toolCall', id: 'bad-plan', name: 'plan', argumentsText: '{"action":"update","status":"completed"}' }] }, { id: 'r-plan-error', role: 'toolResult', toolName: 'plan', toolCallId: 'bad-plan', isError: true, content: [{ type: 'text', text: 'Validation failed for tool "plan": steps is required' }] });
	snapshot.state.taskProgress = deriveTaskProgress(snapshot.state.conversationId, snapshot.state.messages, null, false, Date.now());
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('.task-progress.failed').waitFor();
	assert.equal(await page.locator('.task-progress.done').count(), 0);

	// Older servers send skill bodies truncated before </skill>; previews stay compact.
	snapshot.state.queue = { steering: [('<skill name="digitalocean-server-ops" location="/tmp/skills/server/SKILL.md">\n' + 'private instruction\n'.repeat(180)).slice(0, 2000) + '…'], followUp: ['普通待发问题'] };
	snapshot.state.isStreaming = true;
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('.queue-toggle').click();
	assert.equal(await page.locator('.queued-msg').count(), 0);
	assert.equal(await page.locator('.status-queue').count(), 0);
	assert.equal(await page.locator('.queued-text').first().innerText(), 'skill:digitalocean-server-ops');
	assert.equal(await page.locator('.queued-text').last().innerText(), '普通待发问题');
	for (const width of [1440, 900, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await page.waitForTimeout(350);
		const recall = page.locator('.recall-queue:visible');
		assert.equal(await recall.count(), 1);
		const recallBox = await recall.boundingBox();
		assert(recallBox.x >= 0 && recallBox.x + recallBox.width <= width && recallBox.y + recallBox.height <= 900, `recall outside viewport at ${width}`);
		assert(await recall.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1), `recall label clipped at ${width}`);
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
		assert(await page.locator('.input-tools .composer-action.stop').isVisible());
	}
	await page.screenshot({ path: '/tmp/pi-queue-preview-mobile.png' });
	// Selected delivery, alternate delivery, draft clearing and stopping use native commands.
	await page.setViewportSize({ width: 1440, height: 1000 });
	const input = page.locator('.inputbox textarea');
	await input.fill('first steer'); await input.press('Enter');
	await page.waitForFunction(() => document.querySelector('.inputbox textarea').value === '');
	assert.equal(submitted.at(-1).queue, false);
	assert.equal(await page.locator('.pending-echo').count(), 0);
	await input.fill('alternate follow'); await input.press('Alt+Enter');
	await page.waitForFunction(() => document.querySelector('.inputbox textarea').value === '');
	assert.equal(submitted.at(-1).queue, true);
	await page.locator('.delivery-control .chip').click();
	await page.locator('.delivery-control .dd-item').last().click();
	await input.fill('selected follow'); await input.press('Enter');
	await page.waitForFunction(() => document.querySelector('.inputbox textarea').value === '');
	assert.equal(submitted.at(-1).queue, true);
	await input.fill('alternate steer'); await input.press('Alt+Enter');
	await page.waitForFunction(() => document.querySelector('.inputbox textarea').value === '');
	assert.equal(submitted.at(-1).queue, false);
	await input.fill('draft'); const beforeEscape = submitted.length;
	await input.press('Escape'); assert.equal(await input.inputValue(), ''); assert.equal(submitted.length, beforeEscape);
	await input.press('Escape'); await page.waitForTimeout(100); assert.equal(submitted.at(-1).type, 'abort');
	assert.equal(await page.locator('.composer-action.stop').evaluate(el => el.getBoundingClientRect().width), 28);
	assert.equal(await page.locator('.composer-action.send').evaluate(el => el.getBoundingClientRect().width), 28);
	assert.equal(await page.locator('.messages .waiting-indicator').count(), 1);
	await page.screenshot({ path: '/tmp/pi-design16-running.png' });
	snapshot.state.isStreaming = false; snapshot.state.queue = { steering: [], followUp: [] };
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('.composer-action.stop').waitFor({ state: 'detached' });
	assert.equal(await page.locator('.delivery-control').count(), 0);
	snapshot.state.isStreaming = true; snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('.delivery-control .chip', { hasText: '插话' }).waitFor();
	snapshot.state.queue = { steering: [], followUp: ['one pending message'] };
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('.queue-single').waitFor();
	await input.press('ArrowUp'); await page.waitForTimeout(100);
	assert.equal(submitted.at(-1).type, 'recall_queue');
	await input.fill('line one'); await input.press('Shift+Enter');
	assert.equal(await input.inputValue(), 'line one\n');
	// Light diff rows and their markers follow the supplied palette.
	snapshot.state.messages.push({ id: 'write-demo', role: 'assistant', content: [{ type: 'toolCall', id: 'write-demo-call', name: 'write', argumentsText: JSON.stringify({ path: 'demo.ts', content: 'const value = 1;' }) }] }, { id: 'write-demo-result', role: 'toolResult', toolCallId: 'write-demo-call', toolName: 'write', content: [{ type: 'text', text: 'Successfully wrote file' }] });
	snapshot.state.taskProgress = deriveTaskProgress(snapshot.state.conversationId, snapshot.state.messages, null, true);
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.keyboard.press('ControlOrMeta+d');
	await page.locator('.changes-line.add').waitFor();
	assert.equal(await page.locator('.changes-line.add').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(230, 244, 234)');
	assert.equal(await page.locator('.changes-line.add .changes-line-sign').evaluate(el => getComputedStyle(el).color), 'rgb(62, 155, 95)');
	await page.keyboard.press('ControlOrMeta+d');
	await page.locator('.changes-panel').waitFor({state:'detached'});
	// English has longer control labels; verify the same narrow layout.
	await page.evaluate(() => localStorage.setItem('pi-harness:lang', 'en'));
	forceRunning = true;
	await page.reload(); await page.locator('.inputbox textarea').waitFor();
	snapshot.state.isStreaming = true; snapshot.state.queue = { steering: ['skill:server-ops'], followUp: ['pending message'] };
	snapshot.state.rev += 1; socket.send(JSON.stringify(snapshot));
	await page.locator('.queue-toggle').waitFor();
	await page.locator('.inputbox textarea').fill('A running draft');
	for (const width of [900, 390]) {
		await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(350);
		const box = await page.locator('.inputbox').boundingBox();
		for (const selector of ['.composer-action.stop', '.composer-action.send', '.delivery-control']) {
			const button = await page.locator(selector).boundingBox();
			assert(button.x >= box.x && button.x + button.width <= box.x + box.width + 1, `English control overflow: ${selector} at ${width}`);
		}
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
	}
	await page.screenshot({ path: '/tmp/pi-design16-english-mobile.png' });
	assert.deepEqual(errors, []);
	console.log('Design 14 browser checks passed: grouping, failure, output, copy, download, jump, timing, themes and mobile.');
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
	rmSync(root, { recursive: true, force: true });
}
