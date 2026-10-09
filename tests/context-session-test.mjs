import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runQuestion } from "../dev/context-eval/session.mjs";
import { snapshotSources } from "../dev/context-eval/corpus.mjs";

const finalAnswer = JSON.stringify({ answer: "The retry limit is three.", insufficientEvidence: false, evidence: [{ sourceId: "demo", path: "note.md", lineStart: 1, lineEnd: 1, quote: "Retry limit: 3." }] });

async function listen(handler) {
	const server = createServer(handler);
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	assert.ok(server.address().port >= 8900, "test port must be isolated");
	return { url: `http://127.0.0.1:${server.address().port}`, async close() {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	} };
}

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "context-session-test-")));
	const bytes = Buffer.from("Retry limit: 3.\n");
	await writeFile(join(root, "note.md"), bytes);
	await writeFile(join(root, "AGENTS.md"), "PRIVATE_CONTEXT_SENTINEL");
	return { root, corpus: {
		sources: [{ id: "demo", kind: "personal", root, files: ["note.md"], vikingUri: "viking://resources/evaluation/demo" }],
		documents: [{ sourceId: "demo", path: "note.md", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, lineCount: 1 }],
	}, close: () => rm(root, { recursive: true, force: true }) };
}

async function mockModel(steps) {
	const requests = [];
	const server = await listen(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const payload = JSON.parse(raw);
		requests.push(payload);
		const step = steps[requests.length - 1] ?? { answer: finalAnswer };
		if (step.redirect) { res.writeHead(307, { location: step.redirect }).end(); return; }
		if (step.hang) return;
		const delta = step.tool ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] } : { content: step.answer ?? finalAnswer };
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: step.tool ? "tool_calls" : "stop" }]) {
			res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "local-test", choices: [choice], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })}\n\n`);
		}
		res.end("data: [DONE]\n\n");
	});
	return { ...server, requests };
}

const configuration = model => ({ model: { baseUrl: `${model.url}/v1`, id: "local-test", contextWindow: 32768, maxTokens: 4096 }, timeoutMs: 10000 });
const question = { id: "retry", prompt: "What is the retry limit?" };

test("native baseline reads a copied corpus with no discovered user resources or write tools", async () => {
	const source = await fixture();
	const model = await mockModel([{ tool: "read", args: { path: "demo/note.md" } }]);
	try {
		const result = await runQuestion(configuration(model), { arm: "baseline", question, corpus: source.corpus });
		assert.equal(result.answer, finalAnswer);
		assert.equal(model.requests.length, 2);
		assert.deepEqual(model.requests[0].tools.map(tool => tool.function.name).sort(), ["find", "grep", "ls", "read"]);
		assert.ok(!JSON.stringify(model.requests).includes("PRIVATE_CONTEXT_SENTINEL"));
		assert.ok(!JSON.stringify(model.requests[0]).includes(source.root));
		const readResult = model.requests[1].messages.find(message => message.role === "tool");
		assert.match(readResult.content, /Retry limit: 3/);
		assert.equal(result.toolCalls[0].name, "read");
		assert.ok(result.toolCalls[0].argsBytes > 0);
		assert.ok(result.toolCalls[0].resultBytes > 0);
		assert.ok(result.runnerPeakRssBytes > 0);
		assert.ok(result.usage.totalTokens > 0);
	} finally { await model.close(); await source.close(); }
});

test("native tool guard blocks reads outside the copied corpus", async () => {
	const source = await fixture();
	const model = await mockModel([{ tool: "read", args: { path: join(source.root, "AGENTS.md") } }]);
	try {
		const result = await runQuestion(configuration(model), { arm: "baseline", question, corpus: source.corpus });
		assert.equal(result.toolCalls[0].blocked, true);
		assert.ok(!JSON.stringify(model.requests).includes("PRIVATE_CONTEXT_SENTINEL"));
	} finally { await model.close(); await source.close(); }
});

test("corpus hash changes including swapped symlink targets fail before model requests", async () => {
	const source = await fixture();
	const model = await mockModel([]);
	try {
		await writeFile(join(source.root, "note.md"), "changed");
		await assert.rejects(runQuestion(configuration(model), { arm: "baseline", question, corpus: source.corpus }), /Stale evidence/);
		await rm(join(source.root, "note.md"));
		await symlink(join(source.root, "AGENTS.md"), join(source.root, "note.md"));
		await assert.rejects(runQuestion(configuration(model), { arm: "baseline", question, corpus: source.corpus }), /Stale evidence/);
		assert.equal(model.requests.length, 0);
	} finally { await model.close(); await source.close(); }
});

test("allowlisted internal symlinks are materialized as verified file copies", async () => {
	const source = await fixture();
	const model = await mockModel([{ tool: "read", args: { path: "demo/link.md" } }]);
	try {
		await symlink(join(source.root, "note.md"), join(source.root, "link.md"));
		const corpus = await snapshotSources([{ id: "demo", kind: "personal", root: source.root, files: ["link.md"] }]);
		const result = await runQuestion(configuration(model), { arm: "baseline", question, corpus });
		assert.equal(result.toolCalls[0].isError, false);
		assert.match(model.requests[1].messages.find(message => message.role === "tool").content, /Retry limit: 3/);
	} finally { await model.close(); await source.close(); }
});

test("invalid JSON, timeouts, and non-loopback model endpoints fail the sample", async () => {
	const source = await fixture();
	const model = await mockModel([{ answer: "Not JSON" }, { hang: true }]);
	try {
		await assert.rejects(runQuestion(configuration(model), { arm: "baseline", question, corpus: source.corpus }), /not valid JSON/);
		await assert.rejects(runQuestion({ ...configuration(model), timeoutMs: 200 }, { arm: "baseline", question, corpus: source.corpus }), /timed out/);
		await assert.rejects(runQuestion({ ...configuration(model), model: { ...configuration(model).model, baseUrl: "https://example.com/v1" } }, { arm: "baseline", question, corpus: source.corpus }), /literal loopback/);
	} finally { await model.close(); await source.close(); }
});

test("model redirects are refused without forwarding any request to the redirect target", async () => {
	const source = await fixture();
	let leaked = 0;
	const target = await listen((_req, res) => { leaked++; res.end("unexpected"); });
	const model = await mockModel([{ redirect: `${target.url}/leak` }]);
	try {
		await assert.rejects(runQuestion(configuration(model), { arm: "baseline", question, corpus: source.corpus }), /Selected model failed/);
		assert.equal(leaked, 0);
	} finally { await model.close(); await target.close(); await source.close(); }
});

test("native MCP exposes only the read-only allowlist and enforces source URI scope", async () => {
	const source = await fixture();
	const mcpCalls = [];
	const mcp = await listen(async (req, res) => {
		if (req.method !== "POST") { res.writeHead(405).end(); return; }
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		assert.equal(req.headers["x-api-key"], "runtime-only-key");
		if (body.id === undefined) { res.writeHead(202).end(); return; }
		let result;
		if (body.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "context-fixture", version: "1" } };
		else if (body.method === "tools/list") result = { tools: ["find", "read", "list", "grep", "glob", "search", "write", "delete"].map(name => {
			const key = name === "read" ? "uris" : name === "find" ? "target_uri" : "uri";
			return { name, description: name, inputSchema: { type: "object", properties: { [key]: { type: "string" }, uri: { type: "string" } } } };
		}) };
		else if (body.method === "tools/call") { mcpCalls.push(body.params); result = { content: [{ type: "text", text: "Retry limit: 3." }] }; }
		else result = {};
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
	});
	const model = await mockModel([
		{ tool: "mcp__openviking__read", args: { uris: "viking://resources/evaluation/demo/note.md" } },
		{ tool: "mcp__openviking__find", args: { target_uri: "viking://resources" } },
		{ tool: "mcp__openviking__find", args: { uri: "viking://resources/evaluation/demo" } },
	]);
	try {
		const config = { ...configuration(model), openviking: { url: `${mcp.url}/mcp`, apiKey: "runtime-only-key" } };
		const result = await runQuestion(config, { arm: "openviking", question, corpus: source.corpus });
		const names = model.requests[0].tools.map(tool => tool.function.name);
		assert.ok(names.includes("mcp__openviking__read"));
		for (const name of ["bash", "write", "codemode", "mcp__openviking__search", "mcp__openviking__write", "mcp__openviking__delete"]) assert.ok(!names.includes(name), name);
		assert.equal(mcpCalls.length, 1);
		assert.equal(result.toolCalls[1].blocked, true);
		assert.equal(result.toolCalls[2].blocked, true);
		assert.ok(!JSON.stringify(model.requests).includes("runtime-only-key"));
		assert.ok(!JSON.stringify(result).includes("runtime-only-key"));
	} finally { await model.close(); await mcp.close(); await source.close(); }
});

async function discoveryMcp({ empty = false, redirect } = {}) {
	return listen(async (req, res) => {
		if (redirect) { res.writeHead(307, { location: redirect }).end(); return; }
		if (req.method !== "POST") { res.writeHead(405).end(); return; }
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		if (body.id === undefined) { res.writeHead(202).end(); return; }
		const result = body.method === "initialize"
			? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
			: { tools: empty ? [] : ["find", "read"].map(name => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) };
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
	});
}

test("OpenViking empty discovery, unreachable endpoints and redirects fail instead of running baseline", async () => {
	const source = await fixture(), model = await mockModel([]), empty = await discoveryMcp({ empty: true });
	let leaked = 0;
	const target = await listen((_req, res) => { leaked++; res.end("unexpected"); });
	const redirect = await discoveryMcp({ redirect: `${target.url}/leak` });
	const unavailable = await listen((_req, res) => res.end());
	await unavailable.close();
	try {
		for (const endpoint of [empty, redirect, unavailable]) {
			await assert.rejects(runQuestion({ ...configuration(model), timeoutMs: 1000, openviking: { url: `${endpoint.url}/mcp` } }, { arm: "openviking", question, corpus: source.corpus }), /MCP connection failed|timed out/);
		}
		assert.equal(model.requests.length, 0);
		assert.equal(leaked, 0);
	} finally { await model.close(); await empty.close(); await target.close(); await redirect.close(); await source.close(); }
});

function onePagePdf() {
	const stream = "BT /F1 12 Tf 36 100 Td (Local engineering evidence) Tj ET\n";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
	];
	let output = "%PDF-1.4\n";
	const offsets = [0];
	for (let index = 0; index < objects.length; index++) {
		offsets.push(Buffer.byteLength(output));
		output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(output);
	output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	output += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
	output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(output);
}

test("both arms get identical PDF page text and provenance with dotted source IDs", async () => {
	const source = await fixture();
	await writeFile(join(source.root, "manual.pdf"), onePagePdf());
	const corpus = await snapshotSources([{ id: "manual.v1", kind: "reference", root: source.root, files: ["manual.pdf"], vikingUri: "viking://resources/evaluation/manual" }]);
	corpus.documents[0].git = { commit: "123abc", dirty: true };
	const model = await mockModel([
		{ tool: "read", args: { path: "__pdf_text/1/page-1.txt" } },
		{ answer: finalAnswer },
		{ tool: "read", args: { path: "__pdf_text/1/page-1.txt" } },
	]);
	const mcp = await discoveryMcp();
	try {
		for (const arm of ["baseline", "openviking"]) {
			await runQuestion({ ...configuration(model), openviking: { url: `${mcp.url}/mcp` } }, { arm, question, corpus });
		}
		const baselinePrompt = model.requests[0].messages.find(message => message.role === "user").content;
		const candidatePrompt = model.requests[2].messages.find(message => message.role === "user").content;
		assert.deepEqual(baselinePrompt, candidatePrompt);
		assert.match(JSON.stringify(baselinePrompt), /manual\.v1/);
		assert.match(JSON.stringify(baselinePrompt), /123abc/);
		assert.match(JSON.stringify(baselinePrompt), /page-1\.txt/);
		assert.match(JSON.stringify(baselinePrompt), new RegExp(corpus.documents[0].sha256));
		for (const index of [1, 3]) assert.match(model.requests[index].messages.find(message => message.role === "tool").content, /Local engineering evidence/);
	} finally { await model.close(); await mcp.close(); await source.close(); }
});

test("selected Pi Anthropic model uses its pinned route and runtime-only credentials", async () => {
	const source = await fixture();
	const requests = [];
	const model = await listen(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		requests.push({ path: req.url, headers: req.headers, body });
		res.writeHead(200, { "content-type": "text/event-stream" });
		const event = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
		event({ type: "message_start", message: { id: "anthropic-fixture", type: "message", role: "assistant", content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } } });
		event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: finalAnswer } });
		event({ type: "content_block_stop", index: 0 });
		event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
		event({ type: "message_stop" });
		res.end();
	});
	try {
		const config = { ...configuration(model), model: { ...configuration(model).model, fromPi: true, provider: "intranet-provider", api: "anthropic-messages", baseUrl: `${model.url}/compatible/anthropic`, apiKey: "private-native-api-key", headers: { "X-Company-Gateway": "private-gateway-token" } } };
		const result = await runQuestion(config, { arm: "baseline", question, corpus: source.corpus });
		assert.equal(result.answer, finalAnswer);
		assert.equal(requests[0].path, "/compatible/anthropic/v1/messages?beta=true");
		assert.equal(requests[0].headers["x-api-key"], "private-native-api-key");
		assert.equal(requests[0].headers["x-company-gateway"], "private-gateway-token");
		assert.equal(requests[0].headers.authorization, undefined);
		assert.ok(requests[0].headers["anthropic-version"]);
		assert.deepEqual(requests[0].body.tools.map(tool => tool.name).sort(), ["find", "grep", "ls", "read"]);
		assert.ok(!JSON.stringify(requests[0].body).includes("private-native-api-key"));
		assert.ok(!JSON.stringify(result).includes("private-gateway-token"));
		assert.ok(result.usage.totalTokens > 0);
		await runQuestion({ ...config, model: { ...config.model, headers: { Authorization: "Bearer configured-token" } } }, { arm: "baseline", question, corpus: source.corpus });
		assert.equal(requests[1].headers.authorization, "Bearer configured-token");
		assert.equal(requests[1].headers["x-api-key"], undefined);
	} finally { await model.close(); await source.close(); }
});

test("selected Pi model still refuses redirects and unsupported API protocols", async () => {
	const source = await fixture();
	let leaked = 0;
	const target = await listen((_req, res) => { leaked++; res.end("unexpected"); });
	const model = await mockModel([{ redirect: `${target.url}/leak` }]);
	try {
		const config = { ...configuration(model), model: { ...configuration(model).model, fromPi: true, provider: "selected-provider", api: "openai-completions", apiKey: "private-native-api-key" } };
		await assert.rejects(runQuestion(config, { arm: "baseline", question, corpus: source.corpus }), /Selected model failed/);
		assert.equal(leaked, 0);
		await assert.rejects(runQuestion({ ...config, model: { ...config.model, api: "unsupported-api" } }, { arm: "baseline", question, corpus: source.corpus }), /Unsupported evaluation model API/);
	} finally { await model.close(); await target.close(); await source.close(); }
});

test("selected Pi Responses model keeps its native protocol and bearer credential", async () => {
	const source = await fixture();
	let captured;
	const model = await listen(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		captured = { path: req.url, headers: req.headers, body: JSON.parse(raw) };
		res.writeHead(200, { "content-type": "text/event-stream" });
		const item = { type: "message", id: "message-fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: finalAnswer, annotations: [] }] };
		for (const event of [
			{ type: "response.created", response: { id: "response-fixture" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: finalAnswer },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "response-fixture", status: "completed", output: [item], usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } } },
		]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		res.end();
	});
	try {
		const config = { ...configuration(model), model: { ...configuration(model).model, fromPi: true, provider: "selected-provider", api: "openai-responses", apiKey: "private-responses-key" } };
		const result = await runQuestion(config, { arm: "baseline", question, corpus: source.corpus });
		assert.equal(captured.path, "/v1/responses");
		assert.equal(captured.headers.authorization, "Bearer private-responses-key");
		assert.equal(result.answer, finalAnswer);
		assert.ok(!JSON.stringify(captured.body).includes("private-responses-key"));
		assert.ok(!JSON.stringify(result).includes("private-responses-key"));
	} finally { await model.close(); await source.close(); }
});
