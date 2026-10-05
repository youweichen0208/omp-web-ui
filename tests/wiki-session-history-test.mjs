// Wiki uses native in-memory sessions; ordinary chat still persists project history.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
const port = 8999, base = mkdtempSync(join(tmpdir(), 'wiki-send-latency-'));
const cwd = join(base, 'workspace');
mkdirSync(cwd);
mkdirSync(join(cwd, 'docs'));
for (let i = 0; i < 3; i++) writeFileSync(join(cwd, 'docs', `${i}.md`), ('# Sample\n\ntext [[note]] and [link](../note.md)\n\n').repeat(40));
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'agent', 'models.json'), JSON.stringify({ providers: { local: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9000', apiKey: 'test-only', models: [{ id: 'local', name: 'Local test', input: ['text'], contextWindow: 32000, maxTokens: 1024 }] } } }));
writeFileSync(join(base, 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'local', defaultModel: 'local' }));
writeFileSync(join(base, 'agent', 'auth.json'), JSON.stringify({ local: { type: 'api_key', key: 'test-only' } }));
const received = [];
const mock = createServer(async (req, res) => {
	for await (const chunk of req) {}
	received.push({ at: Date.now(), disk: readFileSync(join(cwd, 'note.md'), 'utf8') });
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	await new Promise(r => setTimeout(r, 1500));
	res.end('data: ' + JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
});
writeFileSync(join(cwd, 'note.md'), '# Code\n\n```java\npublic class Original {}\n```\n\nInsert here.\n');
let server, browser, socket;
try {
	assert.equal(await portUp(port), false);
	assert.equal(await portUp(9000), false);
	await new Promise(r => mock.listen(9000, '127.0.0.1', r));
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	const indexed = page.waitForResponse(r => r.url().endsWith('/api/wiki') && r.request().postDataJSON()?.action === 'state' && r.ok());
	void indexed.catch(() => {});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	const editor = page.locator('.wiki-prose .fp-rich-document');
	await editor.locator('code .hljs-keyword').first().waitFor();
	await indexed;
	for (const dirty of [false]) {
		const send = page.getByRole('button', { name: '发送', exact: true });
		if (dirty) {
			await page.locator('.wiki-toolbar-actions').getByRole('button', { name: '编辑源码', exact: true }).click();
			await page.locator('.fp-editor').fill('# Edited before hello\n');
		}
		await page.getByRole('textbox', { name: '问 pi', exact: true }).fill('hello');
		await send.waitFor();
		const start = Date.now();
		const accepted = page.waitForResponse(r => r.url().endsWith('/api/wiki') && r.request().postDataJSON()?.action === 'prompt');
		await send.click();
		assert.equal((await accepted).status(), 200);
		const elapsed = Date.now() - start;
		console.log(JSON.stringify({ dirty, acceptedMs: elapsed }));
		assert(elapsed < 1000, `hello acceptance took ${elapsed} ms`);
		for (let i = 0; i < 100 && received.length < (dirty ? 2 : 1); i++) await new Promise(r => setTimeout(r, 50));
		assert.equal(received.length, dirty ? 2 : 1);
		if (dirty) assert.equal(received.at(-1).disk, '# Edited before hello\n');
		await page.locator('.wiki-chat-answer', { hasText: 'Hello.' }).nth(dirty ? 1 : 0).waitFor();
		await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'detached' });
		await new Promise(r => setTimeout(r, 1000));
	}
	const clientId = await page.evaluate(() => sessionStorage.getItem('pi-web-client-id'));
	const messages = [];
	socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	socket.on('message', wire => messages.push(JSON.parse(String(wire))));
	await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
	const send = message => socket.send(JSON.stringify(message));
	const wait = async predicate => {
		for (let i = 0; i < 200; i++) { const found = messages.find(predicate); if (found) return found; await new Promise(r => setTimeout(r, 25)); }
		throw new Error('Expected protocol event did not arrive: ' + messages.map(m => m.type).join(','));
	};
	send({ type: 'hello', clientId });
	send({ type: 'get_state' });
	const wiki = (await wait(m => m.type === 'snapshot')).state;
	assert(!wiki.sessionFile, 'Wiki session must not have a transcript file');
	assert.equal(readdirSync(base, { recursive: true }).filter(name => String(name).endsWith('.jsonl')).length, 0, 'Wiki messages must not create transcripts anywhere in the isolated data or agent directories');
	messages.length = 0; send({ type: 'list_sessions' });
	const history = await wait(m => m.type === 'sessions');
	assert.equal(history.sessions.length, 0, 'Wiki transcript must not enter project history');
	messages.length = 0; send({ type: 'prompt', requestId: 'wiki-new', text: '/new' });
	const reset = (await wait(m => m.type === 'snapshot' && m.state.sessionId !== wiki.sessionId)).state;
	assert(!reset.sessionFile, '/new in Wiki must remain in memory');
	assert.equal(reset.messages.length, 0);

	await page.getByRole('tab', { name: '对话', exact: true }).click();
	const ordinary = (await wait(m => m.type === 'snapshot' && m.state.conversationId !== wiki.conversationId)).state;
	assert(!ordinary.sessionFile?.startsWith(join(base, 'data', 'wiki')));
	assert.equal(ordinary.messages.length, 0, 'return to chat must not reuse Wiki context');
	messages.length = 0;
	send({ type: 'switch_conversation', id: wiki.conversationId });
	send({ type: 'get_state' });
	assert.equal((await wait(m => m.type === 'snapshot')).state.conversationId, ordinary.conversationId, 'the departed idle Wiki runtime must be released');

	messages.length = 0;
	send({ type: 'prompt', requestId: 'ordinary-prompt', text: 'ordinary-chat-history' });
	await wait(m => m.type === 'prompt_result' && m.requestId === 'ordinary-prompt');
	for (let i = 0; i < 100; i++) {
		messages.length = 0; send({ type: 'get_state' });
		const state = (await wait(m => m.type === 'snapshot')).state;
		if (!state.isStreaming && readFileSync(state.sessionFile, 'utf8').includes('Hello.')) break;
		await new Promise(r => setTimeout(r, 100));
	}
	messages.length = 0; send({ type: 'list_sessions' });
	const normalHistory = await wait(m => m.type === 'sessions' && m.sessions.some(s => s.firstMessage.includes('ordinary-chat-history')));
	assert(normalHistory.sessions.some(s => s.firstMessage.includes('ordinary-chat-history')), 'ordinary chat must still persist in project history');
	assert(!normalHistory.sessions.some(s => s.path === wiki.sessionFile));
	const conversations = messages.filter(m => m.type === 'conversations').at(-1);
	if (conversations) assert(!conversations.conversations.some(c => c.id === wiki.conversationId));
	console.log('PASS temporary Wiki messages stay off disk and ordinary chat history persists');

} finally {
	socket?.terminate();
	await browser?.close();
	await new Promise(r => mock.close(r));
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(base, { recursive: true, force: true });
}
