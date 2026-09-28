// Regression: /new must start with empty history and no previous model context.
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const PORT = Number(process.argv[2] || 8967);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-new-context-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

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
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

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

const repoRoot = realpathSync(new URL("../", import.meta.url));
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
	windowsHide: true,
});

const waitForPort = async (port, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			if (response.ok) return;
		} catch {
			/* starting */
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

	client.send({ type: "prompt", text: "OLD_CONTEXT_SENTINEL" });
	await client.waitForMessage((message) => message.role === "assistant");
	await client.waitForState((state) => !state.isStreaming);
	const oldId = client.state.conversationId;
	const historyPath = client.state.sessionFile;
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage();
	await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "new-chat-context-test"));
	let hold = false;
	let resyncs = 0;
	let downstream;
	const held = [];
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
	await client.waitForState((state) => state.conversationId !== oldId);
	await page.waitForTimeout(200);
	if (await page.locator(".main").getByText("OLD_CONTEXT_SENTINEL", { exact: true }).isVisible()) throw new Error("UI retained old messages after active conversation changed while snapshot was delayed");
	if (await page.locator(".usage-percent").innerText() !== "—") throw new Error("UI retained old context usage while awaiting new snapshot");
	for (let i = 0; i < 20 && !resyncs; i++) await sleep(50);
	if (!resyncs) throw new Error("Missing snapshot recovery request");
	if (!(await page.locator(".status-messages").innerText()).includes("—")) throw new Error("Footer retained old message count");
	hold = false;
	for (const wire of held) downstream.send(wire);
	await page.waitForFunction(() => document.querySelector(".usage-percent")?.textContent === "0%");
	if (client.messages.length) throw new Error("/new retained old messages");
	if (client.state.stats.contextUsage.tokens > 0) throw new Error("/new retained context usage");
	client.send({ type: "prompt", text: "NEW_CONTEXT_SENTINEL" });
	await client.waitForMessage((message) => message.role === "assistant");
	const chatRequests = requests.filter((request) => request.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.text === "OLD_CONTEXT_SENTINEL" || part.text === "NEW_CONTEXT_SENTINEL")));
	if (chatRequests.length !== 2) throw new Error("Expected two chat requests");
	if (requests.some((request) => request.messages.some((message) => message.content === "/new" || (Array.isArray(message.content) && message.content.some((part) => part.text === "/new"))))) throw new Error("/new was sent to the model");
	if (JSON.stringify(chatRequests[1]).includes("OLD_CONTEXT_SENTINEL")) throw new Error("/new leaked previous context into model request");
	client.send({ type: "switch_session", path: historyPath });
	await client.waitForState((state) => state.sessionFile === historyPath);
	await page.locator(".main").getByText("OLD_CONTEXT_SENTINEL", { exact: true }).waitFor();
	console.log("✓ old history remains recoverable");
	console.log("✓ /new clears messages and usage; next model request contains no old context");

} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exitCode = 1;
} finally {
	await browser?.close();
	client?.ws.close();
	const stopped = new Promise((resolve) => server.once("exit", resolve));
	server.kill();
	await stopped;
	await new Promise((resolve) => mock.close(resolve));
	rmSync(base, { recursive: true, force: true });
}
