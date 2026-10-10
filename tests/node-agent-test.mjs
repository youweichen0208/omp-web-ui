// Local native Pi + real SSH transport; the SSH fixture has no Pi or model credentials.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ssh2 from "ssh2";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
const port = 9232, modelPort = 9233;
for (const portNumber of [port, modelPort]) assert.equal(await portUp(portNumber), false);
const root = mkdtempSync(join(tmpdir(), "pi-node-agent-")), agentDir = join(root, "local-agent"), remoteDir = join(root, "ssh-node");
mkdirSync(agentDir); mkdirSync(remoteDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
const { NodeWorkbench } = await import("../dist/server/node-workbench.js");
const { nodeCommand, runNodeCommand } = await import("../dist/server/node-command.js");
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { api: "openai-completions", baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: "local-only-secret", models: [{ id: "test", name: "Local fixture", input: ["text"], contextWindow: 32000, maxTokens: 4096 }, { id: "other", name: "Other fixture", input: ["text"], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "test", defaultTools: ["bash", "read", "codemode", "tool_search"] }));
mkdirSync(join(agentDir, "extensions"));
writeFileSync(join(agentDir, "extensions", "must-not-load.ts"), 'throw new Error("local extensions must not load in node sessions");');
writeFileSync(join(agentDir, "AGENTS.md"), "LOCAL_CONTEXT_MUST_NOT_LEAK");
writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "LOCAL_APPEND_MUST_NOT_LEAK");
let requests = 0, blockedStat = false;
const model = createServer(async (req, res) => {
	let body = ""; for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body); requests++;
	assert.equal(req.headers.authorization, "Bearer local-only-secret");
	assert.deepEqual(payload.tools.map(tool => tool.function.name).sort(), ["remote_command", "remote_read", "remote_write"]);
	assert(!JSON.stringify(payload.messages).includes("LOCAL_CONTEXT_MUST_NOT_LEAK"));
	assert(!JSON.stringify(payload.messages).includes("LOCAL_APPEND_MUST_NOT_LEAK"));
	res.writeHead(200, { "content-type": "text/event-stream" });
	const send = (delta, reason = null) => res.write(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", model: payload.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
	const last = payload.messages.at(-1), text = JSON.stringify(last.content);
	let tool;
	if (last.role === "user" && text.includes("remote diagnostics")) tool = { name: "remote_command", arguments: { command: "create-proof" } };
	if (last.role === "user" && text.includes("remote write")) tool = { name: "remote_write", arguments: { path: "/srv/ops/proof.txt", text: "written on SSH node" } };
	if (last.role === "user" && text.includes("remote read")) tool = { name: "remote_read", arguments: { path: "/srv/ops/proof.txt" } };
	if (last.role === "user" && text.includes("blocked read")) tool = { name: "remote_read", arguments: { path: "/srv/ops/blocked" } };
	if (last.role === "user" && text.includes("long command")) tool = { name: "remote_command", arguments: { command: "wait-until-aborted" } };
	if (tool) {
		send({ tool_calls: [{ index: 0, id: `ssh-tool-${requests}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] });
		send({}, "tool_calls"); res.end("data: [DONE]\n\n"); return;
	}
	send({ content: "节点 " });
	await new Promise(resolve => setTimeout(resolve, text.includes("slow request") ? 1500 : 100));
	send({ content: "agent reply" }); send({}, "stop"); res.end("data: [DONE]\n\n");
});
await new Promise(resolve => model.listen(modelPort, "127.0.0.1", resolve));
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const clients = new Set(), commands = [], stopped = [], children = new Set();
const remoteFiles = new Map();
const ssh = new ssh2.Server({ hostKeys: [key] }, client => {
	clients.add(client); client.on("error", () => {}); client.on("close", () => clients.delete(client));
	client.on("authentication", context => context.method === "password" && context.username === "tester" && context.password === "ssh-only-secret" ? context.accept() : context.reject());
	client.on("ready", () => client.on("session", accept => {
		const session = accept(); let execStream, child;
		session.on("pty", acceptPty => acceptPty());
		session.on("shell", acceptShell => { const stream = acceptShell(); stream.write("SSH fixture (no pi installed)\r\n"); stream.on("data", data => stream.write(data)); });
		session.on("signal", (acceptSignal, _reject, info) => { stopped.push(info.name); child?.kill(); execStream?.exit(143); execStream?.end(); acceptSignal?.(); });
		session.on("exec", (acceptExec, _reject, info) => {
			commands.push(info.command); const stream = acceptExec(); execStream = stream;
			if (info.command === nodeCommand("/srv/ops", "wait-until-aborted")) return;
			if (info.command === nodeCommand("/srv/ops", "large-output")) { stream.write("x".repeat(90000)); stream.exit(0); stream.end(); return; }
			if (info.command === nodeCommand("/srv/ops", "create-proof")) {
				// Execute only the fixture program on the server side, portable to Windows runners.
				child = spawn(process.execPath, ["-e", 'require("fs").writeFileSync("remote-command-proof.txt", "SSH process executed"); console.log("SSH process executed")'], { cwd: remoteDir, stdio: ["ignore", "pipe", "pipe"] });
				children.add(child); child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream.stderr, { end: false });
				child.on("exit", code => { children.delete(child); stream.exit(code ?? 1); stream.end(); });
				stream.on("close", () => child?.kill()); return;
			}
			stream.stderr.write("command unavailable; no pi installed"); stream.exit(127); stream.end();
		});
		session.on("sftp", acceptSftp => {
			const sftp = acceptSftp(), handles = new Map(); let seq = 0;
			sftp.on("STAT", (id, path) => { if (path === "/srv/ops/blocked") { blockedStat = true; return; } remoteFiles.has(path) ? sftp.attrs(id, { mode: 0o100644, size: remoteFiles.get(path).length }) : sftp.status(id, 2); });
			sftp.on("OPEN", (id, path, flags) => { if (flags & 2) remoteFiles.set(path, Buffer.alloc(0)); if (!remoteFiles.has(path)) return sftp.status(id, 2); const handle = Buffer.from(String(++seq)); handles.set(handle.toString(), path); sftp.handle(id, handle); });
			sftp.on("WRITE", (id, handle, offset, data) => { const path = handles.get(handle.toString()), old = remoteFiles.get(path), buf = Buffer.alloc(Math.max(old.length, offset + data.length)); old.copy(buf); data.copy(buf, offset); remoteFiles.set(path, buf); sftp.status(id, 0); });
			sftp.on("READ", (id, handle, offset, size) => { const buf = remoteFiles.get(handles.get(handle.toString())).subarray(offset, offset + size); if (buf.length) sftp.data(id, buf); else sftp.status(id, 1); });
			sftp.on("CLOSE", (id, handle) => { handles.delete(handle.toString()); sftp.status(id, 0); });
		});
	}));
});
await new Promise(resolve => ssh.listen(port, "127.0.0.1", resolve));
let web, browser;
const service = new NodeWorkbench(join(root, "data")), wire = [];
service.attach("a", message => wire.push(message));
const call = async (action, nodeId, payload = {}, conversationId, client = "a") => {
	const id = crypto.randomUUID();
	await service.handle(client, { type: "node_request", action, nodeId, payload, conversationId, requestId: id });
	return wire.findLast(message => message.requestId === id && ["result", "failure"].includes(message.event));
};
const waitFor = async predicate => { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error("Timed out waiting for local node agent event"); };
try {
	const created = await call("save", undefined, { name: "Remote", host: "127.0.0.1", port, username: "tester", auth: "password", secret: "ssh-only-secret", defaultDir: "/srv/ops" });
	const nodeId = created.data.id;
	await call("connect", nodeId);
	const fingerprint = wire.findLast(m => m.event === "trust_required").data.fingerprint;
	assert.equal((await call("trust", nodeId, { fingerprint })).event, "result");
	const connection = service.connections.values().next().value, agent = connection.agent;
	assert.equal(agent?.snapshot().phase, "ready", "SSH connection must make local Agent Chat ready without agent_start or remote Pi");
	assert.equal(agent.snapshot().model.provider, "local");
	assert.equal(requests, 0); assert.equal(commands.length, 0);
	// Native prompt preflight must reject without clearing a draft, and stopping
	// while auth is pending must not start a model request later.
	const runtime = agent.session.modelRuntime;
	const hasAuth = runtime.hasConfiguredAuth.bind(runtime), checkAuth = runtime.checkAuth.bind(runtime);
	runtime.hasConfiguredAuth = () => false;
	runtime.checkAuth = async () => undefined;
	assert.equal((await call("agent_prompt", nodeId, { text: "no credentials" }, agent.id)).event, "failure");
	let releaseAuth, authStarted = false;
	runtime.checkAuth = () => { authStarted = true; return new Promise(resolve => { releaseAuth = resolve; }); };
	const pendingAuth = call("agent_prompt", nodeId, { text: "cancel before model" }, agent.id);
	await waitFor(() => authStarted);
	assert.equal((await call("agent_abort", nodeId, {}, agent.id)).event, "result");
	releaseAuth({}); assert.equal((await pendingAuth).event, "failure"); assert.equal(requests, 0);
	runtime.hasConfiguredAuth = hasAuth; runtime.checkAuth = checkAuth;
	const agentId = agent.id;
	assert.equal((await call("agent_prompt", nodeId, { text: "wrong instance" }, "stale")).event, "failure");
	service.attach("b", message => wire.push(message));
	assert.equal((await call("agent_prompt", nodeId, { text: "wrong client" }, agentId, "b")).event, "failure");
	assert.equal((await call("agent_prompt", nodeId, { text: "hello node" }, agentId)).event, "result");
	await waitFor(() => wire.some(m => m.event === "agent_state" && m.data.agent.streamingMessage?.content.some(b => b.text?.includes("节点"))));
	await waitFor(() => !agent.snapshot().running);
	assert(agent.snapshot().messages.some(m => m.role === "assistant"));
	for (const text of ["remote diagnostics", "remote write", "remote read"]) {
		assert.equal((await call("agent_prompt", nodeId, { text }, agentId)).event, "result"); await waitFor(() => !agent.snapshot().running);
	}
	assert.equal(readFileSync(join(remoteDir, "remote-command-proof.txt"), "utf8"), "SSH process executed");
	assert.equal(remoteFiles.get("/srv/ops/proof.txt").toString(), "written on SSH node");
	assert(agent.snapshot().messages.some(m => m.role === "toolResult" && m.toolName === "remote_read" && JSON.stringify(m.content).includes("written on SSH node")));
	assert(!existsSync(resolve("remote-command-proof.txt")));
	assert(!JSON.stringify(wire).includes("local-only-secret"));
	assert(!JSON.stringify(commands).includes("local-only-secret"));
	assert(commands.every(command => !command.includes("pi --mode rpc")));
	assert.equal((await call("agent_model", nodeId, { provider: "local", modelId: "other" }, agentId)).event, "result");
	assert.equal(agent.snapshot().model.id, "other");
	assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"))).defaultModel, "test");
	const second = await call("save", undefined, { name: "Second", host: "127.0.0.1", port, username: "tester", auth: "password", secret: "ssh-only-secret", defaultDir: "/srv/ops" });
	const secondId = second.data.id;
	assert.equal((await call("trust", secondId, { fingerprint })).event, "result");
	assert.equal((await call("agent_prompt", secondId, { text: "wrong node" }, agentId)).event, "failure");
	const secondAgent = [...service.connections.values()].find(c => c.nodeId === secondId).agent;
	assert.equal(secondAgent.snapshot().messages.length, 0);
	await call("disconnect", secondId);
	const restored = []; const detach = service.attach("a", m => restored.push(m));
	assert.equal(restored[0].data.connections[0].agent.id, agentId); detach();
	assert.equal((await call("agent_new", nodeId, {}, agentId)).event, "result");
	assert.equal(agent.snapshot().messages.length, 0);
	assert.equal(agent.snapshot().model.id, "other");
	assert.equal((await call("agent_prompt", nodeId, { text: "slow request" }, agentId)).event, "result");
	await waitFor(() => agent.session.isStreaming);
	assert.equal(service.activeAgents(), 1);
	assert.equal((await call("agent_prompt", nodeId, { text: "queued request", queue: "followUp" }, agentId)).event, "result");
	await waitFor(() => !agent.snapshot().running);
	assert(agent.snapshot().messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("queued request")));
	assert.equal((await call("agent_prompt", nodeId, { text: "long command" }, agentId)).event, "result");
	await waitFor(() => commands.some(c => c === nodeCommand("/srv/ops", "wait-until-aborted")));
	assert.equal((await call("agent_abort", nodeId, {}, agentId)).event, "result");
	await waitFor(() => !agent.snapshot().running);
	await waitFor(() => stopped.includes("TERM"));
	assert.equal((await call("agent_prompt", nodeId, { text: "blocked read" }, agentId)).event, "result");
	await waitFor(() => blockedStat);
	assert.equal((await call("agent_abort", nodeId, {}, agentId)).event, "result");
	await waitFor(() => !agent.snapshot().running);
	await assert.rejects(runNodeCommand(connection.client, "/srv/ops", "wait-until-aborted", 1), /timed out/);
	await assert.rejects(runNodeCommand(connection.client, "/srv/ops", "not-a-command", 2), /exit: 127/);
	const large = await runNodeCommand(connection.client, "/srv/ops", "large-output", 2); assert(large.includes("输出已截断")); assert(large.length < 66000);
	const count = agent.snapshot().messages.length;
	await call("disconnect", nodeId);
	assert.equal((await call("agent_prompt", nodeId, { text: "after disconnect" }, agentId)).event, "failure");
	assert.equal((await call("connect", nodeId)).event, "result");
	const reconnected = service.connections.values().next().value.agent;
	assert.notEqual(reconnected.id, agentId); assert.equal(reconnected.snapshot().messages.length, count);
	await call("disconnect", nodeId);
	assert.throws(() => nodeCommand("/safe\nwhoami", "pwd"));
	console.log("PASS local node agent: automatic readiness, model/tool isolation, SSH commands/SFTP, streaming, queue, abort, timeout, reconnect/history");
	if (process.argv.includes("--browser")) {
		assert.equal(await portUp(9234), false);
		web = spawn(process.execPath, [resolve("dist/server/index.js")], { env: { ...process.env, PORT: "9234", PI_WEB_TOKEN: "", PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, "data") }, stdio: "ignore" });
		for (let i = 0; i < 100 && !await portUp(9234); i++) await new Promise(resolve => setTimeout(resolve, 100));
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
		const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
		const errors = []; page.on("pageerror", error => errors.push(error.message)); page.on("dialog", dialog => dialog.accept());
		await page.goto("http://127.0.0.1:9234");
		await page.locator(".setup-modal .modal-close").click();
		await page.getByRole("tab", { name: "节点", exact: true }).click();
		await page.locator(".node-item", { hasText: "Remote" }).locator("button").first().click();
		const before = requests;
		await page.getByRole("button", { name: "打开工作台", exact: true }).click();
		await page.locator(".node-main-head em", { hasText: "已连接" }).waitFor();
		const input = page.getByRole("textbox", { name: "让 Agent 在此节点执行任务…", exact: true });
		await input.waitFor();
		await page.locator(".node-agent-input select option", { hasText: "Local fixture" }).waitFor({ state: "attached" });
		assert.equal(requests, before, "connecting must not make a model request");
		assert.equal(await page.getByText("npm install -g @earendil-works/pi-coding-agent@1.0.4", { exact: true }).count(), 0);
		await input.fill("remote diagnostics"); await input.press("Enter");
		await page.locator(".node-agent-message.assistant", { hasText: "agent reply" }).waitFor();
		assert.equal(await input.inputValue(), "");
		await input.fill("draft for this node");
		await page.locator(".node-xterm:visible").waitFor();
		const terminalBox = await page.locator(".node-manual-workbench").boundingBox(), agentBox = await page.locator(".node-agent-container").boundingBox();
		assert(terminalBox.x + terminalBox.width <= agentBox.x + 1);
		mkdirSync("tests/scratch", { recursive: true });
		await page.locator(".node-connected").screenshot({ path: "tests/scratch/node-agent-workbench.png" });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.locator(".node-connected").screenshot({ path: "tests/scratch/node-agent-mobile.png" });
		assert(await input.isVisible()); assert.equal(await input.inputValue(), "draft for this node"); assert.deepEqual(errors, []);
		console.log("PASS node browser: connect-to-chat without remote install/start, model/send, simultaneous panes, narrow layout");
	}
} finally {
	await browser?.close(); if (web) { web.kill("SIGTERM"); if (web.exitCode === null) await new Promise(resolve => web.once("exit", resolve)); }
	service.dispose(); for (const child of children) child.kill(); for (const client of clients) client.end();
	await new Promise(resolve => ssh.close(resolve)); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
