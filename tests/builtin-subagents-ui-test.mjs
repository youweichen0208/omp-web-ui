/** Browser regression for authoritative task cards, drawer and role settings. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { defaultSubagentConfig } from '../dist/server/subagents.js';
const port = 9194; assert.equal(await portUp(port), false, 'Port occupied');
const root = mkdtempSync(join(tmpdir(), 'pi-subagents-ui-'));
const server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_HOST: '127.0.0.1', PI_WEB_DATA_DIR: root, PI_WEB_CWD: root, PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: 'ignore' });
let browser;
try {
	for (let n = 0; n < 100; n++) { try { const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); assert.equal(h.pid, server.pid); if (h.ok) break; } catch {} await sleep(50); }
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	for (const platform of ['web', 'darwin', 'win32']) {
		const page = await browser.newPage({ viewport: { width: 1000, height: 850 } }); let socket, state, task, lastDetail, otherTask; let dropNext = false, staleDetail; let config = defaultSubagentConfig(), rejectConfig = false; const configs = []; const detailCalls = [];
		await page.addInitScript(platform => { if (platform !== 'web') window.electronAPI = { platform, windowAction() {}, onWindowState() { return () => {}; } }; localStorage.setItem('pi-left-collapsed', 'true'); }, platform);
		await page.routeWebSocket('**/ws', route => {
			socket = route; const upstream = route.connectToServer();
			route.onMessage(wire => {
				const msg = JSON.parse(wire.toString());
				if (msg.type === 'subagent_request' && msg.action === 'configure') { configs.push(msg.config); if (rejectConfig) { rejectConfig = false; route.send(JSON.stringify({ type: 'subagent_response', requestId: msg.requestId, conversationId: msg.conversationId, error: 'CONFIG_REJECTED_FIXTURE' })); return; } config = msg.config; route.send(JSON.stringify({ type: 'subagent_state', version: Date.now(), config, tasks: [task, otherTask] })); route.send(JSON.stringify({ type: 'subagent_response', requestId: msg.requestId, conversationId: msg.conversationId, accepted: true })); if (lastDetail) route.send(JSON.stringify({ type: 'subagent_response', requestId: lastDetail.requestId, conversationId: lastDetail.conversationId, taskId: lastDetail.taskId, records: [] })); return; }
				if (msg.type === 'subagent_request' && msg.action === 'detail') {
					lastDetail = msg; detailCalls.push(msg);
					if (dropNext) { dropNext = false; staleDetail = msg; return; }
					const value = msg.taskId === 'ui-other' ? otherTask : task;
					route.send(JSON.stringify({ type: 'subagent_response', requestId: msg.requestId, conversationId: msg.conversationId, taskId: msg.taskId, records: [{ type: 'instruction', timestamp: Date.now(), text: msg.taskId === 'ui-other' ? 'OTHER_TASK_RECORD' : 'ACTUAL_PROCESS_RECORD' }], nextOffset: 128, hasMore: false, task: value })); return;
				}
				upstream.send(wire);
			});
			upstream.onMessage(wire => {
				const msg = JSON.parse(wire.toString());
				if (msg.type === 'snapshot' || msg.type === 'snapshot_delta') {
					msg.state.piConfigured = true;
					if (msg.type === 'snapshot') {
						state = msg.state;
						msg.state.messages = [{ id: 'parent', role: 'assistant', timestamp: Date.now() - 1000, content: [{ type: 'toolCall', id: 'spawn-call', name: 'web_subagent', argumentsText: JSON.stringify({ action: 'spawn', task: 'Inspect isolated fixture' }) }] }, { id: 'spawn-result', role: 'toolResult', toolCallId: 'spawn-call', toolName: 'web_subagent', timestamp: Date.now(), content: [{ type: 'text', text: JSON.stringify({ id: 'ui-task', status: 'running' }) }] }];
						msg.state.isStreaming = false;
					}
				}
				if (msg.type === 'subagent_state') {
					task ??= { id: 'ui-task', clientId: 'fixture', conversationId: state?.conversationId ?? 'c1', parentSessionId: 'fixture', parentRound: 'round', cwd: root, role: defaultSubagentConfig().roles[0], model: { provider: 'fixture', id: 'local' }, thinking: 'off', timeoutMs: 1200000, task: 'Inspect isolated fixture', background: '', status: 'running', createdAt: Date.now() - 1000, startedAt: Date.now() - 500, version: Date.now() };
					otherTask ??= { ...task, id: 'ui-other', task: 'Other task', status: 'queued', queueReason: 'write_lock' };
					Object.assign(msg, { version: Date.now(), config, tasks: [task, otherTask] });
				}
				route.send(JSON.stringify(msg));
			});
		});
		await page.goto(`http://127.0.0.1:${port}`);
		await page.locator('[data-subagent-id="ui-task"] .subagent-status').waitFor(); assert.equal(await page.locator('[data-subagent-id="ui-task"] .subagent-status').textContent(), '运行中');
		// The built-in entry uses the same authoritative configuration on web and desktop.
		await page.locator('.topbar-more').getByRole('button', { name: '设置', exact: true }).click();
		await page.getByText('所有设置', { exact: true }).click();
		await page.locator('.settings-rail button[title="插件"]').click();
		const builtin = page.locator('.set-row').filter({ hasText: '子代理 · 内置' });
		await builtin.waitFor(); assert.equal(await builtin.getByRole('switch').getAttribute('aria-checked'), 'true');
		assert.equal(await builtin.getByText('卸载', { exact: true }).count(), 0);
		await builtin.getByRole('switch').click();
		await page.waitForFunction(() => [...document.querySelectorAll('.set-row')].find(row => row.textContent.includes('子代理 · 内置'))?.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'false');
		assert.deepEqual(configs.at(-1).roles, defaultSubagentConfig().roles);
		rejectConfig = true; await builtin.getByRole('switch').click(); await page.getByRole('alert').filter({ hasText: 'CONFIG_REJECTED_FIXTURE' }).waitFor();
		assert.equal(await builtin.getByRole('switch').getAttribute('aria-checked'), 'false');
		await builtin.getByRole('switch').click();
		await page.waitForFunction(() => [...document.querySelectorAll('.set-row')].find(row => row.textContent.includes('子代理 · 内置'))?.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true');
		await builtin.getByRole('button', { name: '设置', exact: true }).click();
		await page.locator('.subagent-config').waitFor(); assert.equal(await page.locator('.subagent-config fieldset').count(), 3);
		await page.locator('.subagent-drawer header').getByRole('button', { name: '关闭', exact: true }).click();
		await page.locator('.workspace-subagents').click(); await page.getByRole('dialog', { name: '子代理', exact: true }).waitFor(); await page.locator('.subagent-list button').filter({ hasText: 'Inspect isolated fixture' }).click(); await page.getByText('ACTUAL_PROCESS_RECORD', { exact: true }).waitFor({ state: 'attached' });
		assert((await page.locator('.subagent-list').textContent()).includes('费用未知'));
		assert((await page.locator('.subagent-list').textContent()).includes('等待项目写锁'));
		// A lost reply expires; the drawer keeps polling without being reopened.
		dropNext = true; const before = detailCalls.length;
		await page.locator('.subagent-detail').getByRole('button', { name: '刷新过程', exact: true }).click();
		await page.waitForFunction(() => document.querySelector('.subagent-records').children.length === 0);
		for (let n = 0; detailCalls.length < before + 2 && n < 150; n++) await sleep(100);
		assert(detailCalls.length >= before + 2, 'lost detail acknowledgement must expire');
		await page.getByText('ACTUAL_PROCESS_RECORD', { exact: true }).waitFor({ state: 'attached' });
		// A -> B -> A resets the cursor. An old A reply cannot replace page zero.
		dropNext = true; await page.locator('.subagent-detail').getByRole('button', { name: '刷新过程', exact: true }).click();
		await sleep(100); const old = staleDetail;
		await page.locator('.subagent-list button').filter({ hasText: 'Other task' }).click();
		await page.getByText('OTHER_TASK_RECORD', { exact: true }).waitFor({ state: 'attached' });
		await page.locator('.subagent-list button').filter({ hasText: 'Inspect isolated fixture' }).click();
		await page.getByText('ACTUAL_PROCESS_RECORD', { exact: true }).waitFor({ state: 'attached' });
		socket.send(JSON.stringify({ type: 'subagent_response', requestId: old.requestId, conversationId: old.conversationId, taskId: old.taskId, records: [{ type: 'message', timestamp: Date.now(), text: 'STALE_REPLY_MUST_NOT_APPEAR' }], nextOffset: 9999, task }));
		await sleep(100); assert.equal(await page.getByText('STALE_REPLY_MUST_NOT_APPEAR', { exact: true }).count(), 0);
		assert.equal(detailCalls.at(-1).offset ?? 0, 0);
		// Reconnect invalidates an outstanding request immediately, before its 10s expiry.
		dropNext = true; await page.locator('.subagent-detail').getByRole('button', { name: '刷新过程', exact: true }).click();
		await sleep(100); const reconnectBefore = detailCalls.length, reconnectAt = Date.now(); await socket.close();
		for (let n = 0; detailCalls.length <= reconnectBefore && n < 70; n++) await sleep(100);
		assert(detailCalls.length > reconnectBefore && Date.now() - reconnectAt < 9000, 'reconnect must clear pending detail');
		await page.getByText('ACTUAL_PROCESS_RECORD', { exact: true }).waitFor({ state: 'attached' });
		assert.equal(detailCalls.at(-1).offset ?? 0, 0);


		await page.locator('.subagent-drawer header').getByRole('button', { name: '设置', exact: true }).click();
		assert.equal(await page.locator('.subagent-config fieldset').count(), 3); await page.getByRole('button', { name: '新增角色', exact: true }).click(); assert.equal(await page.locator('.subagent-config fieldset').count(), 4); await page.getByRole('button', { name: '保存', exact: true }).click(); await page.locator('.subagent-config').waitFor({ state: 'detached' });
		await page.locator('.subagent-drawer header').getByRole('button', { name: '关闭', exact: true }).click();
		task = { ...task, status: 'completed', result: 'ACTUAL_DONE', endedAt: Date.now(), version: Date.now() + 1 }; socket.send(JSON.stringify({ type: 'subagent_state', version: Date.now() + 1, config: defaultSubagentConfig(), tasks: [task] }));
		await page.waitForFunction(() => document.querySelector('[data-subagent-id="ui-task"] .subagent-status')?.textContent === '已完成');
		await page.evaluate(() => localStorage.setItem('pi-web-ui:lang', 'en')); await page.reload(); await page.locator('.workspace-subagents').click(); await page.getByRole('dialog', { name: 'Subagents', exact: true }).waitFor(); assert.equal(await page.locator('.subagent-status.completed').first().textContent(), 'Completed');
		await page.close();
	}
	console.log('PASS task cards, write-lock reason, lost detail retry, stale reply rejection, reconnect, role editor, built-in extension switches and bilingual desktop layouts');
} finally { await browser?.close(); if (server.exitCode === null && server.signalCode === null) { const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit; } rmSync(root, { recursive: true, force: true }); }
