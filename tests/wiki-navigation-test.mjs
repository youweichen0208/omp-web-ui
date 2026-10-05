// Zero-token navigation latency and race regressions with a real native SDK session.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
const port = 8997;
assert.equal(await portUp(port), false, 'isolated port must be free');
const base = mkdtempSync(join(tmpdir(), 'wiki-navigation-')), cwd = join(base, 'work'), other = join(base, 'other');
mkdirSync(other); writeFileSync(join(other, 'README.md'), '# Other workspace\n\nDifferent content.');
mkdirSync(cwd);
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'agent', 'auth.json'), JSON.stringify({ local: { type: 'api_key', key: 'unused' } }));
writeFileSync(join(base, 'agent', 'models.json'), JSON.stringify({ providers: { local: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', models: [{ id: 'unused', name: 'Unused local model', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'local', defaultModel: 'unused' }));
for (let i = 0; i < 500; i++) writeFileSync(join(cwd, `doc-${String(i).padStart(3, '0')}.md`), `# Document ${i}\n\n## Introduction\n\n${(i < 2 ? ('Ordinary document text about reading and editing. '.repeat(4) + 'See [[doc-000]] for references.\n\n').repeat(430) : 'Ordinary document text with [[doc-000]] references.\n\n'.repeat(20))}`);
const server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', browser, page;
const sessionResponses = [];
const durations = [];
server.stdout.on('data', data => log += data); server.stderr.on('data', data => log += data);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
	for (let i = 0; i < 100 && !await portUp(port); i++) await wait(100);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(15000);
	await page.addInitScript(() => {
		const Original = window.WebSocket;
		window.WebSocket = class extends Original { constructor(...args) { super(...args); window.wikiTestSocket = this; } };
	});
	const errors = [], created = [];
	let delay = false, fail = false, delayContent = false;
	page.on('pageerror', error => errors.push(error.message));
	await page.route('**/api/wiki', async route => {
		const body = route.request().postDataJSON(), start = performance.now();
		const delayedContent = delayContent && body.action === 'document-content' && body.path === 'doc-001.md';
		if (body.action === 'new-conversation') {
			created.push(body.path);
			if (fail) { fail = false; return route.fulfill({ status: 400, json: { error: 'Simulated initialization failure' } }); }
		}
		if (delay && ['state', 'refresh', 'document-references', 'new-conversation'].includes(body.action)) await wait(5000);
		if (delayedContent) await wait(1800);
		try {
		const response = await route.fetch();
		if (body.action === 'new-conversation') sessionResponses.push({ path: body.path, cwd: body.cwd, status: response.status(), result: await response.json() });
		if (body.action === 'document-content' && !delayedContent) durations.push(performance.now() - start);
		await route.fulfill({ response });
		} catch { await route.abort().catch(() => {}); }
	});
	const go = async () => {
		await page.goto(`http://127.0.0.1:${port}`);
		await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	};
	const select = async (n, first = false) => {
		const path = `doc-${String(n).padStart(3, '0')}.md`;
		if (first) await page.locator('.file-name', { hasText: path }).evaluate(el => el.click());
		else await page.locator(`.wiki-tree-row[title="${path}"]`).evaluate(el => el.click());
	};
	const editable = async n => {
		await page.waitForFunction(n => document.querySelector('.wiki-document-heading h1')?.textContent === `Document ${n}` && !!document.querySelector('.wiki-prose [contenteditable=true]')?.getClientRects().length, n);
	};
	const sessionReady = () => page.getByRole('button', { name: '发送', exact: true }).waitFor();
	await go();
	delay = true;
	let start = performance.now();
	await select(0, true); await editable(0);
	assert(performance.now() - start < 1000, 'body is editable during 5-second index/session delay');
	const editor = page.locator('.wiki-prose [contenteditable=true]');
	await editor.click(); await page.keyboard.press('End'); await page.keyboard.type(' kept draft');
	await page.getByRole('textbox', { name: '问 pi', exact: true }).fill('question draft');
	assert(await page.getByRole('button', { name: '会话准备中', exact: true }).isDisabled());
	assert((await page.locator('.wiki-document-meta').innerText()).includes('引用加载中'));
	await sessionReady();
	assert((await editor.innerText()).includes('kept draft'), 'session snapshot preserves editor draft');
	assert.equal(await page.getByRole('textbox', { name: '问 pi', exact: true }).inputValue(), 'question draft');
	delay = false;
	await page.locator('.wiki-tree-row[title="doc-001.md"]').click();
	await editable(1); await sessionReady();

	// A running request is retained, queued B is replaced by C. A late body cannot replace C.
	delay = true; delayContent = true;
	const before = created.length;
	await select(0); await wait(100);
	await select(1); await wait(100);
	await select(2); await editable(2);
	await wait(2200);
	await editable(2);
	delay = false; delayContent = false;
	await sessionReady();
	assert.deepEqual(created.slice(before), ['doc-000.md', 'doc-002.md']);
	assert.equal(await page.locator('.wiki-chat-answer').count(), 0);

	fail = true;
	await select(3); await editable(3);
	await page.getByText('Simulated initialization failure', { exact: true }).waitFor();
	await page.getByRole('textbox', { name: '问 pi', exact: true }).fill('retry keeps this');
	await page.getByRole('button', { name: '重试创建会话', exact: true }).click();
	await sessionReady();
	assert.equal(await page.getByRole('textbox', { name: '问 pi', exact: true }).inputValue(), 'retry keeps this');

	// Measure click -> actual editable article; placeholders never qualify.
	const samples = { first: [], switch: [], return: [] };
	const sessions = { first: [], switch: [], return: [] };
	for (const scenario of Object.keys(samples)) {
		for (let i = 0; i < Number(process.env.WIKI_NAV_SAMPLES ?? 20); i++) {
			if (scenario === 'first') await go();
			else if (scenario === 'return') await page.getByRole('tab', { name: '对话', exact: true }).click();
			start = performance.now();
			const n = scenario === 'first' ? 0 : (i + 1) % 2;
			await select(n, scenario !== 'switch'); await editable(n);
			samples[scenario].push(performance.now() - start);
			await sessionReady(); sessions[scenario].push(performance.now() - start);
		}
	}
	const p95 = values => Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]);
	for (const scenario of Object.keys(samples)) {
		if (!samples[scenario].length) continue;
		console.log(`${scenario}: editor P95=${p95(samples[scenario])}ms session P95=${p95(sessions[scenario])}ms n=${samples[scenario].length}`);
		assert(p95(samples[scenario]) <= 1000, `${scenario} editor P95 <= 1s`);
	}
	console.log(`content request P95=${p95(durations)}ms`);
	// Dirty drafts survive external changes, saving reports a conflict, clean reload sees disk.
	await select(3); await editable(3); await sessionReady();
	const currentEditor = page.locator('.wiki-prose [contenteditable=true]');
	await currentEditor.click(); await page.keyboard.type(' unsaved');
	writeFileSync(join(cwd, 'doc-003.md'), '# External version\n\nChanged on disk.');
	await page.keyboard.press('Meta+s');
	await page.getByRole('alert').getByText('文件已在外部修改', { exact: true }).waitFor();
	assert((await currentEditor.innerText()).includes('unsaved'));
	await select(4); await page.getByRole('button', { name: '放弃修改', exact: true }).click();
	await editable(4); await sessionReady();
	await select(3);
	await page.locator('.wiki-document-heading h1', { hasText: 'External version' }).waitFor(); await sessionReady();

	// Simulate a workspace change while a slow old file response is still in flight.
	delayContent = true;
	await select(1);
	await page.evaluate(cwd => window.wikiTestSocket.send(JSON.stringify({ type: 'set_cwd', path: cwd })), other);
	await page.locator('.wiki-document-heading h1', { hasText: 'Other workspace' }).waitFor(); await sessionReady();
	await wait(2000);
	assert.equal(await page.locator('.wiki-document-heading h1').innerText(), 'Other workspace');
	assert.deepEqual(errors, []);
	console.log('PASS 500-file Wiki navigation, delayed initialization, editable drafts, A→B→C, late responses and retry');
} catch (error) { console.error('session responses', sessionResponses.slice(-5)); console.error('UI error', await page?.locator('.wiki-error').allTextContents()); console.error('content timings', durations); console.error(log.slice(-3000)); throw error; }
finally { for (const context of browser?.contexts() ?? []) for (const page of context.pages()) await page.unrouteAll({ behavior: 'ignoreErrors' }); await browser?.close(); server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); rmSync(base, { recursive: true, force: true }); }
