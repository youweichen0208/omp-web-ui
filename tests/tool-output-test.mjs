// Native truncated output survives transcript reload and is downloaded by identity, never a browser path.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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
const token = "fixture-token";
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: agent, PI_WEB_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; server.stderr.on("data", d => logs += d); server.stdout.on("data", () => {});
let ws;
try {
 for (let n = 0; n < 100 && !(await portUp(port)); n++) await sleep(100);
 ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
 const snapshot = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(logs)), 10000); ws.on("message", raw => { const m = JSON.parse(raw); if (m.type === "snapshot") { clearTimeout(timer); resolve(m.state); } }); });
 await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
 ws.send(JSON.stringify({ type: "hello", clientId: "download-test", protocolVersion: 36 }));
 const state = await snapshot;
 const result = state.messages.find(m => m.toolCallId === "large");
 assert.equal(result.details.exitCode, 0); assert.equal(result.details.fullOutputPath, path);
 const url = `http://127.0.0.1:${port}${result.toolOutputUrl}`;
 assert.equal((await fetch(url)).status, 401);
 const headers = { Authorization: `Bearer ${token}` };
 assert.equal(await (await fetch(url, { headers })).text(), "output-line\n".repeat(10000));
 assert.equal((await fetch(url.replace("toolCallId=large", "toolCallId=forged") + `&path=${encodeURIComponent(path)}`, { headers })).status, 404);
 assert.equal((await fetch(url.replace("conversationId=" + state.conversationId, "conversationId=forged"), { headers })).status, 404);
 rmSync(path); assert.equal((await fetch(url, { headers })).status, 404);
 writeFileSync(join(root, "secret"), "secret"); symlinkSync(join(root, "secret"), path);
 assert.equal((await fetch(url, { headers })).status, 404);
 console.log("PASS authenticated native full output download, restored transcript, identity checks, cleanup and symlink rejection");
} catch (error) { console.error(error); process.exitCode = 1; }
finally { ws?.close(); const exit = new Promise(resolve => server.once("exit", resolve)); server.kill(); await exit; rmSync(path, { force: true }); rmSync(root, { recursive: true, force: true }); }
