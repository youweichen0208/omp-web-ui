/** Native codemode/MCP under the actual Node or packaged Electron SDK, without model calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { agentRuntimeEnvironment } from '../electron/agent-runtime-env.mjs';
const [executable = process.execPath, root = process.cwd()] = process.argv.slice(2).map(p => resolve(p));
if (!process.env.PI_NATIVE_TOOLS_WORKER) {
	const directory = mkdtempSync(join(tmpdir(), 'pi-native-tools-'));
	let child;
	const http = createServer(async (request, response) => {
		if (request.method !== 'POST') { response.writeHead(405).end(); return; }
		let raw = ''; for await (const chunk of request) raw += chunk;
		const message = JSON.parse(raw);
		if (message.id === undefined) { response.writeHead(202).end(); return; }
		const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } }
			: message.method === 'tools/list' ? { tools: [{ name: 'add', description: 'Add fixture numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }] }
			: { content: [{ type: 'text', text: String(message.params.arguments.a + message.params.arguments.b) }] };
		response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
	});
	try {
		await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
		const agent = join(directory, 'agent'); mkdirSync(agent);
		const model = { id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000, maxTokens: 1024 };
		writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:19999', apiKey: 'fixture', models: [model] } } }));
		writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultTools: ['+codemode', '+tool_search'], compaction: { enabled: false }, retry: { enabled: false } }));
		writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { echo: { command: executable, args: [resolve('tests/fixtures/mcp-echo-server.mjs')], exposure: 'codemode' }, http: { url: `http://127.0.0.1:${http.address().port}/mcp`, exposure: 'codemode' } } }));
		child = fork(fileURLToPath(import.meta.url), [executable, root], { execPath: executable, execArgv: [], env: { ...agentRuntimeEnvironment(root, join(directory, 'data'), executable), HOME: directory, PI_CODING_AGENT_DIR: agent, PI_NATIVE_TOOLS_WORKER: directory, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
		const deadline = setTimeout(() => child.kill(), 60000);
		const [code, signal] = await once(child, 'exit'); clearTimeout(deadline);
		assert.equal(code, 0, `Worker failed: ${signal || code}`);
	} finally {
		if (child?.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
		rmSync(directory, { recursive: true, force: true });
		http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
	}
} else {
	const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')));
	const { createAssistantMessageEventStream } = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-ai/dist/index.js')));
	const { nativeToolExtensions } = await import(pathToFileURL(join(root, 'dist/server/native-tools.js')));
	const cwd = process.env.PI_NATIVE_TOOLS_WORKER, agentDir = process.env.PI_CODING_AGENT_DIR;
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: nativeToolExtensions() });
	await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });
	const errors = [], events = [];
	await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error) });
	assert(session.getActiveToolNames().includes('codemode'));
	assert(session.extensionRunner.getRegisteredCommands().some(command => command.invocationName === 'mcp'));
	let calls = 0;
	session.subscribe(event => events.push(event));
	session.agent.streamFunction = model => {
		const content = ++calls === 1 ? [{ type: 'toolCall', id: 'native-script', name: 'codemode', arguments: { code: 'const found = await searchTools("add"); text(found); const result = await tools.mcp__echo__add({a: 2, b: 3}); text(result); text(await tools.mcp__http__add({a: 4, b: 5}));' } }] : [{ type: 'text', text: 'Fixture completed' }];
		const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: calls === 1 ? 'toolUse' : 'stop', timestamp: Date.now() };
		const stream = createAssistantMessageEventStream(); stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); return stream;
	};
	try {
		await session.prompt('Run the local fixture.');
		const result = session.messages.find(message => message.role === 'toolResult' && message.toolName === 'codemode');
		assert(result && !result.isError, JSON.stringify(result));
		assert(result.nestedCalls?.calls.some(call => call.name === 'mcp__echo__add' && call.status === 'ok'), JSON.stringify(result));
		assert(result.nestedCalls?.calls.some(call => call.name === 'mcp__http__add' && call.status === 'ok'), JSON.stringify(result));
		assert(events.some(event => event.type === 'tool_execution_end' && event.parentToolCallId === 'native-script'));
		assert.deepEqual(errors, []);
		assert(!session.getActiveToolNames().includes('find'));
		session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== 'edit'));
		const settingsPath = join(agentDir, 'settings.json');
		const settings = JSON.parse(readFileSync(settingsPath));
		settings.defaultTools.push('+find');
		writeFileSync(settingsPath, JSON.stringify(settings));
		await session.reload();
		assert(session.getActiveToolNames().includes('find'), 'reload activates newly configured default tool');
		assert(!session.getActiveToolNames().includes('edit'), 'reload retains tools disabled during the session');
		assert(session.getActiveToolNames().includes('codemode'));
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		console.log('PASS native MCP discovery, codemode worker, nested calls and lifecycle');
	} finally { session.dispose(); }
	process.exit(0);
}
