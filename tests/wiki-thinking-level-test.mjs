// Wiki chats keep the thinking level chosen in the main chat. Always-thinking
// models (Volc GLM) reject the default "off" with a 400.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
const port = 8984, mockPort = 9084, base = mkdtempSync(join(tmpdir(), 'wiki-thinking-'));
const cwd = join(base, 'workspace');
mkdirSync(cwd);
writeFileSync(join(cwd, 'note.md'), '# Note\n\nhello\n');
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'agent', 'models.json'), JSON.stringify({ providers: { volc: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: 'test-only', models: [{ id: 'glm', name: 'GLM test', reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'volc', defaultModel: 'glm', defaultThinkingLevel: 'off' }));
writeFileSync(join(base, 'agent', 'auth.json'), JSON.stringify({ volc: { type: 'api_key', key: 'test-only' } }));
const thinking = [];
const mock = createServer(async (req, res) => {
	let body = '';
	for await (const chunk of req) body += chunk;
	const request = JSON.parse(body || '{}');
	thinking.push(request.thinking?.type ?? 'missing');
	if (request.thinking?.type !== 'enabled' && request.thinking?.type !== 'adaptive') {
		res.writeHead(400, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking cannot be disabled for this model' } }));
		return;
	}
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	event('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'glm', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
	event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
	event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello.' } });
	event('content_block_stop', { index: 0 });
	event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
	event('message_stop', {});
	res.end();
});
let server, browser;
try {
	assert.equal(await portUp(port), false);
	assert.equal(await portUp(mockPort), false);
	await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	await page.goto(`http://127.0.0.1:${port}`);
	// Pick the level once the session state has arrived, as a user would.
	await page.locator('.thinking-control .chip').waitFor();
	await page.locator('.file-name', { hasText: 'note.md' }).waitFor();
	for (let attempt = 0; attempt < 3 && !await page.locator('.thinking-control .chip', { hasText: '标准' }).count(); attempt++) {
		await page.locator('.thinking-control .chip').click();
		await page.locator('.dd-menu-thinking .dd-item', { hasText: '标准' }).click();
		await page.locator('.thinking-control .chip', { hasText: '标准' }).waitFor({ timeout: 3000 }).catch(() => {});
	}
	await page.locator('.thinking-control .chip', { hasText: '标准' }).waitFor({ timeout: 1000 });
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	await page.locator('.wiki-prose .fp-rich-document').waitFor();
	await page.getByRole('textbox', { name: '问 pi', exact: true }).fill('可以帮我读一下吗');
	await page.getByRole('button', { name: '发送', exact: true }).click();
	await page.locator('.wiki-chat-answer', { hasText: 'Hello.' }).waitFor({ timeout: 15000 });
	assert.deepEqual(thinking, ['enabled'], 'the Wiki request keeps thinking enabled');
	console.log('PASS Wiki chat keeps the main chat thinking level');
} finally {
	await browser?.close();
	await new Promise(r => mock.close(r));
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(base, { recursive: true, force: true });
}
