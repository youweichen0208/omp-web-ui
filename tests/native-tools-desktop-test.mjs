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
const codeFixture = 'const found = await searchTools("add"); text(found); const result = await tools.mcp__echo__add({a: 2, b: 3}); text(result); text(await tools.mcp__http__add({a: 4, b: 5})); const painter = await models.getModelOfType("image", "image-fixture", "fixture"); const generated = await models.generateImages(painter, {input:[{type:"text",text:"Fixture image"}]}); for(const block of generated.output) if(block.type === "image") image(block);';
const [executable = process.execPath, root = process.cwd()] = process.argv.slice(2).map(p => resolve(p));
if (!process.env.PI_NATIVE_TOOLS_WORKER) {
	const directory = mkdtempSync(join(tmpdir(), 'pi-native-tools-'));
	let child, modelCalls = 0;
	const http = createServer(async (request, response) => {
		if (request.method !== 'POST') { response.writeHead(405).end(); return; }
		let raw = ''; for await (const chunk of request) raw += chunk;
		const message = JSON.parse(raw);
		if (request.url === "/v1/chat/completions") {
			const call = ++modelCalls;
			const delta = call === 1 ? {tool_calls:[{index:0,id:"native-script",type:"function",function:{name:"codemode",arguments:JSON.stringify({code:codeFixture})}}]} : call === 2 ? {tool_calls:[{index:0,id:"discover-deferred",type:"function",function:{name:"tool_search",arguments:JSON.stringify({query:"add"})}}]} : {content:"Fixture completed"};
			response.writeHead(200,{"content-type":"text/event-stream"});
			for (const choice of [{index:0,delta,finish_reason:null},{index:0,delta:{},finish_reason:call <= 2 ? "tool_calls" : "stop"}]) response.write(`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",model:"fixture",choices:[choice]})}\n\n`);
			response.end("data: [DONE]\n\n"); return;
		}
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
		writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${http.address().port}/v1`, apiKey: 'fixture', models: [model] } } }));
		writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultTools: ['+codemode', '+tool_search'], compaction: { enabled: false }, retry: { enabled: false } }));
		writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { echo: { command: executable, args: [resolve('tests/fixtures/mcp-echo-server.mjs')], exposure: 'deferred' }, http: { url: `http://127.0.0.1:${http.address().port}/mcp`, exposure: 'codemode' } } }));
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
	const { expandNativeTemplate } = await import(pathToFileURL(join(root, 'dist/server/native-prompt-template.js')));
	for (const separator of [' ', '\n', '\t', '\r\n']) assert.equal(await expandNativeTemplate(`/fixture${separator}"one two" three`, [{ name: 'fixture', content: '$1 / $2', description: '', filePath: '', sourceInfo: {} }]), 'one two / three');
	const { nativeToolExtensions } = await import(pathToFileURL(join(root, 'dist/server/native-tools.js')));
	assert.match(readFileSync(join(root, 'node_modules/@earendil-works/pi-coding-agent/docs/codemode.md'), 'utf8'), /generateImages/);
	const cwd = process.env.PI_NATIVE_TOOLS_WORKER, agentDir = process.env.PI_CODING_AGENT_DIR;
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: nativeToolExtensions() });
	await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.create(cwd, join(agentDir,"sessions")) });
	const errors = [], events = [];
	await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error) });
	assert(session.getActiveToolNames().includes('codemode'));
	assert(session.extensionRunner.getRegisteredCommands().some(command => command.invocationName === 'mcp'));
	const imageModel = {type:"image",id:"fixture",name:"Fixture",provider:"image-fixture",api:"fixture-images",baseUrl:"http://127.0.0.1",input:["text"],output:["image"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
	session.modelRuntime.registerNativeProvider({id:"image-fixture",name:"Image fixture",auth:{apiKey:{name:"Fixture",resolve:async()=>({auth:{apiKey:"FIXTURE_IMAGE_SECRET"},source:"fixture"})}},getModels:()=>[],getAllModels:()=>[imageModel],generateImages:async(_model,_context,options)=>{assert.equal(options.apiKey,"FIXTURE_IMAGE_SECRET");return {api:imageModel.api,provider:imageModel.provider,model:imageModel.id,stopReason:"stop",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0.01,cacheRead:0,cacheWrite:0,total:0.01}},output:[{type:"image",mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII="}],timestamp:Date.now()};}});
	session.subscribe(event => events.push(event));
	try {
		await session.prompt('Run the local fixture.');
		const result = session.messages.find(message => message.role === 'toolResult' && message.toolName === 'codemode');
		assert(result && !result.isError, JSON.stringify(result));
		assert(result.content.some(block => block.type === "image"), "codemode generation returns an image block");
		const { serializeMessage } = await import(pathToFileURL(join(root, 'dist/server/serialize.js')));
		const card = serializeMessage(result, 0);
		assert(card.codemode.calls.some(call => call.name === 'models.generateImages' && call.status === 'ok' && call.cost === 0.01), JSON.stringify(card.codemode));
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
		await session.extensionRunner.getCommand("mcp").handler("", session.extensionRunner.createCommandContext());
		assert(session.getActiveToolNames().includes('find'), 'reload activates newly configured default tool');
		assert(!session.getActiveToolNames().includes('edit'), 'reload retains tools disabled during the session');
		assert(session.getActiveToolNames().includes('codemode'));
		assert(session.getActiveToolNames().includes('mcp__echo__add'), 'reload restores discovered deferred MCP tools');
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const saved = session.sessionFile; assert(saved);
		const resumedLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: nativeToolExtensions() }); await resumedLoader.reload();
		const { session: resumed } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: resumedLoader, sessionManager: SessionManager.open(saved) });
		try {
			await resumed.bindExtensions({mode:"rpc"});
			await resumed.extensionRunner.getCommand("mcp").handler("", resumed.extensionRunner.createCommandContext());
			// Original Pi 1.0.4 resumes with its configured active loadout. Discovery remains native.
			const search = resumed.getToolDefinition("tool_search");
			assert(search, "native discovery remains available on resume");
			await search.execute("resume-search", { query: "add" });
			assert(resumed.getActiveToolNames().includes("mcp__echo__add"), "native discovery loads MCP tools after resume");
		} finally { resumed.dispose(); }
		console.log('PASS native MCP discovery, codemode worker, nested calls and deferred reload/resume');
	} finally { session.dispose(); }
	process.exit(0);
}
