/** Zero-token Web / desktop-shell checklist presentation and history navigation.
 * Run after npm run build. Uses isolated server/data and serialized plan fixtures. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { serializeMessage } from "../dist/server/serialize.js";
import { deriveTaskProgress } from "../dist/server/task-progress.js";
import { TOOL_TEXT_CONTINUE_PROMPT } from "../dist/server/tool-text.js";

const port = 31000 + Math.floor(Math.random() * 10000);
const probe = createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
await new Promise((resolve) => probe.close(resolve));
const data = mkdtempSync(join(tmpdir(), "pi-plan-chat-"));
mkdirSync(join(data, "src"));
writeFileSync(join(data, "src/file-14.ts"), "export const example = true;\n");
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
		let socket, baseState, fixture = initial, running = false;
		const send = () => {
			const state = { ...baseState, piConfigured: true, messages: fixture.map(({ details, ...message }) => message), streamingMessage: null, isStreaming: running, taskProgress: deriveTaskProgress(baseState.conversationId, fixture, null, running) };
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
		// A persisted tool-text correction belongs to the same confirmed plan.
		fixture = [...updates, text('leaked-call', '<invoke name="read"><parameter name="path">README.md</parameter></invoke>'), text('auto-recovery', TOOL_TEXT_CONTINUE_PROMPT, 'user')];
		running = true; send();
		await page.locator('.task-progress.reminding').waitFor();
		assert.equal(await page.locator('.task-plan-step.running').count(), 1);
		assert.doesNotMatch(await page.locator('.task-progress').textContent(), /等待确认|awaiting confirmation/);
		running = false; fixture = updates; send();
		const headings = page.locator('.task-section-heading');
		assert.deepEqual(await headings.allTextContents(), lang === 'en' ? ['Progress', 'Outputs'] : ['进度', '输出']);
		assert.equal(await page.locator('.task-progress-meta').count(), 0);
		await headings.first().focus(); await page.keyboard.press('Enter');
		assert.equal(await headings.first().getAttribute('aria-expanded'), 'false');
		fixture = [...updates]; send();
		await page.waitForTimeout(100);
		assert.equal(await headings.first().getAttribute('aria-expanded'), 'false');
		assert.equal(await headings.last().getAttribute('aria-expanded'), 'true');
		await headings.first().click();
		fixture = []; send();
		await page.locator('.task-progress.empty').waitFor();
		assert.equal(await page.locator('.task-section-empty').count(), 2);
		assert.match(await page.locator('.task-section-empty').first().textContent(), lang === 'en' ? /longer tasks/ : /较长任务/);
		fixture = updates; send();
		await page.locator('.task-plan-step').last().waitFor();
		// A short sidebar with many output files must not crush the plan.
		const savedFixture = fixture;
		fixture = [...updates, text("next-round", "Inspect the implementation", "user"), ...Array.from({ length: 15 }, (_, i) => [
			{ id: `unassigned-a-${i}`, role: 'assistant', timestamp, content: [{ type: 'toolCall', id: `unassigned-${i}`, name: 'write', argumentsText: JSON.stringify({ path: `src/file-${i}.ts`, content: 'example' }) }] },
			{ id: `unassigned-r-${i}`, role: 'toolResult', timestamp, toolName: 'write', toolCallId: `unassigned-${i}`, content: [{ type: 'text', text: 'result' }] },
		]).flat()];
		await page.setViewportSize({ width, height: 600 }); send();
		await page.locator('.task-file-result').last().waitFor({ state: 'attached' });
		const geometry = await page.locator('.task-plan-list').evaluate(el => ({ height: el.clientHeight, first: el.firstElementChild.getBoundingClientRect().height }));
		assert(geometry.height >= geometry.first, `plan compressed below one complete step: ${JSON.stringify(geometry)}`);
		await page.locator('.task-file-result').last().scrollIntoViewIfNeeded();
		assert(await page.locator('.task-file-result').last().evaluate(el => { const r = el.getBoundingClientRect(); const p = el.closest('.task-progress').getBoundingClientRect(); return r.top >= p.top && r.bottom <= p.bottom + 1; }), 'last execution record is reachable');
		await page.evaluate(() => document.documentElement.dataset.appearance = 'dark');
		await page.screenshot({ path: `tests/scratch/task-outputs-${platform}.png` });
		assert(await page.locator('.task-progress').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
		await page.evaluate(() => document.documentElement.dataset.appearance = 'light');
		await page.locator('.task-file-result > button').last().click();
		await page.locator('.fp-embedded:visible').waitFor();
		assert.match(await page.locator('.fp-embedded').textContent(), /file-14.ts/);
		await page.locator('.fp-embedded .fp-back').click();
		fixture = savedFixture; await page.setViewportSize({ width, height: 900 }); send();

		if (width <= 1100) await page.locator(".drawer-backdrop").click({ position: { x: 10, y: 100 } });

		// Errors stay ordinary tool cards and cannot mutate the valid plan.
		fixture = [...updates, ...pair('rejected', first, 'expectedRevision is stale')]; send();
		await page.locator('.msg[data-msg-id="a-rejected"]').waitFor();
		await page.locator('.task-progress.failed').waitFor({ state: 'attached' });
		assert.equal(await page.locator('.task-plan-step.done').count(), 0);
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
		assert.equal(await page.locator('.task-plan-step.running').count(), 0);
		assert.equal(await page.locator('.task-plan-step.pending').count(), 5);
		fixture.push({ id: 'outside-call', role: 'assistant', timestamp, content: [{ type: 'toolCall', id: 'outside-read', name: 'read', argumentsText: '{"path":"README.md"}' }] }, { id: 'outside-result', role: 'toolResult', toolName: 'read', toolCallId: 'outside-read', timestamp, isError: false, content: [{ type: 'text', text: 'file contents' }] }); send();
		running = true; send();
		await page.locator('.task-progress.running').waitFor();
		assert.match(await page.locator('.header-task-progress').textContent(), lang === 'en' ? /Task progress/ : /任务进度/);
		assert.match(await page.locator('.task-progress-status').textContent(), lang === 'en' ? /awaiting confirmation/ : /等待确认/);
		assert.match(await page.locator('.task-progress-source').first().textContent(), lang === 'en' ? /awaiting confirmation/ : /等待确认/);
		running = false; send();
		await page.locator('.task-progress.waiting').waitFor();
		assert.equal(await page.locator('.task-file-result').count(), 0);
		fixture.push(...pair('last-step', transition({ ...started, action: 'update', expectedRevision: 2, currentStepId: '5', completedStepIds: ['1', '2', '3', '4'] }, started))); send();
		await page.waitForFunction(() => document.querySelector('.task-plan-step.running')?.textContent.includes('提交文档'));
		assert(await page.locator('.task-plan-step.running').evaluate(node => { const rect = node.getBoundingClientRect(), list = node.closest(".task-sections-scroll").getBoundingClientRect(); return rect.top >= list.top - 1 && rect.bottom <= list.bottom + 1; }));
		await headings.first().click();
		await headings.last().click();
		assert.deepEqual(await headings.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-expanded'))), ['false', 'false']);
		// Changing the active conversation resets both sections, even before its snapshot arrives.
		socket.send(JSON.stringify({ type: 'conversations', conversations: [], activeId: 'sidebar-other-conversation' }));
		await page.waitForFunction(() => [...document.querySelectorAll('.task-section-heading')].every(node => node.getAttribute('aria-expanded') === 'true'));
		assert.deepEqual(errors, []);
		await page.close();
		console.log(`PASS ${platform}/${width}/${lang}: merged card, changes, keyboard navigation, sidebar, failure, folded history, replacement and waiting`);
	}
} finally {
	await browser?.close();
	if (server.exitCode === null) { const stopped = new Promise((resolve) => server.once("exit", resolve)); server.kill(); await stopped; }
	rmSync(data, { recursive: true, force: true });
}
