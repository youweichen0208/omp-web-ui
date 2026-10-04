// Regression: /new creates a native SDK session; new_chat opens an independent runtime.
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, createCodemodeExtension, createToolSearchExtension, createMcpExtension } from "@earendil-works/pi-coding-agent";

const PROTOCOL_ONLY = process.argv.includes("--protocol-only");
const PORT = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) || 8967);
const MOCK_PORT = PORT + 1;
if (PORT < 8900 || PORT >= 65535) throw new Error("Use isolated test ports >= 8900");
for (const port of [PORT, MOCK_PORT]) if (await portUp(port)) throw new Error(`Port ${port} is occupied`);
const base = mkdtempSync(join(tmpdir(), "pi-web-new-context-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(agentDir, "extensions"));
writeFileSync(join(agentDir, "extensions", "cancel-new.ts"), `import { existsSync } from "node:fs"; import { join } from "node:path";
export default function(pi) { pi.on("session_before_switch", async (event, ctx) => event.reason === "new" && existsSync(join(ctx.cwd, "cancel-new")) ? { cancel: true } : undefined); }`);

const requests = [];
const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	let payload;
	try {
		payload = JSON.parse(body);
	} catch {
		res.writeHead(400).end("bad json");
		return;
	}
	requests.push(payload);
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
	});
	const writeChunk = (content) => res.write(
		`data: ${JSON.stringify({
			id: "new-context-test",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: { content }, finish_reason: null }],
		})}\n\n`,
	);
	writeChunk("mock reply");
	res.write(
		`data: ${JSON.stringify({
			id: "new-context-test",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 },
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((resolve, reject) => { mock.once("error", reject); mock.listen(MOCK_PORT, "127.0.0.1", resolve); });

writeFileSync(
	join(agentDir, "auth.json"),
	JSON.stringify({ main: { type: "api_key", key: "new-context-test" } }),
);
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "new-context-test",
				models: [{
					id: "new-context-mock",
					name: "New Context Mock",
					input: ["text"],
					contextWindow: 32000,
					maxTokens: 4096,
				}],
			},
		},
	}),
);

writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["+codemode", "+tool_search"] }));
// Independent native SDK reference, with the same official extensions as Pi CLI.
const nativeServices = await createAgentSessionServices({ cwd: workdir, agentDir, resourceLoaderOptions: { extensionFactories: [
 { name: "codemode", builtin: true, factory: createCodemodeExtension() },
 { name: "tool-search", builtin: true, factory: createToolSearchExtension() },
 { name: "mcp", builtin: true, factory: createMcpExtension() },
] } });
const nativeReference = await createAgentSessionFromServices({ services: nativeServices, sessionManager: SessionManager.inMemory(workdir) });
const nativePrompt = nativeReference.session.systemPrompt;
const nativeTools = nativeReference.session.getActiveToolNames().sort();
nativeReference.session.dispose();

const repoRoot = realpathSync(new URL("../", import.meta.url));
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_TOKEN: "",
	},
	stdio: ["ignore", "ignore", "pipe"],
	windowsHide: true,
});

let serverLog = "";
server.stderr.on("data", (chunk) => { serverLog += chunk; });
const waitForPort = async (port, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Test server exited: ${serverLog}`);
		let health;
		try { health = await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })).json(); } catch { /* starting */ }
		if (health) {
			if (health.pid !== server.pid) throw new Error("Health response belongs to another process");
			if (health.ok) return;
		}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		this.messages = [];
		this.conversations = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") {
				this.state = message.state;
				this.messages = message.state.messages ?? [];
			} else if (
				message.type === "snapshot_delta" &&
				this.state &&
				this.state.rev === message.baseRev &&
				message.conversationId === this.state.conversationId
			) {
				this.state = { ...this.state, ...message.state };
				this.messages = [...this.messages, ...message.appended];
			} else if (message.type === "conversations") {
				this.conversations = message.conversations;
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const message = this.received[i];
				if (message.type !== type || !predicate(message)) continue;
				this.received.splice(i, 1);
				return message;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
	async waitForMessage(predicate, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const message = this.messages.find(predicate);
			if (message) return message;
			await sleep(50);
		}
		throw new Error("timeout waiting for message");
	}
}

