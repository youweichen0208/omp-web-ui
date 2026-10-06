/** Pi 1.0.4 regressions: connecting MCP shutdown, poisoned built-ins, read(image).
 * Local HTTP model + stdio MCP only. Run after build; optional JSON evidence path.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import { nativeToolExtensions } from "../dist/server/native-tools.js";
import { serializeMessage } from "../dist/server/serialize.js";

const root = mkdtempSync(join(tmpdir(), "pi-104-fixes-")), agentDir = join(root, "agent");
mkdirSync(agentDir);
const evidence = { sdk: VERSION, node: process.version, platform: `${process.platform}/${process.arch}`, timestamp: new Date().toISOString(), cases: [] };
const { McpServerConnection, createDefaultTransport } = await import(pathToFileURL(join(getPackageDir(), "dist/extensions/mcp/runtime.js")));
let connection, session, childPid;
let calls = 0;
const codes = [
	'Array.prototype.toJSON = () => { throw new Error("poisoned built-in"); }; text([1,2,3]);',
	'image(await tools.read({path:"fixture.png"}));',
];
const server = createServer(async (req, res) => {
	for await (const _chunk of req) { /* drain */ }
	const index = calls++;
	const isTool = index % 2 === 0;
	const delta = isTool ? { tool_calls: [{ index: 0, id: `fix-${index / 2}`, type: "function", function: { name: "codemode", arguments: JSON.stringify({ code: codes[index / 2] }) } }] } : { content: "Fixture done" };
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: isTool ? "tool_calls" : "stop" }]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [choice] })}\n\n`);
	res.end("data: [DONE]\n\n");
});
try {
	// The child records initialize but deliberately never replies. close() must
	// finish before the configured 30-second initialize timeout and reap it.
	const fixture = join(root, "pending-mcp.mjs"), pidFile = join(root, "mcp.pid"), marker = join(root, "initialize");
	writeFileSync(fixture, 'import{writeFileSync}from"node:fs";import{createInterface}from"node:readline";writeFileSync(process.argv[2],String(process.pid));createInterface({input:process.stdin}).on("line",line=>{if(JSON.parse(line).method==="initialize")writeFileSync(process.argv[3],"received");});');
	connection = new McpServerConnection({ entry: { name: "pending", source: fixture, config: { command: process.execPath, args: [fixture, pidFile, marker], timeout: 30 } }, cwd: root, createTransport: createDefaultTransport, credentials: {}, onTools: () => {} });
	const opening = connection.getClient().then(() => { throw new Error("MCP unexpectedly connected"); }, () => undefined);
	for (let n = 0; n < 200 && !existsSync(marker); n++) await sleep(10);
	assert(existsSync(marker), "initialize reached fixture");
	childPid = Number(readFileSync(pidFile, "utf8"));
	assert.equal(connection.state, "connecting");
	const start = performance.now();
	await connection.close(); await opening;
	const elapsedMs = performance.now() - start;
	assert(elapsedMs < 5000, `shutdown waited ${elapsedMs}ms`);
	assert.equal(connection.state, "closed");
	assert.throws(() => process.kill(childPid, 0), error => error.code === "ESRCH"); childPid = undefined;
	evidence.cases.push({ id: "mcp-close-during-initialize", passed: true, shutdownMs: Math.round(elapsedMs), childReapedBeforeCloseReturned: true, boundary: "native McpServerConnection and real stdio transport; no OAuth" });

	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); assert(server.address().port >= 8900);
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "fixture", models: [{ id: "fixture", input: ["text", "image"], contextWindow: 32000, maxTokens: 100 }] } } }));
	writeFileSync(join(root, "fixture.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGOYUHDgPwgzwBgAX7QK/QPmt8EAAAAASUVORK5CYII=", "base64"));
	const settingsManager = SettingsManager.inMemory({ defaultProvider: "fixture", defaultModel: "fixture", defaultTools: ["+codemode"], retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, extensionFactories: nativeToolExtensions() }); await resourceLoader.reload();
	({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.create(root, join(agentDir, "sessions")) }));
	await session.bindExtensions({ mode: "rpc" });
	const events = []; session.subscribe(event => events.push(event));
	for (let index = 0; index < codes.length; index++) {
		const start = events.length;
		const deadline = setTimeout(() => { void session.abort(); }, 15_000);
		try { await session.prompt(`fixture-${index}`); } finally { clearTimeout(deadline); }
		const result = session.messages.find(message => message.role === "toolResult" && message.toolCallId === `fix-${index}`);
		assert(result, "tool call persisted");
		assert(events.slice(start).some(event => event.type === "tool_execution_end" && event.toolCallId === `fix-${index}`));
		assert(events.slice(start).some(event => event.type === "agent_settled"));
		assert.equal(session.isIdle, true);
		if (index === 0) evidence.cases.push({ id: "codemode-built-in-patch-settles", passed: true, toolResultError: !!result.isError, toolExecutionEnd: true, agentSettled: true });
		else {
			assert(!result.isError);
			assert(result.content.some(block => block.type === "image"));
			assert(serializeMessage(result, 0).content.some(block => block.type === "image"));
			const restored = SessionManager.open(session.sessionFile).getEntries().find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "fix-1");
			assert(restored.message.content.some(block => block.type === "image"));
			evidence.cases.push({ id: "codemode-read-image", passed: true, serializedImage: true, persistedImage: true, boundary: "SDK execution, Web serializer, original session-file readback; no browser assertion" });
		}
	}
	assert.equal(calls, 4);
	if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(evidence, null, 2) + "\n");
	console.log(JSON.stringify(evidence, null, 2));
} finally {
	await connection?.close();
	if (childPid) { try { process.kill(childPid, "SIGTERM"); } catch {} }
	session?.dispose(); server.closeAllConnections();
	if (server.listening) await new Promise(resolve => server.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
