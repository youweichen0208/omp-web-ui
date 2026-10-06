// Native truncated output survives transcript reload and is downloaded by identity, never a browser path.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, truncateSync, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { SessionManager, createBashTool } from "@earendil-works/pi-coding-agent";
import WebSocket from "ws";
import { portUp } from "./lib/port-utils.mjs";
const port = Number(process.env.PI_TEST_PORT || 9143);
assert(port >= 8900); assert.equal(await portUp(port), false);
const root = mkdtempSync(join(tmpdir(), "pi-output-http-"));
const cwd = join(root, "work"), agent = join(root, "agent"); mkdirSync(cwd); mkdirSync(agent);
const output = await createBashTool(cwd).execute("large", { command: `"${process.execPath}" -e 'process.stdout.write("output-line\\n".repeat(10000))'` });
const path = output.details.fullOutputPath;
process.env.PI_CODING_AGENT_DIR = agent;
const manager = SessionManager.create(cwd);
manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "large", name: "bash", arguments: { command: "fixture" } }], api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
manager.appendMessage({ role: "toolResult", toolCallId: "large", toolName: "bash", isError: false, timestamp: 3, ...output });
const spillPaths = [join(tmpdir(), `pi-mcp-${randomBytes(8).toString("hex")}.txt`), join(tmpdir(), `pi-codemode-${randomBytes(8).toString("hex")}.txt`)];
for (const [i, toolName] of ["mcp__fixture__large", "codemode"].entries()) {
 writeFileSync(spillPaths[i], "full " + toolName);
 manager.appendMessage({ role: "toolResult", toolCallId: toolName, toolName, isError: false, timestamp: 4 + i, content: [{ type: "text", text: "truncated" }], details: { fullOutputPath: spillPaths[i] } });
}
const binaries = ["bin", "png", "jpg", "gif", "webp"].map((ext, i) => join(tmpdir(), `pi-${i ? "codemode" : "mcp"}-${randomBytes(8).toString("hex")}.${ext}`));
for (const path of binaries) writeFileSync(path, Buffer.from([0, 255, 128, 10]));
spillPaths.push(...binaries);
const binaryText = `[Binary resource fixture://data.bin (application/octet-stream, 4 B) saved to ${binaries[0]}]\n` + binaries.slice(1).map((path, i) => `[Image saved to ${path} (image/${["png", "jpeg", "gif", "webp"][i]}, 4 B)]`).join("\n");
const binaryFull = join(tmpdir(), `pi-codemode-${randomBytes(8).toString("hex")}.txt`);
writeFileSync(binaryFull, binaryText); spillPaths.push(binaryFull);
manager.appendMessage({ role: "toolResult", toolCallId: "multi", toolName: "codemode", isError: false, timestamp: 5, content: [{ type: "text", text: "truncated" }], details: { fullOutputPath: binaryFull } });
const hugeLog = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
writeFileSync(hugeLog, binaryText); truncateSync(hugeLog, 600 * 1024 * 1024); spillPaths.push(hugeLog);
for (const toolName of ["bash", "powershell"]) manager.appendMessage({ role: "toolResult", toolCallId: "huge-" + toolName, toolName, isError: false, timestamp: 5, content: [{ type: "text", text: binaryText }], structuredContent: { full_output_path: hugeLog } });
const kept = manager.appendMessage({ role: "user", content: "after compaction", timestamp: 6 });
manager.appendCompaction("summary", kept, 9000);
const token = "fixture-token";
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: agent, PI_WEB_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; server.stderr.on("data", d => logs += d); server.stdout.on("data", () => {});
let ws;
try {
 for (let n = 0; n < 100 && !(await portUp(port)); n++) await sleep(100);
 ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
 const snapshot = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(logs)), 10000); ws.on("message", raw => { const m = JSON.parse(raw); if (m.type === "snapshot") { clearTimeout(timer); resolve(m.state); } }); });
 await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
 ws.send(JSON.stringify({ type: "hello", clientId: "download-test", protocolVersion: 39 }));
 const state = await snapshot;
 assert(!state.messages.some(m => m.toolCallId === "large"));
 const url = `http://127.0.0.1:${port}/api/tool-output?${new URLSearchParams({ clientId: "download-test", conversationId: state.conversationId, toolCallId: "large" })}`;
 assert.equal((await fetch(url)).status, 401);
 const headers = { Authorization: `Bearer ${token}` };
 assert.equal(await (await fetch(url, { headers })).text(), "output-line\n".repeat(10000));
 for (const tool of ["mcp__fixture__large", "codemode"]) assert.equal(await (await fetch(url.replace("toolCallId=large", "toolCallId=" + tool), { headers })).text(), "full " + tool);
 const multiUrl = url.replace("toolCallId=large", "toolCallId=multi");
 const list = await (await fetch(multiUrl.replace("/api/tool-output?", "/api/tool-output-list?"), { headers })).json();
 assert.equal(list.length, 6); assert(list.every(item => !item.path));
 for (const item of list.slice(1)) {
  const response = await fetch(multiUrl + "&outputId=" + item.id, { headers });
  assert.equal(response.status, 200); assert(response.headers.get("content-disposition").includes(item.name));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 255, 128, 10]));
 }
 assert.equal((await fetch(multiUrl + "&outputId=forged", { headers })).status, 403);
 // The sparse 600 MiB log exceeds V8's string limit: manifest lookup must not decode it.
 const expected = createHash("sha256");
 for await (const chunk of createReadStream(hugeLog)) expected.update(chunk);
 const expectedHash = expected.digest("hex");
 for (const tool of ["bash", "powershell"]) {
  const hugeUrl = url.replace("toolCallId=large", "toolCallId=huge-" + tool);
  const response = await fetch(hugeUrl.replace("/api/tool-output?", "/api/tool-output-list?"), { headers });
  assert.equal(response.status, 200);
  const files = await response.json(); assert.equal(files.length, 1); assert(files[0].default);
  for (const suffix of ["", "&outputId=" + files[0].id]) {
   const download = await fetch(hugeUrl + suffix, { headers }); assert.equal(download.status, 200);
   const hash = createHash("sha256"); let bytes = 0;
   for await (const chunk of download.body) { bytes += chunk.length; hash.update(chunk); }
   assert.equal(bytes, 600 * 1024 * 1024); assert.equal(hash.digest("hex"), expectedHash);
  }
 }
 if (process.argv.includes("--browser")) {
  const { chromium } = await import("playwright-core");
  const { CHROME_PATH } = await import("./lib/chrome.mjs");
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  try {
   const page = await browser.newPage();
   await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "download-test"));
   await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
   await page.locator(".setup-modal .modal-close").click();
   await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByRole("button", { name: "会话树", exact: true }).click();
   await page.getByRole("combobox", { name: "过滤节点" }).selectOption("all");
   for (const toolCallId of ["large", "mcp__fixture__large", "codemode"]) {
    const entry = manager.getEntries().find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === toolCallId);
    await page.locator(`[data-entry-id="${entry.id}"] .tree-node-preview`).click();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载完整输出", exact: true }).click();
    assert.equal(readFileSync(await (await downloaded).path(), "utf8"), toolCallId === "large" ? "output-line\n".repeat(10000) : "full " + toolCallId);
    await page.locator(".tree-content-dialog").getByRole("button", { name: "关闭", exact: true }).click();
   }
   const multiEntry = manager.getEntries().find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "multi");
   await page.locator(`[data-entry-id="${multiEntry.id}"] .tree-node-preview`).click();
   await page.getByRole("button", { name: "下载完整输出", exact: true }).click();
   await page.locator(".tool-output-files").waitFor();
   const downloaded = page.waitForEvent("download");
   await page.getByRole("button", { name: list[1].name, exact: true }).click();
   const binary = await downloaded;
   assert.equal(binary.suggestedFilename(), list[1].name);
   assert.deepEqual(readFileSync(await binary.path()), Buffer.from([0,255,128,10]));
  } finally { await browser.close(); }
 }
 assert.equal((await fetch(url.replace("toolCallId=large", "toolCallId=forged") + `&path=${encodeURIComponent(path)}`, { headers })).status, 403);
 assert.equal((await fetch(url.replace("conversationId=" + state.conversationId, "conversationId=forged"), { headers })).status, 403);
 rmSync(path); assert.equal((await fetch(url, { headers })).status, 404);
 writeFileSync(join(root, "secret"), "secret"); symlinkSync(join(root, "secret"), path);
 assert.equal((await fetch(url, { headers })).status, 403);
 console.log("PASS authenticated native full output download, restored transcript, identity checks, cleanup and symlink rejection");
} catch (error) { console.error(error); process.exitCode = 1; }
finally { ws?.close(); const exit = new Promise(resolve => server.once("exit", resolve)); server.kill(); await exit; rmSync(path, { force: true }); for (const spill of spillPaths) rmSync(spill, { force: true }); rmSync(root, { recursive: true, force: true }); }
