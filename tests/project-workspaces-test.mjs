import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import WebSocket from "ws";

const base = mkdtempSync(join(tmpdir(), "pi-workspace-groups-"));
const projects = ["project-a", "project-b"].map((name) => join(base, name));
for (const path of projects) mkdirSync(path);
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
assert(port >= 8900);
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: projects[0], PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: join(base, "agent"), PI_WEB_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
server.stdout.on("data", (data) => { logs += data; });
server.stderr.on("data", (data) => { logs += data; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sockets = [];
let browser;
async function client(id) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(socket);
	const messages = [];
	socket.on("message", (raw) => messages.push(JSON.parse(raw)));
	await new Promise((r, reject) => { socket.once("open", r); socket.once("error", reject); });
	const send = (message) => socket.send(JSON.stringify(message));
	const wait = async (test) => {
		for (let i = 0; i < 500; i++) { const message = messages.find(test); if (message) return message; await sleep(20); }
		throw new Error(`Message timeout: ${messages.slice(-5).map((m) => m.type)}\n${logs.slice(-2000)}`);
	};
	send({ type: "hello", clientId: id }); await wait((m) => m.type === "snapshot");
	send({ type: "list_project_workspaces" }); await wait((m) => m.type === "project_workspaces");
	return { send, wait, messages };
}
try {
	for (let i = 0; i < 150; i++) {
		try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
		if (i === 149 || server.exitCode !== null) throw new Error(logs);
		await sleep(100);
	}
	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core");
		const { CHROME_PATH } = await import("./lib/chrome.mjs");
		assert(CHROME_PATH, "Chrome unavailable");
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		const first = await browser.newPage();
		await first.addInitScript(() => localStorage.setItem("pi-harness:project-workspace", "deleted-workspace"));
		await first.goto(`http://127.0.0.1:${port}`);
		await first.locator(".setup-modal .modal-close").waitFor(); await first.locator(".setup-modal .modal-close").click();
		await first.locator(".workspace-group-manager input").waitFor();
		assert.equal(await first.locator(".project-item, .session-item, .sidebar-new").count(), 0);
		assert.equal(await first.getByText("全部项目", {exact:true}).count(), 0);
		assert.equal(await first.locator(".lp-add-project").count(), 0);
		await first.reload();
		await first.locator(".setup-modal .modal-close").waitFor(); await first.locator(".setup-modal .modal-close").click();
		await first.locator(".workspace-group-manager input").waitFor();
		assert.equal(await first.locator(".project-item, .session-item").count(), 0);
		await first.screenshot({path: join(tmpdir(), "pi-workspace-first-start.png")});
		await first.close();
	}
	const a = await client("workspace-test-a");
	const b = await client("workspace-test-b");
	a.send({ type: "project_workspace_action", requestId: "create", revision: 0, action: { kind: "create", name: "Work" } });
	const created = await a.wait((m) => m.type === "project_workspace_result" && m.requestId === "create");
	assert.equal(created.ok, true);
	const id = created.workspaceId;
	const synced = await b.wait((m) => m.type === "project_workspaces" && m.catalog.revision === 1);
	assert.equal(synced.catalog.workspaces[0].id, id);
	b.send({ type: "project_workspace_action", requestId: "stale", revision: 0, action: { kind: "delete", id } });
	assert.equal((await b.wait((m) => m.requestId === "stale")).ok, false);
	a.send({ type: "project_workspace_action", requestId: "add", revision: 1, action: { kind: "add", id, path: projects[1] } });
	assert.equal((await a.wait((m) => m.requestId === "add")).ok, true);
	await b.wait((m) => m.type === "project_workspaces" && m.catalog.revision === 2);
	a.send({ type: "get_state" });
	assert(a.messages.filter((m) => m.type === "snapshot").every((m) => m.state.cwd === projects[0]));
	const disk = JSON.parse(readFileSync(join(base, "data", "project-workspaces.json"), "utf8"));
	assert.deepEqual(disk.workspaces[0].paths, [projects[1]]);
	console.log("PASS workspace protocol: shared catalog, conflict recovery, persisted membership, unchanged cwd");
	if (process.argv.includes("--browser")) {
		const page = await browser.newPage();
		const outgoing = [];
		page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => outgoing.push(JSON.parse(String(payload)))));
		await page.goto(`http://127.0.0.1:${port}`);
		await page.locator(".setup-modal .modal-close").waitFor(); await page.locator(".setup-modal .modal-close").click();
		const selector = page.locator(".workspace-group-row select");
		await selector.locator(`option[value="${id}"]`).waitFor({ state: "attached" });
		const switches = () => outgoing.filter((m) => m.type === "set_cwd").length;
		const before = switches();
		assert.equal(await selector.inputValue(), id, "select the first existing workspace automatically");
		assert.equal(await selector.locator('option[value=""]').count(), 0);
		await page.locator(`.project-item[title="${projects[1]}"]`).waitFor();
		assert.equal(await page.locator(`.project-item[title="${projects[0]}"]`).count(), 0);
		assert.equal(await page.locator(".workspace-outside").count(), 1);
		assert.equal(switches(), before);
		await page.reload();
		await page.locator(".setup-modal .modal-close").waitFor(); await page.locator(".setup-modal .modal-close").click();
		await page.locator(`.project-item[title="${projects[1]}"]`).waitFor();
		assert.equal(await selector.inputValue(), id);
		await page.locator(".workspace-project-search").fill("missing");
		assert.equal(await page.locator(".project-item").count(), 0);
		await page.locator(".workspace-project-search").fill("");
		await page.locator(".workspace-group-row button").click();
		await page.locator(".workspace-group-manager input").fill("Engineering");
		a.send({ type: "project_workspace_action", requestId: "remote-rename", revision: 2, action: { kind: "rename", id, name: "Remote name" } });
		await page.waitForFunction(() => document.querySelector(".workspace-group-row select")?.selectedOptions[0]?.textContent === "Remote name");
		assert.equal(await page.locator(".workspace-group-manager input").inputValue(), "Engineering");
		await page.locator(".workspace-group-actions button[type=button]").click();
		await page.waitForFunction(() => document.querySelector(".workspace-group-row select")?.selectedOptions[0]?.textContent === "Engineering");
		await page.locator(`.project-item[title="${projects[1]}"]`).click();
		await page.locator(`.project-item.active[title="${projects[1]}"]`).waitFor();
		assert.equal(switches(), before + 1);
		await page.locator(`.lp-menu-zone[data-menu-key="proj:${projects[1]}"] .lp-menu-trigger`).click();
		assert.equal(await page.getByRole("menuitem", {name:"新对话", exact:true}).count(), 1);
		await page.keyboard.press("Escape");
		await page.screenshot({ path: join(tmpdir(), "pi-53-workspaces-desktop.png") });
		await page.locator(".workspace-group-delete").click(); await page.locator(".workspace-group-delete").click();
		await page.waitForFunction(() => document.querySelector(".workspace-group-row select")?.value === "");
		assert(existsSync(projects[1]));
		assert.equal(await page.locator(".project-item, .session-item, .sidebar-new").count(), 0, "deleting the last workspace does not expose recent projects");
		// Manage a group on a narrow viewport without closing the drawer.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.locator(".topbar .brand .panel-toggle").click();
		await page.locator(".workspace-group-manager input").fill("Mobile");
		await page.locator(".workspace-group-actions button[type=submit]").click();
		await page.waitForFunction(() => document.querySelector(".workspace-group-row select")?.selectedOptions[0]?.textContent === "Mobile");
		assert.equal(await page.locator(".drawer-left.open").count(), 1);
		assert.equal(await page.locator(".project-item").count(), 0, "new workspaces start empty");
		await page.locator(".lp-add-project").click();
		await page.locator(".fpk-modal-foot input").fill(join(base, "missing"));
		await page.locator(".fpk-open-btn").click();
		await page.locator(".fpk-modal [role=alert]").waitFor();
		await page.locator(".fpk-modal-foot input").fill(projects[0]);
		await page.locator(".fpk-open-btn").click();
		await page.locator(".fpk-modal").waitFor({ state: "detached" });
		assert.equal(await page.locator(".drawer-left.open").count(), 1);
		assert.equal(switches(), before + 1);
		assert.equal(outgoing.filter((m) => m.type === "prompt").length, 0);
		await page.screenshot({ path: join(tmpdir(), "pi-53-workspaces-mobile.png") });
		console.log("PASS workspace browser: filtering, reload preference, search, rename, explicit project switch, non-destructive deletion");
	}
} finally {
	await browser?.close();
	for (const socket of sockets) socket.close();
	server.kill("SIGTERM");
	await Promise.race([new Promise((r) => server.once("exit", r)), sleep(5000)]);
	if (server.exitCode === null) { server.kill("SIGKILL"); await new Promise((r) => server.once("exit", r)); }
	rmSync(base, { recursive: true, force: true });
}
