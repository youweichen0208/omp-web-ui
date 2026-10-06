/** Three serial native MCP/Codemode resource samples, independent of paid models. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
const output = resolve(process.argv[2] ?? 'docs/review-data/native-tools'); mkdirSync(output, { recursive: true });
if (!process.env.PI_RESOURCE_TOOLS_WORKER) {
	for (let round = 1; round <= 3; round++) {
		const root = mkdtempSync(join(tmpdir(), 'pi-tools-resource-')), directory = join(output, `round-${round}`); mkdirSync(directory, { recursive: true });
		const child = spawn(process.execPath, [fileURLToPath(import.meta.url), output], { env: { ...process.env, PI_RESOURCE_TOOLS_WORKER: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_RESOURCE_PROBE: directory, NODE_OPTIONS: `--import=${pathToFileURL(resolve('tests/fixtures/resource-probe.mjs'))}` }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
		child.on('message', message => appendFileSync(join(output, 'events.jsonl'), JSON.stringify({ round, ...message }) + '\n'));
		try { const [code] = await once(child, 'exit'); assert.equal(code, 0); } finally { if (child.exitCode === null) child.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); }
	}
} else {
	const root = process.env.PI_RESOURCE_TOOLS_WORKER, agentDir = process.env.PI_CODING_AGENT_DIR;
	mkdirSync(agentDir);
	const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } = await import('@earendil-works/pi-coding-agent');
	const { nativeToolExtensions } = await import('../dist/server/native-tools.js');
	const stage = async (phase, action) => {
		process.send({ phase, state: 'start', time: Date.now() }); await action?.(); await sleep(2100);
		writeFileSync(join(process.env.PI_RESOURCE_PROBE, `gc-${process.pid}`), ''); await sleep(1100);
		process.send({ phase, state: 'end', time: Date.now() });
	};
	let session, call = 0;
	const model = createServer(async (req, res) => {
		for await (const chunk of req) {}
		const first = call++ === 0;
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const delta = first ? { tool_calls: [{ index: 0, id: 'resource-tool', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code: 'await searchTools("add"); text(await tools.mcp__echo__add({a:2,b:3}));' }) } }] } : { content: 'done' };
		for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [choice] })}\n\n`);
		res.end('data: [DONE]\n\n');
	});
	await new Promise(r => model.listen(0, '127.0.0.1', r)); assert(model.address().port >= 8900);
	writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${model.address().port}`, apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 100 }] } } }));
	try {
		await stage('sdk-import');
		await stage('native-tools-loaded', async () => {
			writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [resolve('tests/fixtures/mcp-echo-server.mjs')], exposure: 'codemode' } } }));
			const settingsManager = SettingsManager.inMemory({ defaultProvider: 'fixture', defaultModel: 'fixture', retry: { enabled: false }, defaultTools: ['+codemode', '+tool_search'] });
			const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, extensionFactories: nativeToolExtensions() }); await resourceLoader.reload();
			({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) }));
			await session.bindExtensions({ mode: 'rpc' });
			await session.extensionRunner.getCommand('mcp').handler('', session.extensionRunner.createCommandContext());
		});
		await stage('codemode-mcp-execute', async () => {
			await session.prompt('Run the local MCP fixture.');
			const result = session.messages.find(message => message.role === 'toolResult' && message.toolName === 'codemode');
			assert(result);
			assert(!result.isError, JSON.stringify(result)); assert(JSON.stringify(result).includes('5'));
		});
		await stage('disposed', async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); session = undefined; });
	} finally { model.closeAllConnections(); await new Promise(r => model.close(r)); if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); } }
	process.disconnect();
}