let client;
let browser;
try {
	await waitForPort(PORT);
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	client = new Client(ws);
	client.send({ type: "hello", clientId: "new-chat-context-test" });
	await client.waitForType("ready");
	await client.waitForState((state) => Boolean(state.conversationId));

	client.send({ type: "set_model", modelId: "main/new-context-mock" });
	await client.waitForState((state) => state.model?.id === "new-context-mock");

	// Even a blank session must get a new SDK identity when /new succeeds.
	const blankPath = client.state.sessionFile;
	const blankId = client.state.sessionId;
	const beforeBlankNew = client.state.rev;
	client.send({ type: "prompt", text: "/new", requestId: "blank-new" });
	const blankResult = await client.waitForType("prompt_result", (message) => message.requestId === "blank-new");
	if (!blankResult.ok) throw new Error("Blank session creation failed");
	await client.waitForState((state) => state.rev > beforeBlankNew);
	if (client.state.sessionFile === blankPath || client.state.sessionId === blankId) throw new Error("/new reused a blank session identity");
	if (client.messages.length || client.state.stats.tokens.total !== 0) throw new Error("/new added context or usage");
	client.send({ type: "prompt", text: "OLD_CONTEXT_SENTINEL" });
	await client.waitForMessage((message) => message.role === "assistant");
	await client.waitForState((state) => !state.isStreaming);
	if (!(client.state.stats.tokens.total > 0)) throw new Error("Fixture must start with nonzero usage");
	const oldId = client.state.conversationId;
	const historyPath = client.state.sessionFile;
	const sessionId = client.state.sessionId;
	const originalHeader = JSON.parse(readFileSync(historyPath, "utf8").split("\n")[0]);
	client.send({ type: "rename_session", path: historyPath, name: "Keep this conversation" });
	await client.waitForType("sessions", (message) => message.sessions.some((session) => session.name === "Keep this conversation"));
	const beforeCancelledNew = readFileSync(historyPath, "utf8");
	writeFileSync(join(workdir, "cancel-new"), "");
	client.send({ type: "prompt", text: "/new", requestId: "cancelled-new" });
	await client.waitForType("prompt_result", (message) => message.requestId === "cancelled-new");
	if (readFileSync(historyPath, "utf8") !== beforeCancelledNew) throw new Error("Cancelled /new changed the transcript");
	rmSync(join(workdir, "cancel-new"));
	let page;
	let hold = false;
	let resyncs = 0;
	let downstream;
	const held = [];
	if (!PROTOCOL_ONLY) {
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
		page = await browser.newPage();
		await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "new-chat-context-test"));
		await page.routeWebSocket("**/ws", (socket) => {
			downstream = socket;
			const upstream = socket.connectToServer();
			socket.onMessage((wire) => {
				const message = JSON.parse(String(wire));
				if (message.type === "prompt" && message.text === "/new") hold = true;
				if (hold && message.type === "get_state") resyncs++;
				upstream.send(wire);
			});
			upstream.onMessage((wire) => {
				const message = JSON.parse(String(wire));
				if (hold && (message.type === "snapshot" || message.type === "snapshot_delta")) held.push(wire);
				else socket.send(wire);
			});
		});
		await page.goto(`http://127.0.0.1:${PORT}`);
		await page.locator(".main").getByText("OLD_CONTEXT_SENTINEL", { exact: true }).waitFor();
		const input = page.locator(".inputbox textarea");
		await input.fill("/new");
		await input.press("Escape");
		await input.press("Enter");
	} else client.send({ type: "prompt", text: "/new" });
	await client.waitForState((state) => !state.isStreaming && state.messages.length === 0 && state.stats.tokens.total === 0);
	if (client.state.sessionFile === historyPath) throw new Error("/new reused the old session file");
	if (client.state.sessionId === sessionId) throw new Error("/new reused the old SDK session ID");
	if (client.state.conversationId !== oldId) throw new Error("/new unexpectedly changed the Web conversation slot");
	hold = false;
	if (page) {
		for (const wire of held) downstream.send(wire);
		await page.waitForFunction(() => document.querySelector(".usage-percent")?.textContent === "0%");
		if (await page.locator(".main").getByText("OLD_CONTEXT_SENTINEL", { exact: true }).isVisible()) throw new Error("/new retained old messages in UI");
		await page.waitForFunction(() => document.querySelectorAll(".session-item").length === 2);
	}
	if (client.state.model?.id !== "new-context-mock") throw new Error("/new lost the selected model");
	if (client.state.stats.tokens.total !== 0) throw new Error("/new retained accumulated token usage");
	if (client.messages.length) throw new Error("/new retained old messages");
	if (client.state.stats.contextUsage.tokens > 0) throw new Error("/new retained context usage");
	client.send({ type: "prompt", text: "NEW_CONTEXT_SENTINEL" });
	await client.waitForMessage((message) => message.role === "assistant");
	const chatRequests = requests.filter((request) => request.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.text === "OLD_CONTEXT_SENTINEL" || part.text === "NEW_CONTEXT_SENTINEL")));
	if (chatRequests.length !== 2) throw new Error("Expected two chat requests");
	const tools = chatRequests[0].tools.map((tool) => tool.function.name);
	if (tools.some(name => ["todo", "task_plan", "web_subagent", "submit_result"].includes(name) || name.startsWith("terminal_"))) throw new Error("Host agent tools leaked into native context");
	if (JSON.stringify(tools.sort()) !== JSON.stringify(nativeTools)) throw new Error("WebUI tool list differs from native SDK");
	for (const request of chatRequests) {
		const system = request.messages.find(message => message.role === "system" || message.role === "developer");
		const content = typeof system?.content === "string" ? system.content : system?.content?.map(part => part.text ?? "").join("\n");
		if (content !== nativePrompt) throw new Error("WebUI system prompt differs from native SDK");
	}
	console.log("✓ model requests have the same system prompt and active tools as an independent native pi 1.0.2 session");

	if (requests.some((request) => request.messages.some((message) => message.content === "/new" || (Array.isArray(message.content) && message.content.some((part) => part.text === "/new"))))) throw new Error("/new was sent to the model");
	if (JSON.stringify(chatRequests[1]).includes("OLD_CONTEXT_SENTINEL")) throw new Error("/new leaked previous context into model request");
	if (client.state.stats.tokens.total !== 132) throw new Error("New session usage must count only its own response");
	client.received = client.received.filter((message) => message.type !== "sessions");
	client.send({ type: "list_sessions" });
	const list = await client.waitForType("sessions", (message) => message.sessions.some((session) => session.path === historyPath));
	if (list.sessions.find((session) => session.path === historyPath)?.name !== "Keep this conversation") throw new Error("/new changed the old session title");
	const newPath = client.state.sessionFile;
	const newId = client.state.sessionId;
	if (list.sessions.length !== 2 || !list.sessions.some((session) => session.path === newPath)) throw new Error("Expected separate old and new sessions");
	const transcript = readFileSync(historyPath, "utf8");
	if (!transcript.includes("OLD_CONTEXT_SENTINEL")) throw new Error("/new must retain old history on disk");
	if (JSON.stringify(JSON.parse(transcript.split("\n")[0])) !== JSON.stringify(originalHeader)) throw new Error("/new changed the old session header/creation time");
	// A separate client reconstructs the new session from disk.
	const reopenedWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => { reopenedWs.once("open", resolve); reopenedWs.once("error", reject); });
	const reopened = new Client(reopenedWs);
	try {
		reopened.send({ type: "hello", clientId: "new-chat-context-reopened" });
		await reopened.waitForType("ready");
		await reopened.waitForState((state) => state.sessionFile === newPath);
		if (JSON.stringify(reopened.messages).includes("OLD_CONTEXT_SENTINEL")) throw new Error("Reopen mixed in old session context");
		if (reopened.state.stats.tokens.total !== 132) throw new Error("Reopen restored old usage");
	} finally { reopenedWs.terminate(); }
	console.log("✓ /new creates a new SDK identity, preserves old history, and reopens with its own context and usage");
	// Repeated /new must create another identity without accumulating usage.
	client.send({ type: "prompt", text: "/new" });
	await client.waitForState((state) => !state.messages.length && state.stats.tokens.total === 0);
	if (client.state.sessionFile === newPath || client.state.sessionId === newId) throw new Error("Repeated /new reused session identity");
	client.send({ type: "prompt", text: "AFTER_SECOND_NEW" });
	await client.waitForMessage((message) => message.role === "assistant");
	await client.waitForState((state) => !state.isStreaming);
	if (client.state.stats.tokens.total !== 132) throw new Error("Repeated /new retained old usage");
	if (JSON.stringify(requests.at(-1)).includes("NEW_CONTEXT_SENTINEL")) throw new Error("Repeated /new retained old context");
	client.send({ type: "switch_session", path: historyPath });
	await client.waitForState((state) => state.sessionFile === historyPath);
	if (!JSON.stringify(client.messages).includes("OLD_CONTEXT_SENTINEL")) throw new Error("Cannot restore old session history");
	if (client.state.stats.tokens.total !== 132) throw new Error("Old session usage changed");
	if (page) await page.locator(".main").getByText("OLD_CONTEXT_SENTINEL", { exact: true }).waitFor();
	const resumedId = client.state.conversationId;
	hold = true;
	held.length = 0;
	resyncs = 0;
	client.send({ type: "new_chat" });
	await client.waitForState((state) => state.conversationId !== resumedId);
	if (client.messages.length || client.state.stats.tokens.total !== 0) throw new Error("new_chat did not open an empty conversation");
	if (page) {
		await page.waitForFunction(() => document.querySelector(".usage-percent")?.textContent === "—");
		if (await page.locator(".main").getByText("OLD_CONTEXT_SENTINEL", { exact: true }).isVisible()) throw new Error("UI retained old messages while new_chat snapshot was delayed");
		for (let i = 0; i < 20 && !resyncs; i++) await sleep(50);
		if (!resyncs) throw new Error("Missing snapshot recovery request");
		if (!(await page.locator(".status-messages").innerText()).includes("—")) throw new Error("Footer retained old message count");
		hold = false;
		for (const wire of held) downstream.send(wire);
		await page.waitForFunction(() => document.querySelector(".usage-percent")?.textContent === "0%");
	}
	console.log("✓ new_chat opens a separate conversation without stale UI during delayed snapshots");
	console.log("✓ native /new starts empty; old history remains restorable; next request contains no old context");

} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exitCode = 1;
} finally {
	await browser?.close();
	client?.ws.close();
	if (server.exitCode === null && server.signalCode === null) {
		const stopped = new Promise((resolve) => server.once("exit", resolve));
		server.kill();
		const force = setTimeout(() => server.kill("SIGKILL"), 5000);
		await stopped; clearTimeout(force);
	}
	mock.closeAllConnections();
	await new Promise((resolve) => mock.close(resolve));
	rmSync(base, { recursive: true, force: true });
}
