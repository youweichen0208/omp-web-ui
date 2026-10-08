/**
 * Browser check of the stopped state: the reply ends with a tool call written as
 * text, the server asks the model to re-issue it, the model again ends without a
 * tool call. The page must show why it stopped and offer a working resend; the
 * notice about the automatic request must not linger over the composer.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8979;
const root = mkdtempSync(join(tmpdir(), 'pi-recovery-ui-'));
const cwd = join(root, 'ws'); mkdirSync(cwd);
// 1: tool call written as text; 2: after the automatic request, only an announcement;
// 3 (manual resend): a real tool call; 4: the final answer.
const replies = [{ text: '先验证改动。</think>\n<parameter name="command">echo hi</parameter>\n</invoke>' }, { text: '你说得对。让我通过真正的工具调用创建验证脚本文件。' }, { tool: 'echo RESENT_OK' }, { text: '验证完成。' }];
let calls = 0;
const model = createServer(async (req, res) => {
	for await (const _ of req) { /* drain */ }
	const reply = replies[Math.min(calls++, replies.length - 1)];
	const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	if (reply.tool) res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: reply.tool }) } }] }, null));
	else res.write(chunk({ role: 'assistant', content: reply.text }, null));
	res.write(chunk({}, reply.tool ? 'tool_calls' : 'stop'));
	res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
	res.end('data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const agent = join(root, 'agent'); mkdirSync(agent);
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'x', models: [{ id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 64000, maxTokens: 1024 }] } } }));
writeFileSync(join(agent, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'x' } })); // no first-run setup modal
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', compaction: { enabled: false }, retry: { enabled: false } }));
const server = spawn(process.execPath, [join(REPO, 'dist', 'server', 'index.js')], {
	env: { ...process.env, PORT: String(PORT), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: agent, HOME: root },
	stdio: 'ignore', windowsHide: true,
});
let browser;
try {
	for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {} await sleep(100); }
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined, args: ['--no-sandbox'] });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await page.goto(`http://127.0.0.1:${PORT}/`);
	const input = page.locator('textarea').first();
	await input.waitFor({ timeout: 20000 });
	await input.fill('验证一下改动'); await page.keyboard.press('Enter');

	const card = page.locator('.unexecuted-tool', { hasText: '模型没有执行工具就结束了' });
	await card.waitFor({ timeout: 20000 });
	assert.equal(calls, 2, 'one automatic request, then the run stops');
	// The earlier reply keeps its read-only "parsing failed" card; only the latest turn has actions.
	assert.equal(await page.locator('.unexecuted-tool .tool-recovery-actions').count(), 1, 'only the latest turn offers recovery');
	const resend = card.getByRole('button', { name: '重新发送' });
	for (let i = 0; i < 100 && !(await resend.isEnabled()); i++) await sleep(100);
	assert(await resend.isEnabled(), 'resend becomes available once the run has settled');

	// The informational notice about the automatic request goes away on its own.
	const notice = page.locator('.notice', { hasText: '已自动请它重新调用' });
	for (let i = 0; i < 60 && await notice.count(); i++) await sleep(100);
	assert.equal(await notice.count(), 0, 'the automatic-request notice dismisses itself');

	if (process.env.SHOT) { await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.SHOT }); }
	await card.getByRole('button', { name: '重新发送' }).click();
	for (let i = 0; i < 150 && calls < 4; i++) await sleep(100);
	assert.equal(calls, 4, 'resend reaches the model, the tool runs, the task finishes');
	await page.locator('.msg-assistant', { hasText: '验证完成' }).waitFor({ timeout: 20000 });
	await sleep(500);
	assert.equal(await card.count(), 0, 'once a tool ran, the stopped card is gone');
	assert.equal(await page.locator('.unexecuted-tool .tool-recovery-actions').count(), 0, 'no recovery actions remain');
	console.log('PASS stopped state is explained, resend works, the notice does not linger');
} finally {
	await browser?.close();
	server.kill(); model.close();
	await sleep(300);
	rmSync(root, { recursive: true, force: true });
}
