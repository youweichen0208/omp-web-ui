// Isolated mock-provider regression: delayed titles, history persistence and manual rename.
//
// Usage: npm run build && node tests/conversation-title-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8994);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-switch-session-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const titleRequests = [];
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
	const last = payload.messages?.at(-1);
	const prompt = typeof last?.content === "string"
		? last.content
		: last?.content?.filter?.((part) => part.type === "text").map((part) => part.text).join(" ") ?? "";
	const naming = prompt.includes("Summarize the topic of the user request");
	if (naming) titleRequests.push(prompt);
	const slow = naming;
	const greetingTitle = naming && prompt.includes("User request:\n你好");
	const first = greetingTitle ? "简短" : naming ? "优化项目" : "已完成";
	const lastChunk = greetingTitle ? "问候" : naming ? "切换性能" : "缓存优化";
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
	});
	const writeChunk = (content) => res.write(
		`data: ${JSON.stringify({
			id: "switch-session-test",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: { content }, finish_reason: null }],
		})}\n\n`,
	);
	writeChunk(first);
	if (slow) await sleep(2500);
	writeChunk(lastChunk);
	res.write(
		`data: ${JSON.stringify({
			id: "switch-session-test",
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
	JSON.stringify({ main: { type: "api_key", key: "switch-session-test" } }),
);
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "switch-session-test",
				models: [{
					id: "switch-session-mock",
					name: "Switch Session Mock",
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
		PI_WEB_DEBUG_TITLE: "1",
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});

let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });

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
try {
	await waitForPort(PORT);
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	client = new Client(ws);
	client.send({ type: "hello", clientId: "switch-session-background-test" });
	await client.waitForType("ready");
	client.send({ type: "list_sessions" });
	const initial = await client.waitForState((state) => Boolean(state.conversationId));
	await client.waitForType("conversations", (message) => message.conversations.some((conv) => conv.id === initial.conversationId && conv.title === "新对话"));
	console.log("✓ active new chat appears in sidebar source");

	client.send({ type: "set_model", modelId: "main/switch-session-mock" });
	await client.waitForState((state) => state.model?.id === "switch-session-mock");

	client.send({ type: "prompt", text: "你好" });
	await client.waitForMessage((m) => m.role === "assistant");
	await client.waitForType("conversations", (message) => message.conversations.some((conv) => conv.id === initial.conversationId && conv.title === "你好"));
	await sleep(300);
	if (titleRequests.length !== 0) throw new Error("casual greeting should not request a generated title");
	console.log("✓ casual greeting keeps its original title");
	client.send({ type: "new_chat" });
	await client.waitForState((state) => state.conversationId !== initial.conversationId);
	client.send({ type: "prompt", text: "优化项目切换" });
	await client.waitForType("sessions", (m) => m.sessions.some((s) => s.name === "优化项目切换性能"));
	if (!titleRequests[0]?.includes("Assistant response:\n已完成缓存优化")) throw new Error("missing answer context");
	const path = client.state.sessionFile;
	client.send({ type: "list_sessions" });
	await client.waitForType("sessions", (m) => m.sessions.some((s) => s.path === path && s.name === "优化项目切换性能"));
	console.log("✓ completed pair generates and persists history title");
	const oldId = client.state.conversationId;
	client.send({ type: "new_chat" });
	await client.waitForState((s) => s.conversationId !== oldId);
	client.send({ type: "prompt", text: "测试手动命名保护" });
	for (let i = 0; i < 100 && titleRequests.length < 2; i++) await sleep(50);
	if (titleRequests.length !== 2) throw new Error("second naming request missing");
	client.send({ type: "get_state" });
	await client.waitForState((s) => s.sessionFile && s.sessionFile !== path);
	const manualPath = client.state.sessionFile;
	client.send({ type: "rename_session", path: manualPath, name: "我的手动标题" });
	await client.waitForType("sessions", (m) => m.sessions.some((s) => s.path === manualPath && s.name === "我的手动标题"));
	await sleep(2800);
	client.send({ type: "list_sessions" });
	await client.waitForType("sessions", (m) => m.sessions.some((s) => s.path === manualPath && s.name === "我的手动标题"));

	console.log("✓ manual rename survives late model response");

} catch (error) {
	console.error(`✗ ${error.message}`, serverLog, titleRequests);
	process.exitCode = 1;
} finally {
	client?.ws.close();
	server.kill();
	mock.close();
}
