/** Zero-token Web / desktop-shell checklist presentation and history navigation.
 * Run after npm run build. Uses isolated server/data and serialized plan fixtures. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { serializeMessage } from "../dist/server/serialize.js";
import { deriveTaskProgress } from "../dist/server/task-progress.js";

const port = 31000 + Math.floor(Math.random() * 10000);
const probe = createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
await new Promise((resolve) => probe.close(resolve));
const data = mkdtempSync(join(tmpdir(), "pi-plan-chat-"));
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_DATA_DIR: data, PI_WEB_CWD: data, PI_CODING_AGENT_DIR: join(data, "agent") }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser;
server.stdout.on("data", (chunk) => { logs += chunk; });
server.stderr.on("data", (chunk) => { logs += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timestamp = Date.now();
const text = (id, body, role = "assistant") => ({ id, role, timestamp, content: [{ type: "text", text: body }] });
const tasks = ["核实 usage 属性", "确认 SSH 配置", "跨进程透传 usage", "补测试", "提交文档"].map((title, i) => ({ id: String(i + 1), title, detail: `步骤详情 ${i + 1}` }));
const { transition } = await import('../dist/server/plan/state.js');
const first = transition({ action: 'create', title: '实现 usage', status: 'active', steps: tasks, currentStepId: null, completedStepIds: [], completionCriteria: '所有测试通过' }, undefined, () => 'original');
const started = transition({ ...first, action: 'update', expectedRevision: 1, currentStepId: '1' }, first);
function pair(id, snapshot, error) {
	const result = serializeMessage({ role: 'toolResult', toolCallId: id, toolName: 'plan', timestamp, isError: !!error, content: [{ type: 'text', text: error || 'Recorded' }], details: { planSnapshot: snapshot } }, 0);
	return [{ id: `a-${id}`, role: 'assistant', timestamp, content: [{ type: 'toolCall', id, name: 'plan', argumentsText: JSON.stringify(snapshot) }] }, result];
}
const initial = [text('question', '核实 usage 并补充测试', 'user'), ...pair('create', first)];
const updates = [...initial, text('explain', '现在核实配置。'), ...pair('start', started)];

try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null) throw new Error(logs);
		try {
			const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
			assert.equal(health.pid, server.pid);
			ready = true; break;
		} catch { await sleep(100); }
	}
	assert(ready, logs);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	mkdirSync("tests/scratch", { recursive: true });
	for (const [platform, width, lang] of [["web", 1400, "zh"], ["darwin", 900, "zh"], ["win32", 900, "en"]]) {
		const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
		const errors = [];
		page.on("pageerror", (error) => errors.push(String(error)));
		let socket, baseState, fixture = initial;
		const send = () => {
			const state = { ...baseState, piConfigured: true, messages: fixture.map(({ details, ...message }) => message), streamingMessage: null, isStreaming: false, taskProgress: deriveTaskProgress(baseState.conversationId, fixture, null, false) };
			socket.send(JSON.stringify({ type: "snapshot", state }));
		};
		await page.routeWebSocket("**/ws", (route) => {
			socket = route;
			const upstream = route.connectToServer();
			route.onMessage((message) => upstream.send(message));
			upstream.onMessage((wire) => {
				const message = JSON.parse(wire.toString());
				if (message.type === "snapshot" || message.type === "snapshot_delta") {
					baseState = { ...baseState, ...message.state };
					send();
				} else route.send(wire);
			});
		});
		await page.addInitScript(({ platform, lang }) => {
			if (platform !== "web") window.electronAPI = { platform, windowAction() {}, onWindowState() { return () => {}; } };
			localStorage.setItem("pi-left-collapsed", "true");
			localStorage.setItem("pi-web-ui:lang", lang);
		}, { platform, lang });
		await page.goto(`http://127.0.0.1:${port}`);
		await page.locator(".todo-checklist-item").last().waitFor();
		assert.equal(await page.locator(".todo-checklist-item").count(), 5);
		assert.equal(await page.locator(".todo-checklist").count(), 1);
		fixture = updates; send();
		await page.locator(".todo-update button").waitFor();
		assert.match(await page.locator(".todo-update").textContent(), lang === "en" ? /Item 1 started/ : /第 1 项开始/);
		assert.equal(await page.locator(".todo-checklist").count(), 1);
		await page.locator(".todo-update button").focus();
		await page.keyboard.press("Enter");
		await page.locator('.todo-checklist-item[data-todo-item-id="1"].todo-item-flash').waitFor();
		assert(await page.locator('.todo-checklist-item[data-todo-item-id="1"]').evaluate((node) => node === document.activeElement));
		assert(await page.locator(".todo-checklist").evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
		await page.screenshot({ path: `tests/scratch/plan-chat-${platform}.png` });
		await page.locator(".header-task-progress").click();
		await page.locator(".task-progress:visible").waitFor();
		assert.equal(await page.locator(".task-plan-step").count(), 5);
		if (width <= 1100) await page.locator(".drawer-backdrop").click({ position: { x: 10, y: 100 } });

		// Errors stay ordinary tool cards and cannot mutate the valid plan.
		fixture = [...updates, ...pair('rejected', first, 'expectedRevision is stale')]; send();
		await page.locator('.msg[data-msg-id="a-rejected"]').waitFor();
		assert.equal(await page.locator(".todo-checklist-item").count(), 5);

		// Long history folds the first card; View must restore it and pin the changed item.
		fixture = [...updates];
		for (let i = 0; i < 35; i++) fixture.push(text(`history-${i}`, `历史记录 ${i}\n\n${"核实记录。".repeat(30)}`, i % 2 ? "assistant" : "user"));
		fixture.push(...pair("finish", transition({ ...started, action: "update", expectedRevision: 2, currentStepId: "2", completedStepIds: ["1"] }, started))); send();
		await page.locator('.todo-update[data-tool-call-id="finish"] button').waitFor();
		await page.locator('.todo-update[data-tool-call-id="finish"] button').click();
		await page.locator('.todo-checklist-item[data-todo-item-id="1"].todo-item-flash.completed').waitFor();
		assert(await page.locator('.todo-checklist-item[data-todo-item-id="1"]').evaluate((node) => {
			const rect = node.getBoundingClientRect(), viewport = document.querySelector(".messages").getBoundingClientRect();
			return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
		}));

		// A replacement records cancellation and never merges its card into the old plan.
		const replacement = transition({ ...first, action: 'create', title: '新的任务', currentStepId: '1' }, started, () => 'new-plan');
		fixture = [...updates, ...pair('new', replacement), ...pair('new-start', transition({ ...replacement, action: 'update', expectedRevision: 1, currentStepId: '2', completedStepIds: ['1'] }, replacement))]; send();
		await page.locator('.todo-update[data-tool-call-id="new-start"] button').waitFor();
		await page.locator('.todo-update[data-tool-call-id="new-start"] button').click();
		await page.locator('.todo-checklist[data-tool-call-id="new"] .todo-item-flash').first().waitFor();
		assert.equal(await page.locator(".todo-checklist").count(), 2);
		assert.equal(await page.locator('.todo-checklist[data-tool-call-id="create"] .todo-item-flash').count(), 0);
		assert.match(await page.locator('.todo-checklist[data-tool-call-id="new"]').textContent(), lang === 'en' ? /replaced and cancelled/ : /替换并取消/);
		fixture = [...updates, text('next-question', '一个普通问题', 'user')]; send();
		await page.locator('.header-task-progress').click();
		await page.locator('.task-progress:visible').waitFor();
		assert.match(await page.locator('.task-progress-source').textContent(), lang === 'en' ? /awaiting confirmation/ : /等待确认/);
		fixture.push({ id: 'outside-call', role: 'assistant', timestamp, content: [{ type: 'toolCall', id: 'outside-read', name: 'read', argumentsText: '{"path":"README.md"}' }] }, { id: 'outside-result', role: 'toolResult', toolName: 'read', toolCallId: 'outside-read', timestamp, isError: false, content: [{ type: 'text', text: 'file contents' }] }); send();
		await page.locator('.task-unassigned-records').waitFor();
		assert.match(await page.locator('.task-unassigned-records').textContent(), /README.md/);
		fixture.push(...pair('last-step', transition({ ...started, action: 'update', expectedRevision: 2, currentStepId: '5', completedStepIds: ['1', '2', '3', '4'] }, started))); send();
		await page.waitForFunction(() => document.querySelector('.task-plan-step.running')?.textContent.includes('提交文档'));
		assert(await page.locator('.task-plan-step.running').evaluate(node => { const rect = node.getBoundingClientRect(), list = node.parentElement.getBoundingClientRect(); return rect.top >= list.top - 1 && rect.bottom <= list.bottom + 1; }));
		assert.deepEqual(errors, []);
		await page.close();
		console.log(`PASS ${platform}/${width}/${lang}: merged card, changes, keyboard navigation, sidebar, failure, folded history, replacement and waiting`);
	}
} finally {
	await browser?.close();
	if (server.exitCode === null) { const stopped = new Promise((resolve) => server.once("exit", resolve)); server.kill(); await stopped; }
	rmSync(data, { recursive: true, force: true });
}
