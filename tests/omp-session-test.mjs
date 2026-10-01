import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const appRoot = process.env.OMP_TEST_APP_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
const runtime = name => import(pathToFileURL(join(appRoot, "dist/server/omp", `${name}.js`)).href);
const { AgentSession, ModelRuntime, SessionManager } = await runtime("index");
const { runOmpAdmin } = await runtime("admin");
const { encodePrompt } = await runtime("prompt-content");

const root = mkdtempSync(join(tmpdir(), "omp-session-"));
const agentDir = join(root, "agent");
// EADDRINUSE fails the test; never kill another process to claim a port.
const port = 8997;
let childRequests = 0;
let childFinishedAt = 0;
let toolCalls = 0;
let toolName = "host_probe";
const requests = [];
const api = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const request = JSON.parse(body); requests.push(request);
	const isChild = request.model === "probe-child";
	if (isChild) { childRequests++; await new Promise(resolve => setTimeout(resolve, 1500)); childFinishedAt = Date.now(); }
	const results = request.messages.filter(m => m.role === "tool");
	const toolsFinished = isChild || results.length >= (toolName === "todo" ? 3 : 1);
	const childTask = { agent: "web-probe", task: "Return CHILD_DONE", solutionSpace: "Only return the requested text" };
	const taskSchema = request.tools?.find(tool => tool.function?.name === "task")?.function?.parameters;
	const argumentsValue = toolName === "task" ? (taskSchema?.properties?.tasks ? { context: "Local integration test", tasks: [childTask] } : childTask) : toolName === "todo"
		? results.length === 0 ? { op: "init", list: [{ phase: "Implementation", items: ["Migrate engine", "Verify release"] }] }
			: { op: "done", task: results.length === 1 ? "Migrate engine" : "Verify release" }
		: { value: "expected" };
	const chunk = delta => `data: ${JSON.stringify({ id: "probe-response", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	if (toolsFinished) res.write(chunk({ role: "assistant", content: isChild ? "CHILD_DONE" : "OMP probe ready" }));
	else res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `probe-call-${results.length}`, type: "function", function: { name: toolName, arguments: JSON.stringify(argumentsValue) } }] }));
	res.write(`data: ${JSON.stringify({ id: "probe-response", object: "chat.completion.chunk", model: "probe", choices: [{ index: 0, delta: {}, finish_reason: toolsFinished ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
	res.end("data: [DONE]\n\n");
});
let session;
const deadline = setTimeout(() => { console.error("OMP integration exceeded 90 seconds"); void session?.dispose(); api.closeAllConnections(); }, 90_000);
try {
	await new Promise((resolve, reject) => { api.once("error", reject); api.listen(port, "127.0.0.1", resolve); });
	await runOmpAdmin("models_write", { providers: { probe: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "test-custom-secret", models: [{ id: "probe", name: "Probe", contextWindow: 262144, maxTokens: 1024 }, { id: "probe-child", name: "Probe child", contextWindow: 262144, maxTokens: 1024 }] } } }, { agentDir, cwd: root });
	await runOmpAdmin("credential_set", { provider: "anthropic", key: "test-only-secret" }, { agentDir, cwd: root });
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents", "web-probe.md"), "---\nname: web-probe\ndescription: Local integration probe\nmodel: probe/probe-child\n---\nReturn the requested text without tools.\n");
	const models = await ModelRuntime.create({ agentDir });
	assert.ok(models.getAvailableSnapshot().some(m => m.provider === "probe"));
	assert.equal(models.getProviderAuthStatus("anthropic").source, "stored");
	const tool = { name: "host_probe", label: "Probe", description: "Return the probe value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, execute: async (_id, args) => { assert.equal(args.value, "expected"); toolCalls++; return { content: [{ type: "text", text: "probe tool result" }] }; } };
	session = await AgentSession.create({ cwd: root, agentDir, modelRuntime: models, model: models.getModel("probe", "probe"), customTools: [tool], restricted: true });
	const states = [];
	session.subscribe(event => states.push(event.type));
	const prompt = encodePrompt("Use host_probe, then reply", [{ message: { customType: "file-attachment", display: true, content: "File evidence", details: { path: "evidence.txt" } } }]);
	await session.promptAndWait(prompt.message);
	for (let i = 0; i < 100 && !states.includes("session_settled"); i++) await new Promise(resolve => setTimeout(resolve, 10));
	console.log("PASS restricted tools and settlement");
	assert.equal(toolCalls, 1, JSON.stringify({ states, requests: requests.map(r => ({ roles: r.messages.map(m => m.role), tools: r.tools?.map(t => t.function?.name) })), messages: session.messages }));
	assert.equal(session.getLastAssistantText(), "OMP probe ready");
	assert.ok(session.messages.some(m => m.role === "custom" && m.customType === "file-attachment"));
	assert.ok(session.messages.some(m => m.role === "user" && m.content === "Use host_probe, then reply"));
	assert.ok(states.includes("tool_execution_end"));
	assert.ok(states.includes("session_settled"));
	assert.equal(session.isStreaming, false);
	assert.equal(session.messages.filter(m => m.role === "assistant").length, 2);
	await session.sessionManager.appendSessionInfo("OMP integration");
	const path = session.sessionFile;
	assert.ok(path);
	await session.dispose(); session = undefined;
	const history = await SessionManager.open(path, { agentDir });
	assert.equal(history.getSessionName(), "OMP integration");
	session = await AgentSession.create({ cwd: root, agentDir, modelRuntime: models, sessionManager: history, restricted: true, customTools: [tool] });
	assert.equal(session.getLastAssistantText(), "OMP probe ready");
	await session.dispose(); session = undefined;
	// The normal session uses official host registration and OMP's own toolset.
	session = await AgentSession.create({ cwd: root, agentDir, modelRuntime: models, model: models.getModel("probe", "probe"), customTools: [tool] });
	if (process.env.OMP_TEST_DEBUG) session.subscribe(event => { if (event.type !== "message_update") console.log("OMP event:", event.type); });
	await session.promptAndWait("Use host_probe");
	console.log("PASS standard host registration");
	assert.equal(toolCalls, 2);
	await session.newSession();
	toolName = "todo";
	await session.promptAndWait("Create the implementation checklist with todo");
	console.log("PASS native todo lifecycle");
	const todo = session.messages.find(m => m.role === "toolResult" && m.toolName === "todo");
	assert.ok(todo && !todo.isError, JSON.stringify(todo));
	assert.equal(todo.details.phases[0].name, "Implementation");
	assert.equal(todo.details.phases[0].tasks.length, 2);
	await session.newSession();
	toolName = "task";
	let yieldedWhileChildRunning = false;
	const unsub = session.subscribe(event => {
		if (event.type === "agent_end" && !childFinishedAt && session.isStreaming) yieldedWhileChildRunning = true;
	});
	await session.promptAndWait("Delegate to web-probe using task, then finish");
	unsub();
	assert.ok(childRequests > 0, JSON.stringify(session.messages));
	assert.ok(childFinishedAt > 0 && childFinishedAt <= Date.now());
	assert.ok(yieldedWhileChildRunning, "parent agent_end must not prematurely settle the async child");
	assert.equal(session.isStreaming, false);
	assert.ok([...session.subagents.values()].some(agent => agent.agent === "web-probe"));
	assert.ok([...session.subagents.values()].every(agent => agent.status !== "running"));
	console.log("PASS native async subagent lifecycle and final settlement");
	await session.newSession();
	toolName = "host_wait";
	let signalWasAborted = false;
	let started;
	const hostStarted = new Promise(resolve => { started = resolve; });
	await session.updateHostTools([{ ...tool, name: "host_wait", execute: async (_id, _args, signal) => {
		started();
		await new Promise((resolve, reject) => {
			const abort = () => { signalWasAborted = true; reject(new Error("cancelled by user")); };
			if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
		});
		return { content: [] };
	} }]);
	const pending = session.promptAndWait("Call host_wait and wait");
	await hostStarted;
	await session.abort();
	await pending;
	assert.ok(signalWasAborted, "native abort must cancel the host tool callback");
	assert.equal(session.isStreaming, false);
	console.log("PASS cancellation reaches pending host tools and settles");
	await runOmpAdmin("credential_clear", { provider: "anthropic" }, { agentDir, cwd: root });
	await models.refresh();
	assert.notEqual(models.getProviderAuthStatus("anthropic").source, "stored");
	console.log("OMP session: model config, SQLite credentials, host tool execution, atomic attachments, title and history passed");
} finally {
	clearTimeout(deadline);
	await session?.dispose();
	await new Promise(resolve => api.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
