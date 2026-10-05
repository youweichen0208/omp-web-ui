// Zero-model regression: real native extension callbacks across two conversations.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
const PORT = Number(process.env.PI_TEST_PORT || 9141);
assert(PORT >= 8900); assert.equal(await portUp(PORT), false);
const root = mkdtempSync(join(tmpdir(), "pi-extension-ui-"));
const agent = join(root, "agent"), cwd = join(root, "work");
mkdirSync(join(agent, "extensions"), { recursive: true }); mkdirSync(cwd);
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "unused", models: ["fixture", "fixture-alt"].map(id => ({ id, reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 1024 })) } } }));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "unused" } }));
const settings = JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: true }, compaction: { enabled: true } });
writeFileSync(join(agent, "settings.json"), settings);
writeFileSync(join(agent, "extensions/ui.ts"), `export default function(pi) {
 pi.registerCommand("fixture-ui", { handler: async (args, ctx) => {
  const ui = ctx.ui; ui.setWidget("same", [args]); ctx.ui.setStatus("same", args); ctx.ui.setTitle("title-" + args);
  pi.sendMessage({customType:"fixture", content:"fixture-" + args, display:true});
  void ctx.ui.confirm("permission-" + args, "Allow?").then(value => ui.notify("answer-" + args + ":" + value));
 }});
 pi.registerCommand("fixture-editor", { handler: async (args, ctx) => { const text = await ctx.ui.editor("multiline", "first\\nsecond"); if(text !== undefined) ctx.ui.setEditorText(text); } });
 pi.registerCommand("fixture-timeout", { handler: async (args, ctx) => { void ctx.ui.input("timeout", "", {timeout:200}).then(value => ctx.ui.notify("timeout:" + value)); } });
 pi.registerCommand("mcp", { handler: async (_args, ctx) => ctx.ui.notify("third-party-mcp") });
}`);
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(PORT), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; server.stdout.on("data", d => logs += d); server.stderr.on("data", d => logs += d);
let ws, browser;
const wire = [];
async function wait(predicate, timeout = 12000) {
 const end = Date.now() + timeout;
 while (Date.now() < end) { const m = wire.find(predicate); if (m) return m; await sleep(20); }
 throw new Error("Timed out: " + predicate + "\n" + logs.slice(-1500));
}
function send(message) { ws.send(JSON.stringify(message)); }
async function connect() {
 ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
 ws.on("message", raw => wire.push(JSON.parse(raw)));
 await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
 send({ type: "hello", clientId: "extension-ui-test", protocolVersion: 37 });
 await wait(m => m.type === "ready");
}
try {
 for (let n = 0; n < 100 && !(await portUp(PORT)); n++) await sleep(100);
 await connect();
 const a = (await wait(m => m.type === "snapshot")).state.conversationId;
 send({ type: "prompt", text: "/fixture-ui A" });
 const da = await wait(m => m.type === "dialog" && m.title === "permission-A");
 assert.equal(da.conversationId, a);
 send({ type: "terminal_create", terminalId: "fixture-terminal", cwd, cols: 80, rows: 24, conversationId: a });
 await wait(m => m.type === "terminal_list" && m.terminals.length > 0);
 send({ type: "new_chat" });
 const b = (await wait(m => m.type === "snapshot" && m.state.conversationId !== a)).state.conversationId;
 send({ type: "prompt", text: "/fixture-ui B" });
 const db = await wait(m => m.type === "dialog" && m.title === "permission-B"); assert.notEqual(db.id, da.id);
 send({ type: "dialog_response", conversationId: a, id: da.id, value: true });
 send({ type: "dialog_response", conversationId: b, id: da.id, value: true });
 send({ type: "dialog_response", id: db.id, value: true });
 await sleep(150); assert(!wire.some(m => m.type === "dialog_closed" && [da.id, db.id].includes(m.id)));
 send({ type: "dialog_response", conversationId: b, id: db.id, value: false });
 await wait(m => m.type === "notice" && m.text === "answer-B:false");
 wire.length = 0; ws.close(); await sleep(100); await connect();
 assert.equal((await wait(m => m.type === "dialog")).id, da.id);
 await sleep(100); assert(!wire.some(m => m.type === "dialog" && m.id === db.id));
 send({ type: "switch_conversation", id: a });
 await wait(m => m.type === "snapshot" && m.state.conversationId === a);
 send({ type: "dialog_response", conversationId: a, id: da.id, value: true });
 await wait(m => m.type === "notice" && m.text === "answer-A:true");
 send({ type: "set_run_settings", conversationId: a, autoCompaction: false, autoRetry: false });
 await wait(m => ["snapshot", "snapshot_delta"].includes(m.type) && m.state.runSettings?.autoRetry === false);
 send({ type: "prompt", text: "/fixture-timeout" }); await wait(m => m.type === "notice" && m.text === "timeout:undefined");
 const assertRunSettings = (state, enabled) => {
  assert.equal(state.runSettings.autoCompaction, enabled);
  assert.equal(state.runSettings.autoRetry, enabled);
 };
 for (const [message, matches] of [
  [{ type: "set_thinking", level: "high" }, state => state.thinkingLevel === "high"],
  [{ type: "set_model", modelId: "fixture/fixture-alt" }, state => state.model?.id === "fixture-alt"],
 ]) {
  wire.length = 0; send(message);
  const updated = await wait(m => ["snapshot", "snapshot_delta"].includes(m.type) && m.state.conversationId === a && matches(m.state));
  assertRunSettings(updated.state, false);
  assert(!wire.some(m => m.type === "notice" && m.level === "error"));
 }
 wire.length = 0; ws.close(); await sleep(100); await connect(); send({ type: "get_state" });
 assertRunSettings((await wait(m => m.type === "snapshot" && m.state.conversationId === a)).state, false);
 wire.length = 0; send({ type: "switch_conversation", id: b });
 assertRunSettings((await wait(m => m.type === "snapshot" && m.state.conversationId === b)).state, true);
 send({ type: "prompt", text: "/fixture-timeout" }); await wait(m => m.type === "notice" && m.text === "timeout:undefined");
 wire.length = 0; send({ type: "switch_conversation", id: a });
 assertRunSettings((await wait(m => m.type === "snapshot" && m.state.conversationId === a)).state, false);
 send({ type: "prompt", text: "/fixture-ui reload" }); const old = await wait(m => m.type === "dialog" && m.title === "permission-reload");
 send({ type: "prompt", text: "/reload" }); await wait(m => m.type === "dialog_closed" && m.id === old.id);
 await wait(m => m.type === "reload_status" && m.phase === "done");
 send({ type: "prompt", text: "/mcp" }); await wait(m => m.type === "notice" && m.text === "third-party-mcp");
 send({ type: "prompt", text: "/fixture-ui after-reload" }); const after = await wait(m => m.type === "dialog" && m.title === "permission-after-reload");
 assert.notEqual(after.id, old.id);
 send({ type: "dialog_response", conversationId: a, id: old.id, value: true });
 send({ type: "dialog_response", conversationId: a, id: after.id, value: false });
 await wait(m => m.type === "notice" && m.text === "answer-after-reload:false");
 wire.length = 0; send({ type: "get_state" });
 assertRunSettings((await wait(m => m.type === "snapshot" && m.state.conversationId === a)).state, false);
 const persisted = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
 assert.equal(persisted.compaction.enabled, true); assert.equal(persisted.retry.enabled, true);
 assert.equal(persisted.defaultTools, undefined);
 assert.equal(persisted.defaultProvider, "fixture");

 if (process.argv.includes("--browser")) {
  browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  const page = await browser.newPage();
  let browserSocket, snapshot; const sent = [];
  await page.routeWebSocket("**/ws", route => {
   browserSocket = route; const upstream = route.connectToServer();
   route.onMessage(raw => { const m = JSON.parse(String(raw)); sent.push(m); if (m.type !== "cancel_recovery") upstream.send(raw); });
   upstream.onMessage(raw => { const m = JSON.parse(String(raw)); if (m.type === "snapshot") snapshot = m.state; route.send(raw); });
  });
  await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "extension-ui-test"));
  await page.goto(`http://127.0.0.1:${PORT}`);
  await page.waitForSelector(".inputbox textarea");
  send({ type: "prompt", text: "/fixture-editor" });
  await page.waitForSelector('[data-dialog-kind="editor"] textarea');
  assert.equal(await page.locator('[data-dialog-kind="editor"] textarea').inputValue(), "first\nsecond");
  await page.locator('[data-dialog-kind="editor"] textarea').fill("edited\nmultiline");
  await page.locator('[data-dialog-kind="editor"] .primary').click();
  await page.waitForFunction(() => document.querySelector(".inputbox textarea")?.value === "edited\nmultiline");
  send({ type: "prompt", text: "/fixture-ui browser-A" });
  const prompt = await wait(m => m.type === "dialog" && m.title === "permission-browser-A");
  send({ type: "switch_conversation", id: b });
  await page.waitForFunction(() => !document.querySelector('[data-dialog-kind="confirm"]'));
  await page.getByRole("button", { name: /permission-browser-A/ }).click();
  await page.waitForSelector('[data-dialog-kind="confirm"]');
  assert.equal(await page.title(), "title-browser-A");
  send({ type: "dialog_response", conversationId: a, id: prompt.id, value: false });
  await page.locator('[data-dialog-kind="confirm"]').waitFor({ state: "hidden" });
  const beforeRetry = sent.filter(m => m.type === "retry_silent_prompt").length;
  const recoveryState = { ...snapshot, rev: snapshot.rev + 1, isStreaming: true, messages: [{ id: "recovery-user", role: "user", timestamp: Date.now() - 240000, content: [{ type: "text", text: "fixture" }] }], recovery: { compaction: { id: "long-compaction", reason: "overflow" }, summary: { id: "summary-retry", source: "compaction", phase: "waiting", attempt: 2, maxAttempts: 3, remainingMs: 10000, error: "529 overload" } } };
  browserSocket.send(JSON.stringify({ type: "snapshot", state: recoveryState }));
  await page.getByText(/等待摘要重试/).waitFor();
  assert.equal(await page.locator(".waiting-header-status").count(), 0);
  await page.locator('.agent-silence button', { hasText: "取消" }).click();
  assert(sent.some(m => m.type === "cancel_recovery" && m.operationId === "summary-retry" && m.conversationId === a));
  assert.equal(sent.filter(m => m.type === "retry_silent_prompt").length, beforeRetry);
  browserSocket.send(JSON.stringify({ type: "snapshot", state: { ...recoveryState, rev: recoveryState.rev + 1, recovery: { compaction: recoveryState.recovery.compaction } } }));
  await page.getByText("正在压缩", { exact: true }).waitFor();
  browserSocket.send(JSON.stringify({ type: "snapshot", state: { ...snapshot, rev: recoveryState.rev + 2, recovery: {} } }));
  await page.getByText("正在压缩", { exact: true }).waitFor({ state: "hidden" });
 }
 console.log("PASS native extension UI isolation, validation, reconnect, timeout, reload, override command and memory settings" + (browser ? ", browser multiline editor, background navigation and recovery phases" : ""));
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
 await browser?.close(); ws?.close();
 const exited = new Promise(resolve => server.once("exit", resolve)); server.kill("SIGTERM"); await exited;
 rmSync(root, { recursive: true, force: true });
}
