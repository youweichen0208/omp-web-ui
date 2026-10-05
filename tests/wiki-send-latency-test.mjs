// Real browser + SDK + local provider: send latency including fresh undo snapshots.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
const port = 8999, base = mkdtempSync(join(tmpdir(), 'wiki-send-latency-'));
const cwd = join(base, 'workspace');
mkdirSync(cwd);
mkdirSync(join(cwd, 'docs'));
for (let i = 0; i < 500; i++) writeFileSync(join(cwd, 'docs', `${i}.md`), ('# Sample\n\ntext [[note]] and [link](../note.md)\n\n').repeat(40));
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
let server, browser;
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
	for (const dirty of [false, true]) {
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
	console.log('PASS hello reaches native prompt promptly with a 500-file project, including save-before-send');

} finally {
	await browser?.close();
	await new Promise(r => mock.close(r));
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(base, { recursive: true, force: true });
}
