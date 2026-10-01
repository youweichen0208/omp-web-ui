/** Sidebar rows keep time visible, and put destructive actions in one menu. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";

const port = 8996;
const base = mkdtempSync(join(tmpdir(), "sidebar-menu-"));
const cwd = join(base, "workspace");
mkdirSync(cwd);
const sessionPath = join(base, "greeting.jsonl");
const modified = Date.now();
let server, browser;
const sent = [];
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: join(base, "agent") }, stdio: "ignore" });
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	assert(await portUp(port));
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
	await page.routeWebSocket("**/ws", (route) => {
		const upstream = route.connectToServer();
		route.onMessage((wire) => {
			const message = JSON.parse(wire.toString());
			sent.push(message);
			if (!["rename_session", "delete_session", "remove_project"].includes(message.type)) upstream.send(wire);
		});
		upstream.onMessage((wire) => {
			const message = JSON.parse(wire.toString());
			if (message.type === "projects") message.projects = [
				{ path: cwd, lastUsed: modified, lastConversationAt: modified, conversationCount: 2 },
				{ path: "/Users/sidebar-test", lastUsed: modified - 1000, conversationCount: 3 },
				{ path: "/", lastUsed: modified - 2000, conversationCount: 1 },
			];
			if (message.type === "sessions") message.sessions = [
				{ path: sessionPath, firstMessage: "hello", messageCount: 2, modified },
				{ path: join(base, "long.jsonl"), firstMessage: "Go defer 关键字一句话解释", messageCount: 2, modified: modified - 1000 },
			];
			if (message.type === "conversations") message.conversations = [{ id: message.activeId, title: "hello", cwd, messageCount: 2, isStreaming: false, sessionFile: sessionPath, createdAt: modified }];
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://localhost:${port}`);
	await page.locator(".setup-modal .modal-close").click();
	await page.locator(".project-item.active .project-count", { hasText: "2" }).waitFor();
	assert.equal(await page.locator(".project-path").count(), 0);
	assert.equal(await page.locator(".project-name", { hasText: "根目录" }).count(), 1);
	assert.equal(await page.locator(".project-name", { hasText: "~" }).count(), 1);
	const activeProject = page.locator(".project-item.active");
	assert.equal(await activeProject.locator(".project-chevron").count(), 1);
	const greeting = page.locator(".session-item.active", { hasText: "打招呼" });
	await greeting.waitFor();
	assert.equal(await page.locator(".header-location strong").textContent(), "打招呼");
	assert(await greeting.locator(".session-time").isVisible());
	const greetingRow = page.locator(".lp-row", { has: greeting }).last();
	assert.equal(await greetingRow.locator(".lp-menu-trigger").isVisible(), false);
	const rightEdges = await page.evaluate(() => ({ project: document.querySelector(".project-item.active").getBoundingClientRect().right, selected: document.querySelector(".session-item.active").getBoundingClientRect().right }));
	assert(rightEdges.selected <= rightEdges.project - 5, JSON.stringify(rightEdges));
	await greeting.hover();
	assert.equal(await greeting.locator(".session-time").isVisible(), false);
	await greetingRow.locator(".lp-menu-trigger").click();
	await greetingRow.getByRole("menuitem", { name: "重命名该对话" }).click();
	await page.locator(".lp-inline-input").fill("自定义标题");
	await page.locator(".lp-inline-form").getByRole("button", { name: "确认" }).click();
	assert(sent.some((message) => message.type === "rename_session" && message.name === "自定义标题"));
	await greeting.hover();
	await greetingRow.locator(".lp-menu-trigger").click();
	await greetingRow.getByRole("menuitem", { name: "删除该对话记录（不可恢复）" }).click();
	assert.equal(sent.filter((message) => message.type === "delete_session").length, 0);
	await greetingRow.getByRole("menuitem", { name: "确认删除" }).click();
	assert.equal(sent.filter((message) => message.type === "delete_session").length, 1);
	await activeProject.click();
	assert.equal(await page.locator(".panel-sessions").count(), 0);
	await activeProject.click();
	await greeting.waitFor();
	await activeProject.hover();
	const projectRow = page.locator(".lp-row", { has: activeProject }).first();
	await projectRow.locator(":scope > .lp-menu-zone .lp-menu-trigger").click();
	await projectRow.getByRole("menuitem", { name: "从最近项目移出" }).click();
	assert.equal(sent.filter((message) => message.type === "remove_project").length, 0);
	await projectRow.getByRole("menuitem", { name: "确认移出" }).click();
	assert.equal(sent.filter((message) => message.type === "remove_project").length, 1);
	console.log("PASS sidebar: times, hover menus, two-step delete, counts, paths, title and selected-row spacing");
} finally {
	await browser?.close();
	server?.kill("SIGTERM");
}
