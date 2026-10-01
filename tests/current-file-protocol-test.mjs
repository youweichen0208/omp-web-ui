// Real SDK and local mock provider: frozen editor drafts, queue delivery and history reask.
import assert from "node:assert/strict";
import { portUp } from "./lib/port-utils.mjs";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = 8988;
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-switch-session-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const requests = [];
writeFileSync(join(workdir, "note.txt"), "disk original");
assert.equal(await portUp(PORT), false);
assert.equal(await portUp(MOCK_PORT), false);
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
	if (payload.tools?.length) requests.push(payload);
	const last = payload.messages?.at(-1);
	const prompt = typeof last?.content === "string"
		? last.content
		: last?.content?.filter?.((part) => part.type === "text").map((part) => part.text).join(" ") ?? "";
	const slow = prompt === "SLOW";
	const first = slow ? "background-" : "seed-";
	const lastChunk = slow ? "finished" : "message";
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
	res.write(`data: ${JSON.stringify({ id: "thinking-test", object: "chat.completion.chunk", created: Date.now(), model: payload.model, choices: [{ index: 0, delta: { reasoning_content: "Check the draft" }, finish_reason: null }] })}\n\n`);
	await sleep(150);
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
		throw new Error(`timeout waiting for state (${requests.length} model requests)`);
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
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	client = new Client(ws);
	client.send({ type: "hello", clientId: "current-file-protocol" });
	await client.waitForType("ready");
	await client.waitForState((s) => Boolean(s.conversationId));
	client.send({ type: "set_model", modelId: "main/switch-session-mock" });
	await client.waitForState((s) => s.model?.id === "switch-session-mock");
	const sendDraft = (requestId, draft, queue = false) => client.send({ type: "prompt", requestId, queue, text: requestId, attachments: [{ path: "note.txt", editorSnapshot: { cwd: workdir, text: draft, dirty: true } }] });
	sendDraft("normal", "DRAFT_NORMAL");
	assert.equal((await client.waitForType("prompt_result", (m) => m.requestId === "normal")).ok, true);
	await client.waitForMessage((m) => m.role === "assistant");
	const thought = client.messages.find((m) => m.role === "assistant")?.content.find((b) => b.type === "thinking");
	assert(thought && thought.durationMs >= 100, `real SDK thinking duration: ${JSON.stringify(thought)}`);
	assert(JSON.stringify(requests[0]).includes("DRAFT_NORMAL"));
	assert(JSON.stringify(requests[0]).includes("Prioritize"));
	assert(!JSON.stringify(requests[0]).includes("disk original"));
	await client.waitForState((s) => !s.isStreaming);
	const savedThinking = JSON.parse(readFileSync(join(dataDir, "thinking-durations.json"), "utf8"));
	assert(Object.values(savedThinking).some((blocks) => Object.values(blocks).some((ms) => ms >= 100)), "completed thinking duration is persisted");
	client.send({ type: "prompt", text: "SLOW" });
	await client.waitForState((s) => s.isStreaming);
	sendDraft("steering", "DRAFT_STEER");
	assert.equal((await client.waitForType("prompt_result", (m) => m.requestId === "steering")).ok, true);
	sendDraft("followup", "DRAFT_FOLLOWUP", true);
	assert.equal((await client.waitForType("prompt_result", (m) => m.requestId === "followup")).ok, true);
	for (let n = 0; n < 200 && requests.length < 4; n++) await sleep(50);
	assert.equal(requests.length, 4);
	assert(JSON.stringify(requests[2]).includes("DRAFT_STEER"));
	assert(!JSON.stringify(requests[2]).includes("DRAFT_FOLLOWUP"));
	assert(JSON.stringify(requests[3]).includes("DRAFT_FOLLOWUP"));
	await client.waitForMessage((m) => m.details?.editorSnapshot?.text === "DRAFT_FOLLOWUP");
	await client.waitForState((s) => !s.isStreaming);
	const originalQuestion = client.messages.find((m) => m.role === "user" && m.content.some((b) => b.text === "normal"));
	assert(originalQuestion);
	const originalCard = client.messages.find((m) => m.details?.editorSnapshot?.text === "DRAFT_NORMAL");
	assert(originalCard);
	client.send({ type: "edit_message", messageId: originalQuestion.id, text: "reask original", attachments: [{ path: "note.txt", editorSnapshot: originalCard.details.editorSnapshot }] });
	for (let n = 0; n < 200 && requests.length < 5; n++) await sleep(50);
	assert.equal(requests.length, 5);
	assert(JSON.stringify(requests[4]).includes("DRAFT_NORMAL"));
	assert(!JSON.stringify(requests[4]).includes("DRAFT_FOLLOWUP"));
	assert.equal(readFileSync(join(workdir, "note.txt"), "utf8"), "disk original");
	console.log("PASS actual SDK/model protocol: ordinary, steer, followUp receive frozen editor snapshots and source; history/reask preserved; disk unchanged");
} finally {
	client?.ws.close();
	server.kill("SIGTERM");
	await new Promise((resolve) => server.once("exit", resolve));
	await new Promise((resolve) => mock.close(resolve));
}
