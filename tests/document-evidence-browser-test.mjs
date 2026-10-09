/** Explicit evidence links work without index membership and open read-only. No model calls. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";

const port = 9269;
assert.equal(await portUp(port), false, "isolated port must be free");
const base = realpathSync(mkdtempSync(join(tmpdir(), "doc-evidence-")));
const cwd = join(base, "workspace"), agent = join(base, "agent");
mkdirSync(agent); mkdirSync(join(cwd, "knowledge/evidence/source"), { recursive: true });
writeFileSync(join(cwd, "README.md"), "# Knowledge entry\n\n[原始资料](./knowledge/evidence/source/original.md)\n");
writeFileSync(join(cwd, "knowledge/manifest.json"), JSON.stringify({ kind: "pi-harness-knowledge", version: 1, evidenceDirectory: "evidence" }));
const rawPath = join(cwd, "knowledge/evidence/source/original.md"), raw = "# Archived evidence\n\n原始文件内容应保持不变。\n";
writeFileSync(rawPath, raw);
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "unused", models: [{ id: "unused", name: "Unused local model", input: ["text"], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "unused" }));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "unused" } }));
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: "", PI_WEB_HOST: "127.0.0.1", PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
let log = "", browser;
server.stdout.on("data", data => { log += data; }); server.stderr.on("data", data => { log += data; });
try {
	for (let i = 0; i < 150 && !await portUp(port); i++) {
		assert.equal(server.exitCode, null, log);
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
	assert.equal(health.pid, server.pid);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(15000);
	const errors = []; page.on("pageerror", error => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".conn-dot.ok").first().waitFor({ state: "attached" });
	await page.locator(".file-name", { hasText: "README.md" }).first().evaluate(element => element.click());
	await page.locator(".wiki-document-heading h1", { hasText: "Knowledge entry" }).waitFor();
	await page.locator(".wiki-prose a", { hasText: "原始资料" }).click();
	await page.locator(".wiki-document-heading h1", { hasText: "Archived evidence" }).waitFor();
	assert.equal(await page.locator(".wiki-prose [contenteditable=true]").count(), 0);
	assert.equal(readFileSync(rawPath, "utf8"), raw);
	assert.deepEqual(errors, []);
	console.log("PASS explicit unindexed evidence navigation and read-only document rendering");
} catch (error) { console.error(log.slice(-6000)); throw error; }
finally {
	await browser?.close();
	if (server.exitCode === null && server.signalCode === null) { const stopped = once(server, "exit"); server.kill(); await stopped; }
	rmSync(base, { recursive: true, force: true });
}
