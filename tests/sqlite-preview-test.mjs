/** Real browser/Electron and HTTP regression for the read-only SQLite sidebar. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, _electron as electron } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";

const root = mkdtempSync(join(tmpdir(), "sqlite-ui-"));
const workspace = join(root, "workspace");
const graph = join(workspace, ".codegraph");
mkdirSync(graph, { recursive: true });
const path = join(graph, "graph.db");
const db = new DatabaseSync(path);
db.exec("CREATE TABLE a_nodes(id INTEGER PRIMARY KEY, name TEXT, payload BLOB, missing TEXT); CREATE TABLE empty_table(id INTEGER); CREATE VIEW node_names AS SELECT id,name FROM a_nodes;");
const insert = db.prepare("INSERT INTO a_nodes VALUES (?,?,?,?)");
for (let i = 1; i <= 105; i++) insert.run(i, "节点-" + i, i === 1 ? new Uint8Array(700000) : new Uint8Array([0, 1, 255]), null);
db.exec("INSERT INTO a_nodes VALUES (9223372036854775807,'large integer',NULL,'NULL')");
db.exec("CREATE VIEW broken_view AS SELECT unknown_function(name) FROM a_nodes; CREATE VIEW slow_view AS WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n < 1000000000) SELECT sum(n) AS total FROM x;");
db.close();
copyFileSync(path, join(graph, "no-extension"));
writeFileSync(join(graph, "bad.db"), "not SQLite");
writeFileSync(join(graph, "note.txt"), "regular file");
const before = readFileSync(path);
const env = { ...process.env, PI_WEB_CWD: workspace, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent") };
let browser, app, server;
try {
	let page;
	if (process.argv.includes("--electron")) {
		app = await electron.launch({ args: [".", `--user-data-dir=${join(root, "profile")}`], env });
		for (let i = 0; i < 200; i++) {
			page = app.windows().find((window) => window.url().startsWith("http://127.0.0.1:"));
			if (page) break; await sleep(100);
		}
		assert(page);
	} else {
		assert.equal(await portUp(8993), false);
		server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...env, PORT: "8993" }, stdio: "ignore" });
		for (let i = 0; i < 100 && !(await portUp(8993)); i++) await sleep(100);
		assert(await portUp(8993));
		browser = await chromium.launch({ executablePath: CHROME_PATH });
		page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
		await page.goto("http://127.0.0.1:8993");
	}
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let apiUrl, requests = 0;
	page.on("request", (request) => { if (request.url().includes("/api/sqlite?")) { apiUrl = request.url(); requests++; } });
	await page.locator(".setup-modal .modal-close").click();
	await page.locator(".file-name", { hasText: ".codegraph" }).click();
	await page.locator(".file-name", { hasText: "graph.db" }).click();
	const viewer = page.locator(".sqlite-preview");
	await viewer.locator("tbody tr").first().waitFor({ timeout: 15000 });
	assert.equal(await page.locator(".fp-overlay, .fp-editor, .fp-hex").count(), 0);
	assert.equal(await viewer.locator("tbody tr").count(), 50);
	assert((await viewer.innerText()).includes("节点-1"));
	assert((await viewer.innerText()).includes("BLOB · 3 B"));
	assert((await viewer.innerText()).includes("NULL"));
	await viewer.getByRole("button", { name: "下一页", exact: true }).click();
	await page.waitForFunction(() => document.querySelector(".sqlite-pagination")?.textContent.includes("51–100"));
	await viewer.getByRole("button", { name: "下一页", exact: true }).click();
	await page.waitForFunction(() => document.querySelector(".sqlite-pagination")?.textContent.includes("101–106"));
	assert((await viewer.innerText()).includes("9223372036854775807"));
	assert.equal(await viewer.getByRole("button", { name: "下一页", exact: true }).isDisabled(), true);
	await viewer.getByRole("combobox").selectOption("empty_table");
	await viewer.getByText("这张表暂无数据。").waitFor();
	await viewer.getByRole("combobox").selectOption("node_names");
	await viewer.locator("tbody tr").first().waitFor();
	assert.equal(await viewer.locator("thead th").count(), 3);
	await viewer.getByText("查看表结构", { exact: true }).click();
	assert((await viewer.locator(".sqlite-schema").innerText()).includes("CREATE VIEW"));
	await page.locator(".fp-embedded").screenshot({ path: "/tmp/pi-sqlite-preview.png" });
	const badWorkspace = new URL(apiUrl);
	badWorkspace.searchParams.set("cwd", workspace + "-wrong");
	assert.equal((await page.request.get(badWorkspace.href)).status(), 409);
	const traversal = new URL(apiUrl);
	traversal.searchParams.set("path", "../outside.db");
	assert.equal((await page.request.get(traversal.href)).status(), 400);
	const injection = new URL(apiUrl);
	injection.searchParams.set("table", 'a_nodes"; DROP TABLE a_nodes; --');
	assert.equal((await page.request.get(injection.href)).status(), 400);
		await viewer.getByRole("combobox").selectOption("broken_view");
	await viewer.getByRole("alert").waitFor();
	await viewer.getByRole("combobox").selectOption("node_names");
	await viewer.locator("tbody tr").first().waitFor();
	const slowUrl = new URL(apiUrl);
	slowUrl.searchParams.set("table", "slow_view");
	const slowRequest = page.request.get(slowUrl.href, { timeout: 12000 });
	await sleep(150);
	const healthStart = Date.now();
	assert.equal((await page.request.get(new URL("/api/health", page.url()).href)).status(), 200);
	assert(Date.now() - healthStart < 1500, "database work must not block the chat process");
	const slowResponse = await slowRequest;
	assert.equal(slowResponse.status(), 400);
	assert((await slowResponse.json()).error.includes("timed out"));
	const observedRequests = requests;
	await sleep(1000);
	assert.equal(requests, observedRequests, "no polling while idle");
	assert.deepEqual(readFileSync(path), before, "viewing never changes the database");
	await page.getByRole("button", { name: "返回文件列表", exact: true }).click();
	await page.locator(".file-name", { hasText: "bad.db" }).click();
	await viewer.getByRole("alert").waitFor();
	assert((await viewer.getByRole("alert").innerText()).includes("Not a SQLite"));
	await page.getByRole("button", { name: "返回文件列表", exact: true }).click();
	await page.locator(".file-name", { hasText: "no-extension" }).click();
	await viewer.locator("tbody tr").first().waitFor();
	// A cancelled/delayed database response must not replace a subsequently opened text file.
	await page.route("**/api/sqlite?**", async (route) => { await sleep(300); await route.continue().catch(() => {}); });
	await viewer.getByRole("button", { name: "刷新", exact: true }).click();
	await page.getByRole("button", { name: "返回文件列表", exact: true }).click();
	await page.locator(".file-name", { hasText: "note.txt" }).click();
	await page.locator(".fp-editor").waitFor();
	await sleep(500);
	assert.equal(await page.locator(".fp-editor").inputValue(), "regular file");
	assert.equal(await viewer.count(), 0);
	assert.deepEqual(errors, []);
	console.log("PASS SQLite sidebar: hidden directory, data/columns/views/pagination, empty/corrupt files, int64/blob/null, read-only, workspace isolation and late responses");
} finally {
	await browser?.close();
	if (app) await app.close();
	if (server?.pid && server.exitCode === null && server.signalCode === null) {
		server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve));
	}
}
