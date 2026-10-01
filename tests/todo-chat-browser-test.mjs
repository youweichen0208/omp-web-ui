/** Zero-token Web / desktop-shell checklist presentation and history navigation.
 * Run after npm run build. Uses isolated server/data and serialized todo fixtures. */
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
const data = mkdtempSync(join(tmpdir(), "pi-todo-chat-"));
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_DATA_DIR: data, PI_WEB_CWD: data, PI_CODING_AGENT_DIR: join(data, "agent") }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser;
server.stdout.on("data", (chunk) => { logs += chunk; });
server.stderr.on("data", (chunk) => { logs += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timestamp = Date.now();
const text = (id, body, role = "assistant") => ({ id, role, timestamp, content: [{ type: "text", text: body }] });
const tasks = ["核实 SG 上真实 Hermes usage 属性", "确认 SSH 配置指向 sg-prod", "跨进程透传 usage", "补测试", "提交并更新文档"].map((subject, i) => ({ id: i + 1, subject, status: "pending" }));
function pair(id, tasks, action = "update", error) {
	const details = { action, nextId: 6, tasks, error };
	const result = serializeMessage({ role: "toolResult", toolCallId: id, toolName: "todo", timestamp, isError: false, content: [{ type: "text", text: error || "Recorded" }], details }, 0);
	return [{ id: `a-${id}`, role: "assistant", timestamp, content: [{ type: "toolCall", id, name: "todo", argumentsText: JSON.stringify({ action }) }] }, { ...result, details }];
}
const initial = [text("question", "核实 Hermes 的 usage 并补充测试", "user"), text("intro", "首先核实 SG 上 Hermes checkout 的 usage 属性。让我先建立 todo 清单。")];
for (let i = 1; i <= 5; i++) initial.push(...pair(`create-${i}`, tasks.slice(0, i), "create"));
initial.push(...pair("list", tasks, "list"));
const started = tasks.map((task, i) => ({ ...task, status: i === 0 ? "in_progress" : "pending" }));
const updates = [...initial, text("explain", "现在核实 SG 的 SSH 配置。"), ...pair("start", started)];

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
		let socket, baseState, fixture = initial.slice(0, 4);
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
		assert.equal(await page.locator(".todo-checklist-item").count(), 1);
		fixture = initial; send();
		await page.waitForFunction(() => document.querySelectorAll(".todo-checklist-item").length === 5);
		assert.equal(await page.locator(".todo-checklist").count(), 1);
		assert.equal(await page.locator(".todo-checklist-item").count(), 5);
		assert.equal(await page.locator(".task-plan-card, .todo-update").count(), 0);
		assert.equal(await page.locator('.msg[data-msg-id="a-create-2"]').count(), 0);
		assert.match(await page.locator(".todo-checklist-head").textContent(), lang === "en" ? /5 items · 0 completed/ : /5 项 · 已完成 0/);
		fixture = updates; send();
		await page.locator(".todo-update button").waitFor();
		assert.match(await page.locator(".todo-update").textContent(), lang === "en" ? /Item 1 started/ : /第 1 项开始/);
		assert.equal(await page.locator(".todo-checklist").count(), 1);
		await page.locator(".todo-update button").focus();
		await page.keyboard.press("Enter");
		await page.locator('.todo-checklist-item[data-todo-item-id="1"].todo-item-flash').waitFor();
		assert(await page.locator('.todo-checklist-item[data-todo-item-id="1"]').evaluate((node) => node === document.activeElement));
		assert(await page.locator(".todo-checklist").evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
		await page.screenshot({ path: `tests/scratch/todo-chat-${platform}.png` });
		await page.locator(".header-task-progress").click();
		await page.locator(".task-progress:visible").waitFor();
		assert.equal(await page.locator(".task-plan-step").count(), 5);
		if (width <= 1100) await page.locator(".drawer-backdrop").click({ position: { x: 10, y: 100 } });

		// A persisted failure must remain visible and leave the successful card intact.
		fixture = [...updates, ...pair("rejected", [], "clear", "Cannot clear this checklist")]; send();
		await page.locator(".task-plan-card.err").waitFor();
		assert.equal(await page.locator(".todo-checklist-item").count(), 5);
		assert.match(await page.locator(".task-todo-details").textContent(), /Cannot clear/);

		// Long history folds the first card; View must restore it and pin the changed item.
		fixture = [...updates];
		for (let i = 0; i < 35; i++) fixture.push(text(`history-${i}`, `历史记录 ${i}\n\n${"核实记录。".repeat(30)}`, i % 2 ? "assistant" : "user"));
		fixture.push(...pair("finish", tasks.map((task, i) => ({ ...task, status: i === 0 ? "completed" : "pending" })))); send();
		await page.locator('.todo-update[data-tool-call-id="finish"] button').waitFor();
		await page.locator('.todo-update[data-tool-call-id="finish"] button').click();
		await page.locator('.todo-checklist-item[data-todo-item-id="1"].todo-item-flash.completed').waitFor();
		assert(await page.locator('.todo-checklist-item[data-todo-item-id="1"]').evaluate((node) => {
			const rect = node.getBoundingClientRect(), viewport = document.querySelector(".messages").getBoundingClientRect();
			return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
		}));

		// Restore a short branch; clear + new list with reused #1 cannot target the old card.
		fixture = [...initial, ...pair("clear", [], "clear"), ...pair("new", [{ ...tasks[0], subject: "新的任务" }], "create"), text("new-body", "开始新的任务"), ...pair("new-start", [{ ...tasks[0], subject: "新的任务", status: "in_progress" }])]; send();
		await page.locator('.todo-update[data-tool-call-id="new-start"] button').waitFor();
		await page.locator('.todo-update[data-tool-call-id="new-start"] button').click();
		await page.locator('.todo-checklist[data-tool-call-id="new"] .todo-item-flash').waitFor();
		assert.equal(await page.locator(".todo-checklist").count(), 2);
		assert.equal(await page.locator('.todo-checklist[data-tool-call-id="create-1"] .todo-item-flash').count(), 0);
		assert.deepEqual(errors, []);
		await page.close();
		console.log(`PASS ${platform}/${width}/${lang}: merged card, changes, keyboard navigation, sidebar, failure, folded history and clear`);
	}
} finally {
	await browser?.close();
	if (server.exitCode === null) { const stopped = new Promise((resolve) => server.once("exit", resolve)); server.kill(); await stopped; }
	rmSync(data, { recursive: true, force: true });
}
