// Native SDK session tree contract through the production WebSocket routes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { portUp } from "./lib/port-utils.mjs";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
const PORT = Number(process.env.PI_TEST_PORT || 9254), MOCK = PORT + 1;
assert(PORT >= 8900);
for (const port of [PORT, MOCK]) assert.equal(await portUp(port), false, `port ${port} occupied`);
const root = mkdtempSync(join(tmpdir(), "pi-tree-test-")), cwd = join(root, "work"), agent = join(root, "agent");
mkdirSync(cwd); mkdirSync(join(agent, "extensions"), { recursive: true });
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${MOCK}/v1`, apiKey: "unused", models: [{ id: "tree", reasoning: true, contextWindow: 64000, maxTokens: 1024, input: ["text"] }] } } }));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "unused" } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "tree", retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } }));
writeFileSync(join(agent, "extensions/tree-fixture.ts"), `export default function(pi) {
 pi.on("session_before_tree", async (event, ctx) => {
  if (event.preparation.customInstructions === "extension-cancel") return { cancel: true };
  if (event.preparation.customInstructions === "extension-dialog") {
   if (!await ctx.ui.confirm("tree-permission", "Switch?", {signal:event.signal})) return {cancel:true};
  }
 });
}`);
let replyCount = 0, slowSummary = false, failSummary = false, holdNext = false;
const mock = createServer(async (req, res) => {
	let body = ""; for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body);
	if (holdNext) { holdNext = false; res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); return; }
	if (JSON.stringify(payload).includes("delay-summary")) {
		slowSummary = true; res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); return;
	}
	if (JSON.stringify(payload).includes("fail-summary")) { failSummary = true; res.writeHead(400).end(JSON.stringify({ error: { message: "fixture summary failure" } })); return; }
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "tree-response", object: "chat.completion.chunk", created: Date.now(), model: payload.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
	res.write(chunk({ content: `fixture answer ${++replyCount}` }));
	res.write(chunk({}, "stop")); res.end("data: [DONE]\n\n");
});
await new Promise(resolve => mock.listen(MOCK, "127.0.0.1", resolve));
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(PORT), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", ws, browser, state;
server.stdout.on("data", d => logs += d); server.stderr.on("data", d => logs += d);
const wire = [];
let sequence = 0;
async function wait(predicate, timeout = 15000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) { const result = await predicate(); if (result) return result; await sleep(20); }
	throw new Error(`Timeout: ${predicate}\n${logs.slice(-2000)}`);
}
function send(message) { ws.send(JSON.stringify(message)); }
async function connect() {
	ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	ws.on("message", raw => { const m = JSON.parse(raw); wire.push(m); if (m.type === "snapshot") state = m.state; if (m.type === "snapshot_delta" && state) state = { ...state, ...m.state, messages: [...state.messages, ...m.appended] }; });
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	send({ type: "hello", clientId: "tree-test", protocolVersion: 37 }); send({ type: "get_state" });
	await wait(() => state);
}
async function request(type, fields = {}) {
	const reqId = `test-${++sequence}`;
	const start = wire.length;
	send({ type, reqId, conversationId: state.conversationId, ...fields });
	const result = await wait(() => wire.find(m => m.reqId === reqId));
	if (type === "tree_navigate" && fields.summary === "none" && result.status === "ok") assert(!wire.slice(start).some(m => (m.type === "snapshot" || m.type === "snapshot_delta") && m.state.recovery?.branch), "no-summary navigation must not advertise summarization");
	return result;
}
async function prompt(text) {
	const count = state.messages.length;
	send({ type: "prompt", text });
	await wait(() => state.messages.length > count && state.messages.at(-1)?.role === "assistant" && !state.isStreaming);
}
function entries() { return readFileSync(state.sessionFile, "utf8").trim().split("\n").map(JSON.parse); }
try {
	await wait(() => portUp(PORT).then(Boolean)); // Actual readiness is verified by connect below.
	for (let i = 0; i < 100 && !await portUp(PORT); i++) await sleep(100);
	await connect();
	await prompt("root question"); await prompt("original question");
	const originalFile = state.sessionFile;
	const rootAnswer = state.messages.find(m => m.role === "assistant").entryId;
	const original = state.messages.find(m => m.role === "user" && m.content.some(b => b.text === "original question"));
	assert(original.entryId); assert(rootAnswer);
	const oldLeaf = state.tree.leafId;
	send({ type: "edit_message", conversationId: state.conversationId, messageId: original.id, entryId: original.entryId, text: "edited question" });
	await wait(() => state.messages.some(m => m.role === "user" && m.content.some(b => b.text === "edited question")) && !state.isStreaming && state.messages.at(-1)?.role === "assistant");
	assert.equal(state.sessionFile, originalFile);
	const edited = state.messages.find(m => m.role === "user" && m.content.some(b => b.text === "edited question"));
	assert.equal(edited.siblings.count, 2);
	assert(entries().some(e => e.id === oldLeaf));
	const editedLeaf = state.tree.leafId;
	let result = await request("tree_get");
	assert.equal(result.type, "tree"); assert(result.nodes.some(n => n.id === original.entryId)); assert(result.nodes.some(n => n.id === edited.entryId));
	result = await request("tree_label", { entryId: original.entryId, label: "checkpoint" }); assert.equal(result.status, "ok");
	result = await request("tree_get", { filter: "labeled-only", query: "checkpoint" }); assert.deepEqual(result.nodes.map(n => n.id), [original.entryId]);
	result = await request("tree_navigate", { targetId: oldLeaf, summary: "none" }); assert.equal(result.status, "ok");
	await wait(() => state.tree.leafId === oldLeaf);
	assert(state.messages.some(m => m.entryId === original.entryId)); assert(!state.messages.some(m => m.entryId === edited.entryId));
	result = await request("tree_navigate", { targetId: edited.entryId, summary: "none" }); assert.equal(result.editorText, "edited question");
	await wait(() => state.tree.leafId === rootAnswer);
	result = await request("tree_navigate", { targetId: editedLeaf, summary: "none" }); assert.equal(result.status, "ok");
	result = await request("tree_preview", { targetId: oldLeaf }); assert(result.entryCount > 0);
	const prior = state.tree.leafId;
	result = await request("tree_navigate", { targetId: oldLeaf, summary: "custom", customInstructions: "extension-cancel" }); assert.equal(result.status, "cancelled"); assert.equal(state.tree.leafId, prior);
	result = await request("tree_navigate", { targetId: oldLeaf, summary: "custom", customInstructions: "fail-summary" }); assert.equal(result.status, "error"); assert(failSummary); assert.equal(state.tree.leafId, prior);
	const cancelled = request("tree_navigate", { targetId: oldLeaf, summary: "custom", customInstructions: "delay-summary" });
	await wait(() => slowSummary && state.recovery?.branch);
	result = await request("tree_navigate", { targetId: rootAnswer, summary: "none" }); assert.equal(result.status, "busy");
	const busyConversation = state.conversationId;
	send({ type: "new_chat", fresh: true });
	await wait(() => wire.some(m => m.type === "notice" && m.text.includes("等待当前切换")));
	assert.equal(state.conversationId, busyConversation);
	send({ type: "cancel_recovery", conversationId: state.conversationId, operationId: state.recovery.branch.id });
	assert.equal((await cancelled).status, "aborted"); await wait(() => !state.recovery?.branch); assert.equal(state.tree.leafId, prior);
	result = await request("tree_navigate", { targetId: oldLeaf, summary: "default", label: "summary-label" }); assert.equal(result.status, "ok");
	await wait(() => state.tree.leafId !== prior);
	assert(entries().some(e => e.type === "branch_summary"));
	result = await request("tree_get", { filter: "labeled-only" }); assert(result.nodes.some(n => n.label === "summary-label"));
	// Extension confirmation uses the same conversation-scoped dialog transport.
	const dialogSwitch = request("tree_navigate", { targetId: rootAnswer, summary: "custom", customInstructions: "extension-dialog" });
	const dialog = await wait(() => wire.find(m => m.type === "dialog" && m.title === "tree-permission"));
	assert.equal(dialog.conversationId, state.conversationId);
	send({ type: "dialog_response", conversationId: dialog.conversationId, id: dialog.id, value: false });
	assert.equal((await dialogSwitch).status, "cancelled");
	// A live response may be interrupted only with explicit consent; queue is recovered first.
	holdNext = true; send({ type: "prompt", text: "held live response" });
	await wait(() => state.isStreaming);
	// Metadata-only changes must not abort a live response or turn it read-only.
	utimesSync(originalFile, new Date(), new Date(Date.now() + 10000));
	result = await request("tree_label", { entryId: rootAnswer, label: "after-touch" });
	assert.equal(result.status, "ok");
	await sleep(150);
	assert.equal(state.isStreaming, true); assert.equal(state.tree.externallyModified, false);
	result = await request("tree_navigate", { targetId: rootAnswer, summary: "none" }); assert.equal(result.status, "busy");
	result = await request("tree_label", { entryId: rootAnswer, label: "during-stream" }); assert.equal(result.status, "ok");
	send({ type: "prompt", text: "queued followup", queue: true });
	await wait(() => state.queue.followUp.includes("queued followup"));
	result = await request("tree_navigate", { targetId: rootAnswer, summary: "none", abortRunning: true });
	assert.equal(result.status, "ok"); assert.deepEqual(result.restoredQueue.followUp, ["queued followup"]);
	await wait(() => !state.isStreaming && state.queue.followUp.length === 0);
	assert(!state.messages.some(m => m.content.some(b => b.text === "queued followup")));
	// Compaction is not interrupted by tree navigation.
	await prompt("before compact");
	holdNext = true; send({ type: "prompt", text: "/compact" });
	await wait(() => state.recovery?.compaction);
	result = await request("tree_navigate", { targetId: oldLeaf, summary: "none", abortRunning: true }); assert.equal(result.status, "busy");
	send({ type: "cancel_recovery", conversationId: state.conversationId, operationId: state.recovery.compaction.id });
	await wait(() => !state.recovery?.compaction);
	send({ type: "prompt", text: "/compact" });
	await wait(() => entries().some(e => e.type === "compaction") && !state.recovery?.compaction);
	result = await request("tree_navigate", { targetId: rootAnswer, summary: "none" }); assert.equal(result.status, "ok");
	await wait(() => state.tree.leafId === rootAnswer);
	assert(!state.messages.some(m => m.role === "compactionSummary"));
	const id = state.conversationId;
	result = await request("tree_label", { conversationId: "wrong", entryId: rootAnswer, label: "wrong" }); assert.equal(result.status, "error");
	ws.close(); await sleep(100); state = undefined; await connect(); assert.equal(state.conversationId, id); assert(state.tree.branchPoints > 0);
	// SDK writes from a second manager emulate the CLI; watcher must not confuse its own writes.
	holdNext = true; send({ type: "prompt", text: "held before external write" });
	await wait(() => state.isStreaming);
	const cli = SessionManager.open(originalFile); cli.appendLabelChange(rootAnswer, "from-cli");
	await wait(() => state.tree.externallyModified && !state.isStreaming);
	result = await request("tree_label", { entryId: rootAnswer, label: "blocked" }); assert.equal(result.status, "error");
	const externalLength = readFileSync(originalFile).length;
	send({ type: "rename_session", path: originalFile, name: "blocked rename" });
	await wait(() => wire.some(m => m.type === "notice" && m.text.includes("重命名会话失败")));
	assert.equal(readFileSync(originalFile).length, externalLength);
	result = await request("session_reopen"); assert.equal(result.status, "ok"); await wait(() => !state.tree.externallyModified);
	result = await request("tree_get", { filter: "labeled-only", query: "from-cli" }); assert(result.nodes.some(n => n.id === rootAnswer));
	result = await request("session_clone"); assert.equal(result.status, "ok"); await wait(() => state.sessionFile !== originalFile);
	assert.equal(entries()[0].parentSession, originalFile);
	const cloneFile = state.sessionFile;
	send({ type: "prompt", text: "/name tree renamed" }); await wait(() => entries().some(e => e.type === "session_info" && e.name === "tree renamed"));
	const forkEntry = entries().filter(e => e.type === "message" && e.message.role === "user").at(-1).id;
	result = await request("session_fork", { entryId: forkEntry, position: "before" }); assert.equal(result.status, "ok"); await wait(() => state.sessionFile !== cloneFile);
	assert.equal(entries()[0].parentSession, cloneFile);
	send({ type: "prompt", text: "/tree" }); await wait(() => wire.some(m => m.type === "tree_open" && m.mode === "tree"));
	send({ type: "prompt", text: "/fork" }); await wait(() => wire.some(m => m.type === "tree_open" && m.mode === "fork"));
	if (process.argv.includes("--browser")) {
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		const page = await browser.newPage();
		await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "tree-test"));
		await page.goto(`http://127.0.0.1:${PORT}`);
		await page.waitForSelector(".inputbox textarea");
		assert.equal(await page.locator(".conversation-run-settings").count(), 0);
		assert.equal(await page.locator(".sidebar-logo").evaluate(el => getComputedStyle(el).width), "24px");
		assert.equal(await page.locator(".inputbox").evaluate(el => getComputedStyle(el).borderRadius), "8px");
		assert.equal(await page.locator(".view-switch button.active").evaluate(el => getComputedStyle(el).color), "rgb(47, 122, 174)");
		await page.locator(".thinking-control .chip").click();
		const retryToggle = page.locator(".thinking-run-settings").getByRole("checkbox", { name: "自动重试" });
		await retryToggle.click(); await wait(() => state.runSettings.autoRetry);
		await page.waitForFunction(() => document.querySelectorAll(".thinking-run-settings input")[1]?.checked);
		await retryToggle.click(); await wait(() => !state.runSettings.autoRetry);
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "会话树", exact: true }).click();
		await page.waitForSelector(".session-tree-panel .tree-node");
		await page.getByRole("combobox", { name: "过滤节点" }).selectOption("user-only");
		await page.getByRole("textbox", { name: "搜索会话树" }).fill("root question");
		await wait(async () => (await page.locator(".tree-node").count()) === 1);
		await page.locator(".inputbox textarea").fill("keep this draft");
		await page.getByRole("button", { name: "切换到这里", exact: true }).click();
		await page.getByRole("dialog", { name: "切换到这里" }).getByRole("button", { name: "切换到这里", exact: true }).click();
		await page.waitForSelector(".tree-draft-restore");
		assert.equal(await page.locator(".inputbox textarea").inputValue(), "keep this draft");
		await page.getByRole("button", { name: "追加到草稿" }).click();
		assert((await page.locator(".inputbox textarea").inputValue()).includes("root question"));
		// Return to the branched file and exercise the actual message switcher.
		send({ type: "switch_session", path: originalFile });
		await wait(() => state.sessionFile === originalFile);
		await request("tree_navigate", { targetId: editedLeaf, summary: "none" });
		await page.locator(".session-tree-panel header button").click();
		await wait(() => state.tree.leafId === editedLeaf);
		await page.screenshot({ path: "/tmp/pi-tree-siblings.png", fullPage: true });
		assert(state.messages.some(m => m.entryId === edited.entryId && m.siblings), JSON.stringify(state.messages.map(m => ({entryId:m.entryId, siblings:m.siblings}))));
		await page.getByRole("button", { name: "上一个分支", exact: true }).first().click();
		await wait(() => state.messages.some(m => m.entryId === original.entryId));
		await page.keyboard.press("Control+Shift+T");
		await page.waitForSelector(".session-tree-panel");
		await page.getByRole("textbox", { name: "搜索会话树" }).fill("root question");
		await wait(async () => (await page.locator(".tree-node").count()) === 1);
		await page.getByRole("button", { name: "设置书签", exact: true }).click();
		await page.getByRole("dialog", { name: "设置书签" }).getByRole("textbox").fill("browser checkpoint");
		await page.getByRole("dialog", { name: "设置书签" }).getByRole("button", { name: "保存", exact: true }).click();
		await page.getByText("browser checkpoint", { exact: true }).first().waitFor();
		await page.locator(".tree-node-preview").click();
		assert((await page.locator(".tree-content-dialog pre").textContent()).includes("root question"));
		await page.locator(".tree-content-dialog").getByRole("button", { name: "关闭", exact: true }).click();
		await prompt("browser busy edit source");
		const busyEdit = state.messages.find(m => m.role === "user" && m.content.some(b => b.text === "browser busy edit source"));
		holdNext = true; send({ type: "prompt", text: "/compact" }); await wait(() => state.recovery?.compaction);
		await page.locator(".session-tree-panel header button").click();
		send({ type: "edit_message", conversationId: state.conversationId, messageId: busyEdit.id, entryId: busyEdit.entryId, text: "blocked edit" });
		await page.getByText("编辑重问暂不可用，请等待当前回复、压缩或切换完成。", { exact: true }).waitFor();
		send({ type: "cancel_recovery", conversationId: state.conversationId, operationId: state.recovery.compaction.id }); await wait(() => !state.recovery?.compaction);
		await page.screenshot({ path: "/tmp/pi-session-tree-browser.png", fullPage: true });
	}
	// Both the explicit secondary action and the saved preference retain file forks.
	await prompt("editable new-file question");
	let editSource = state.messages.find(m => m.role === "user" && m.content.some(b => b.text === "editable new-file question"));
	let editFile = state.sessionFile;
	send({ type: "edit_message", conversationId: state.conversationId, messageId: editSource.id, entryId: editSource.entryId, text: "explicit fork edit", newSession: true });
	await wait(() => state.sessionFile !== editFile && !state.isStreaming && state.messages.at(-1)?.role === "assistant" && state.messages.some(m => m.content.some(b => b.text === "explicit fork edit")));
	assert.equal(entries()[0].parentSession, editFile);
	assert(state.messages.some(m => m.content.some(b => b.text === "explicit fork edit")));
	send({ type: "set_settings", editResendNewSession: true });
	await wait(() => wire.some(m => m.type === "settings_state" && m.settings.editResendNewSession));
	editSource = state.messages.find(m => m.role === "user" && m.content.some(b => b.text === "explicit fork edit"));
	editFile = state.sessionFile;
	send({ type: "edit_message", conversationId: state.conversationId, messageId: editSource.id, entryId: editSource.entryId, text: "preference fork edit" });
	await wait(() => state.sessionFile !== editFile && !state.isStreaming && state.messages.at(-1)?.role === "assistant" && state.messages.some(m => m.content.some(b => b.text === "preference fork edit")));
	assert.equal(entries()[0].parentSession, editFile);
	assert(state.messages.some(m => m.content.some(b => b.text === "preference fork edit")));
	const commandCloneFile = state.sessionFile;
	send({ type: "prompt", text: "/clone" });
	await wait(() => state.sessionFile !== commandCloneFile);
	assert.equal(entries()[0].parentSession, commandCloneFile);
	const backgroundId = state.conversationId;
	send({ type: "new_chat" }); await wait(() => state.conversationId !== backgroundId);
	result = await request("tree_get", { conversationId: backgroundId }); assert.equal(result.status, "error");
	send({ type: "switch_conversation", id: backgroundId }); await wait(() => state.conversationId === backgroundId);
	console.log("PASS native session tree: in-file edits, siblings, labels, summary success/failure/cancel, extension cancellation, busy guard, reconnect, external changes/reopen, clone/fork and commands" + (browser ? "; browser tree and draft protection" : ""));
} finally {
	await browser?.close(); ws?.close();
	const exited = new Promise(resolve => server.once("exit", resolve)); server.kill("SIGTERM"); await exited;
	mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
