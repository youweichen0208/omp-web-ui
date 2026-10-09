// Native Pi 1.0.4 RPC through a real SSH channel and an isolated, local model fixture.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ssh2 from "ssh2";
const { Server } = ssh2;
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { NodeWorkbench } from "../dist/server/node-workbench.js";
import { nodeAgentCommand } from "../dist/server/node-agent.js";
import { portUp } from "./lib/port-utils.mjs";
const port = 9232, modelPort = 9233;
for (const portNumber of [port, modelPort]) assert.equal(await portUp(portNumber), false);
const root = mkdtempSync(join(tmpdir(), "pi-node-agent-")), agentDir = join(root, "remote-agent");
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(join(agentDir, "extensions", "ask.ts"), 'export default function(pi) { pi.registerCommand("ask", { description: "remote confirmation", handler: async (_args, ctx) => { const yes = await ctx.ui.confirm("Remote permission", "Proceed on this node?"); ctx.ui.notify(yes ? "accepted remotely" : "cancelled remotely", "info"); } }); }');
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { remote: { api: "openai-completions", baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: "remote-only-secret", models: [{ id: "test", name: "Remote fixture", input: ["text"], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "remote", defaultModel: "test" }));
let requests = 0;
const model = createServer(async (req, res) => {
	let body = ""; for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body); requests++;
	assert.equal(req.headers.authorization, "Bearer remote-only-secret");
	res.writeHead(200, { "content-type": "text/event-stream" });
	const send = (delta, reason = null) => res.write(`data: ${JSON.stringify({ id: "remote", object: "chat.completion.chunk", model: payload.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
	const last = payload.messages.at(-1);
	if (last.role === "user" && JSON.stringify(last.content).includes("remote diagnostics")) {
		send({ tool_calls: [{ index: 0, id: "remote-bash", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "pwd; printf 'remote diagnostics executed' > remote-bash-proof.txt" }) } }] });
		send({}, "tool_calls"); res.end("data: [DONE]\n\n"); return;
	}
	if (last.role === "user" && JSON.stringify(last.content).includes("remote write")) {
		send({ tool_calls: [{ index: 0, id: "remote-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "remote-proof.txt", content: "written on remote node" }) } }] });
		send({}, "tool_calls"); res.end("data: [DONE]\n\n"); return;
	}
	send({ content: "远端 " });
	await new Promise(resolve => setTimeout(resolve, JSON.stringify(payload.messages.at(-1)).includes("slow request") ? 2000 : 200));
	send({ content: "agent reply" }); send({}, "stop"); res.end("data: [DONE]\n\n");
});
await new Promise(resolve => model.listen(modelPort, "127.0.0.1", resolve));
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const children = new Set(), clients = new Set(), commands = [];
const ssh = new Server({ hostKeys: [key] }, client => {
	clients.add(client); client.on("error", () => {}); client.on("close", () => clients.delete(client));
	client.on("authentication", context => context.method === "password" && context.username === "tester" && context.password === "ssh-only-secret" ? context.accept() : context.reject());
	client.on("ready", () => client.on("session", accept => {
		const session = accept(); let child;
		session.on("pty", acceptPty => acceptPty());
		session.on("shell", acceptShell => { const stream = acceptShell(); stream.write("remote shell\r\n"); stream.on("data", data => stream.write(data)); });
		session.on("signal", (acceptSignal, _reject, info) => { child?.kill(`SIG${info.name}`); acceptSignal?.(); });
		session.on("exec", (acceptExec, _reject, info) => {
			commands.push(info.command); const stream = acceptExec();
			child = spawn(process.execPath, [resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--mode", "rpc"], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["pipe", "pipe", "pipe"] });
			children.add(child); child.stdout.pipe(stream); child.stderr.pipe(stream.stderr); stream.pipe(child.stdin);
			stream.on("close", () => child.kill("SIGTERM")); child.stdin.on("error", () => {});
			child.on("exit", code => { children.delete(child); try { stream.exit(code ?? 0); stream.end(); } catch {} });
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
const waitFor = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error("Timed out waiting for native remote event"); };
try {
	const created = await call("save", undefined, { name: "Remote", host: "127.0.0.1", port, username: "tester", auth: "password", secret: "ssh-only-secret", defaultDir: root });
	const nodeId = created.data.id;
	await call("connect", nodeId);
	const fingerprint = wire.findLast(m => m.event === "trust_required").data.fingerprint;
	assert.equal((await call("trust", nodeId, { fingerprint })).event, "result");
	const started = await call("agent_start", nodeId, { cwd: root });
	assert.equal(started.event, "result", JSON.stringify(started));
	const agentId = started.data.agent.id;
	assert.equal(started.data.agent.model.id, "test");
	assert.equal(commands[0], nodeAgentCommand(root));
	assert.equal((await call("agent_prompt", nodeId, { text: "wrong instance" }, "stale")).event, "failure");
	service.attach("b", message => wire.push(message));
	assert.equal((await call("agent_prompt", nodeId, { text: "wrong client" }, agentId, "b")).event, "failure");
	assert.equal((await call("agent_prompt", nodeId, { text: "hello remote" }, agentId)).event, "result");
	await waitFor(() => wire.some(m => m.event === "agent_state" && m.data.agent.streamingMessage?.content.some(b => b.text?.includes("远端"))));
	await waitFor(() => wire.some(m => m.event === "agent_state" && !m.data.agent.running && m.data.agent.messages.some(x => x.role === "assistant" && x.content.some(b => b.text?.includes("agent reply")))));
	assert.equal(requests, 1);
	assert(!JSON.stringify(wire).includes("remote-only-secret"));
	assert.equal((await call("agent_prompt", nodeId, { text: "remote write" }, agentId)).event, "result");
	await waitFor(() => service.connections.values().next().value.agent.snapshot().messages.some(message => message.role === "toolResult" && message.toolName === "write"));
	await waitFor(() => !service.connections.values().next().value.agent.snapshot().running);
	assert.equal(readFileSync(join(root, "remote-proof.txt"), "utf8"), "written on remote node");
	const second = await call("save", undefined, { name: "Second", host: "127.0.0.1", port, username: "tester", auth: "password", secret: "ssh-only-secret", defaultDir: root });
	const secondId = second.data.id;
	await call("connect", secondId);
	assert.equal((await call("trust", secondId, { fingerprint })).event, "result");
	const secondAgent = await call("agent_start", secondId, { cwd: root });
	assert.equal(secondAgent.event, "result");
	assert.notEqual(secondAgent.data.agent.id, agentId);
	assert.equal((await call("agent_prompt", secondId, { text: "wrong node" }, agentId)).event, "failure");
	assert.equal(secondAgent.data.agent.messages.length, 0);
	await call("disconnect", secondId);
	const prompting = call("agent_prompt", nodeId, { text: "/ask" }, agentId);
	await waitFor(() => wire.some(m => m.event === "agent_state" && m.data.agent.dialogs.length));
	const dialog = wire.findLast(m => m.event === "agent_state" && m.data.agent.dialogs.length).data.agent.dialogs[0];
	assert.equal((await call("agent_dialog", nodeId, { id: dialog.id, confirmed: true }, agentId)).event, "result");
	assert.equal((await prompting).event, "result");
	await waitFor(() => wire.some(m => m.data?.agent?.notice === "accepted remotely"));
	assert.equal((await call("agent_new", nodeId, {}, agentId)).event, "result");
	assert.equal(service.connections.values().next().value.agent.snapshot().messages.length, 0);
	assert.equal((await call("agent_prompt", nodeId, { text: "slow request" }, agentId)).event, "result");
	await waitFor(() => service.connections.values().next().value.agent.snapshot().running);
	assert.equal(service.activeAgents(), 1);
	assert.equal((await call("agent_abort", nodeId, {}, agentId)).event, "result");
	await waitFor(() => !service.connections.values().next().value.agent.snapshot().running);
	await call("disconnect", nodeId);
	await waitFor(() => children.size === 0);
	assert.equal((await call("agent_prompt", nodeId, { text: "after disconnect" }, agentId)).event, "failure");
	assert.throws(() => nodeAgentCommand("/safe\nwhoami"));
	assert(nodeAgentCommand("/path with ' quote; echo nope").includes("exec pi --mode rpc"));
	if (process.argv.includes("--browser")) {
		assert.equal(await portUp(9234), false);
		web = spawn(process.execPath, [resolve("dist/server/index.js")], { env: { ...process.env, PORT: "9234", PI_WEB_TOKEN: "", PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "local-agent") }, stdio: "ignore" });
		for (let i = 0; i < 100 && !await portUp(9234); i++) await new Promise(resolve => setTimeout(resolve, 100));
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
		const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
		const errors = []; page.on("pageerror", error => errors.push(error.message));
		page.on("dialog", dialog => dialog.accept());
		await page.goto("http://127.0.0.1:9234");
		await page.locator(".setup-modal .modal-close").click();
		await page.getByRole("tab", { name: "节点", exact: true }).click();
		await page.locator(".node-item", { hasText: "Remote" }).locator("button").first().click();
		await page.getByRole("button", { name: "打开工作台", exact: true }).click();
		await page.locator(".node-main-head em", { hasText: "已连接" }).waitFor();
		assert.equal(requests, 4, "connecting must not start model work");
		await page.getByRole("button", { name: "启动远端 Agent", exact: true }).click();
		const input = page.getByRole("textbox", { name: "让 Agent 在此节点执行任务…", exact: true });
		await input.fill("remote diagnostics"); await input.press("Enter");
		await page.locator(".node-agent-message.assistant", { hasText: "agent reply" }).waitFor();
		assert.equal(await input.inputValue(), "");
		assert.equal(readFileSync(join(root, "remote-bash-proof.txt"), "utf8"), "remote diagnostics executed");
		assert(!existsSync(resolve("remote-bash-proof.txt")), "remote bash must not execute in the local project");
		await input.fill("/ask"); await input.press("Enter");
		await page.locator(".node-agent-dialog", { hasText: "Remote permission" }).waitFor();
		await page.locator(".node-agent-dialog").getByRole("button", { name: "确认", exact: true }).click();
		await page.locator(".node-agent").getByText("accepted remotely", { exact: true }).waitFor();
		await input.fill("draft for this node");
		assert(await input.isVisible(), "Agent remains visible alongside manual terminal");
		await page.locator(".node-xterm:visible").waitFor();
		const terminalBox = await page.locator('.node-manual-workbench').boundingBox();
		const agentBox = await page.locator('.node-agent-container').boundingBox();
		assert(terminalBox.x + terminalBox.width <= agentBox.x + 1, 'SSH terminal is on the left, Agent on the right');
		await page.locator(".node-agent-message.assistant", { hasText: "agent reply" }).waitFor();
		assert.equal(await input.inputValue(), "draft for this node");
		mkdirSync("tests/scratch", { recursive: true });
		await page.locator(".node-connected").screenshot({ path: "tests/scratch/node-agent-workbench.png" });
		await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
		await page.locator(".node-connected").screenshot({ path: "tests/scratch/node-agent-mobile.png" });
		assert.deepEqual(errors, []);
		console.log("PASS remote agent browser start, streaming, prompt acknowledgement, confirmation and simultaneous terminal/Agent panes");
	}

	console.log("PASS real SSH/native RPC streaming, remote credentials, dialog round-trip, fresh session, identity isolation and scoped shutdown");
} finally {
	await browser?.close(); if (web) { web.kill("SIGTERM"); if (web.exitCode === null) await new Promise(resolve => web.once("exit", resolve)); }
	service.dispose(); for (const child of children) child.kill("SIGTERM"); for (const client of clients) client.end();
	await new Promise(resolve => ssh.close(resolve)); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); rmSync(root, { recursive: true, force: true });
}
