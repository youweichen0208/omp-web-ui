/** Native 1.0.4 runtime getter versus WebUI sections in Codemode on/only. Local model only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, SettingsManager, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { promptView } from '../dist/server/system-prompt-view.js';
import { nativeToolExtensions } from '../dist/server/native-tools.js';
const root = mkdtempSync(join(tmpdir(), 'pi-104-prompt-')), agentDir = join(root, 'agent');
mkdirSync(join(agentDir, 'skills/fixture'), { recursive: true });
writeFileSync(join(agentDir, 'skills/fixture/SKILL.md'), '---\nname: fixture\ndescription: Native hidden-reader fixture\n---\nRead fixture instructions.');
let session, expectedMode, failure, calls = 0;
const server = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	try {
		const request = JSON.parse(raw), view = promptView(session, root);
		assert.equal(view.opaque, false);
		assert.equal(view.raw, session.systemPrompt);
		assert.equal(request.messages.find(m => m.role === 'system').content, view.raw);
		const skills = view.sections.find(s => s.name === 'skills').text;
		assert(skills.includes('Native hidden-reader fixture'));
		assert.equal(skills.includes('Use the read tool'), expectedMode === 'on');
		const tools = view.sections.find(s => s.name === 'tools').text;
		assert.equal(/^- bash:/m.test(tools), expectedMode === 'on');
		assert.equal(view.rules.some(rule => rule.text === 'Use bash for file operations like ls, rg, find'), expectedMode === 'on');
		if (expectedMode === 'only') assert.deepEqual(request.tools.map(t => t.function.name), ['codemode']);
		else assert(request.tools.some(t => t.function.name === 'read'));
		calls++;
	} catch (error) { failure = error; }
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const choice of [{ index: 0, delta: { content: 'fixture' }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [choice] })}\n\n`);
	res.end('data: [DONE]\n\n');
});
try {
	await new Promise(r => server.listen(0, '127.0.0.1', r)); assert(server.address().port >= 8900);
	writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 100 }] } } }));
	for (expectedMode of ['on', 'only', 'on']) {
		const settingsManager = SettingsManager.inMemory({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultTools: ['+codemode'], codemode: { mode: expectedMode }, retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, extensionFactories: nativeToolExtensions() }); await resourceLoader.reload();
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) }));
		await session.bindExtensions({ mode: 'rpc' });
		try { await session.prompt('Check native visibility'); if (failure) throw failure; } finally { session.dispose(); session = undefined; }
	}
	assert.equal(calls, 3);
	console.log('PASS pi 1.0.4 Codemode on/only/on: native getter, model input, rule visibility and skills');
} finally { session?.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); }
