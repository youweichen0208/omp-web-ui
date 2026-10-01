/** Real foreground/background subagents, isolated local model and desktop runtime. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { agentRuntimeEnvironment } from '../electron/agent-runtime-env.mjs';
import { portUp } from './lib/port-utils.mjs';

const [executable = process.execPath, appRoot = process.cwd()] = process.argv.slice(2).map(p => resolve(p));
const extension = resolve('node_modules/pi-subagents/index.js');
if (process.env.PI_SUBAGENT_DESKTOP_TEST_WORKER) {
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(pathToFileURL(join(appRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
	const { createAssistantMessageEventStream } = await import(pathToFileURL(join(appRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
	const cwd = process.env.PI_WEB_CWD, agentDir = process.env.PI_CODING_AGENT_DIR;
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [extension] });
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, [], 'extension must load without errors');
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.create(cwd, join(agentDir, 'sessions')) });
	const errors = [];
	await session.bindExtensions({ onError: e => errors.push(e) });
	assert(session.getActiveToolNames().includes('subagent'), 'eager activation must expose the native tool');
	try {
		for (const background of [false, true]) {
			let calls = 0;
			const results = [];
			const unsubscribe = session.subscribe(e => { if (e.type === 'tool_execution_end') results.push(e); });
			session.agent.streamFunction = (model) => {
				const n = ++calls;
				assert(n <= 4, 'child completion must not cause an unbounded parent loop');
				let content = [{ type: 'text', text: 'PARENT_DONE' }];
				if (n === 1) content = [{ type: 'toolCall', id: `child-${background}`, name: 'subagent', arguments: { agent: 'desktop-probe', task: 'Return SUBAGENT_DESKTOP_OK. This is a read-only fixture.', model: 'desktop-probe/child', agentScope: 'user', context: 'fresh', async: background, timeoutMs: 30000, share: false, skill: false } }];
				else if (background && n === 2) content = [{ type: 'toolCall', id: 'wait-child', name: 'bg_wait', arguments: { all: true, timeoutMs: 30000 } }];
				const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now() };
				const stream = createAssistantMessageEventStream();
				stream.push({ type: 'start', partial: message });
				stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
				return stream;
			};
			await session.prompt('I authorize this test to delegate the read-only fixture to desktop-probe.');
			unsubscribe();
			assert(results.some(e => e.toolName === 'subagent'));
			for (const result of results) assert.equal(result.isError, false, JSON.stringify(result.result));
			assert(JSON.stringify(session.messages).includes('SUBAGENT_DESKTOP_OK'), 'actual child response must reach the parent transcript');
			assert.deepEqual(errors, [], 'native extension lifecycle must succeed');
			console.log(`PASS ${background ? 'background' : 'foreground'} subagent with host SDK and ${process.versions.electron ? 'Electron' : 'Node'} runtime`);
		}
	} finally { session.dispose(); }
	process.exit(0);
}
else {
	const port = Number(process.env.PI_SUBAGENT_TEST_PORT || 9181);
	assert(port >= 8900 && port < 65535);
	assert.equal(await portUp(port), false, `Port ${port} occupied; refusing to touch its owner`);
	const root = mkdtempSync(join(tmpdir(), 'pi-desktop-subagents-'));
	const agentDir = join(root, 'agent'), cwd = join(root, 'workspace');
	for (const dir of [agentDir, cwd, join(root, 'home'), join(agentDir, 'agents'), join(agentDir, 'extensions/subagent')]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'desktop-probe', defaultModel: 'child', compaction: { enabled: false }, retry: { enabled: false } }));
	writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'desktop-probe': { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'isolated-fixture', models: [{ id: 'child', name: 'Desktop child fixture', input: ['text'], contextWindow: 32000, maxTokens: 1024 }] } } }));
	writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ 'desktop-probe': { type: 'api_key', key: 'isolated-fixture' } }));
	writeFileSync(join(agentDir, 'extensions/subagent/config.json'), JSON.stringify({ toolActivation: 'eager', asyncByDefault: true }));
	writeFileSync(join(agentDir, 'agents/desktop-probe.md'), '---\nname: desktop-probe\ndescription: Isolated read-only desktop fixture\nmodel: desktop-probe/child\ntools: read\n---\nReturn SUBAGENT_DESKTOP_OK. Do not call tools.\n');
	let requests = 0, child;
	const mock = createServer(async (req, res) => {
		let body = ''; for await (const chunk of req) body += chunk;
		const payload = JSON.parse(body); requests++;
		assert.equal(payload.model, 'child');
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		for (const choice of [{ index: 0, delta: { content: 'SUBAGENT_DESKTOP_OK' }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'child-fixture', object: 'chat.completion.chunk', created: 1, model: 'child', choices: [choice] })}\n\n`);
		res.end('data: [DONE]\n\n');
	});
	try {
		await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(port, '127.0.0.1', resolve); });
		child = fork(fileURLToPath(import.meta.url), [executable, appRoot], { execPath: executable, execArgv: [], env: { ...agentRuntimeEnvironment(appRoot, join(root, 'data'), executable), HOME: join(root, 'home'), PI_CODING_AGENT_DIR: agentDir, PI_WEB_CWD: cwd, PI_SUBAGENT_DESKTOP_TEST_WORKER: '1', NODE_OPTIONS: '', NODE_PATH: '' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
		const deadline = setTimeout(() => child.kill('SIGTERM'), 90000);
		const [code, signal] = await once(child, 'exit'); clearTimeout(deadline);
		assert.equal(code, 0, `Worker failed: ${signal || code}`);
		assert.equal(requests, 2, 'both foreground and background children must call the isolated model');
	} finally {
		if (child?.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
		mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
		rmSync(root, { recursive: true, force: true });
	}
}
