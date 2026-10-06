/** Production-build resource audit. Run serially; no external model or user config.
 * node tests/native-resource-benchmark.mjs [--mode=web|electron|sdk] [--seconds=1800] [--rounds=3] [--out=path]
 * JSONL retains natural one-second samples separately from explicitly requested GC.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, platform, arch, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chromium, _electron } from 'playwright-core';
import WebSocket from 'ws';
import { CHROME_PATH } from './lib/chrome.mjs';
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const mode = arg('mode', 'web'), seconds = Number(arg('seconds', '1800')), rounds = Number(arg('rounds', '3'));
const idleOnly = process.argv.includes('--idle-only');
const historyOnly = process.argv.includes('--history-only');
const defaultTools = process.argv.includes('--default-tools') ? ['+codemode', '+tool_search'] : [];
assert(['web', 'electron', 'sdk'].includes(mode));
const electronExecutable = arg('electron-executable', '');
if (mode === 'electron' && !electronExecutable) throw Error('Pass --electron-executable=/path/to/packaged/pi; build the current version first.');
const output = resolve(arg('out', `docs/review-data/${mode}`)); mkdirSync(output, { recursive: true });
const base = mkdtempSync(join(tmpdir(), 'pi-resource-'));
const agent = join(base, 'agent'); mkdirSync(agent);
process.env.PI_CODING_AGENT_DIR = agent;
const { SessionManager } = await import('@earendil-works/pi-coding-agent');
const projects = Array.from({ length: 30 }, (_, i) => join(base, `project-${i}`));
for (const project of projects) mkdirSync(project);
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [], defaultTools, retry: { enabled: false }, compaction: { enabled: false } }));
// Held local responses exercise simultaneous native runs without paid tokens.
const held = new Set();
const mock = createHttpServer(async (req, res) => {
	let body = ''; for await (const chunk of req) body += chunk;
	if (body.includes('streaming-resource-fixture')) {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		for (let i = 0; i < 100; i++) { res.write(`data: ${JSON.stringify({ id: 'stream', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 's'.repeat(1024) }, finish_reason: null }] })}\n\n`); await sleep(20); }
		res.end(`data: ${JSON.stringify({ id: 'stream', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); return;
	}
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	res.write(`data: ${JSON.stringify({ id: 'held', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'held fixture' }, finish_reason: null }] })}\n\n`);
	held.add(res); res.on('close', () => held.delete(res));
});
await new Promise(r => mock.listen(0, '127.0.0.1', r)); assert(mock.address().port >= 8900);
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${mock.address().port}`, apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 1000000, maxTokens: 100 }] } } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [], defaultProvider: 'fixture', defaultModel: 'fixture', defaultTools, retry: { enabled: false }, compaction: { enabled: false } }));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
// Native persistent transcripts, with exact message counts and 512-byte text payloads.
const histories = {};
const extras = projects[3];
for (let i = 0; i < 100; i++) writeFileSync(join(extras, `note-${i}.md`), `# Fixture ${i}\n\n` + 'search phrase '.repeat(800));
const db = new DatabaseSync(join(extras, 'fixture.sqlite'));
db.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY, text TEXT)');
const statement = db.prepare('INSERT INTO fixture VALUES (?, ?)');
db.exec('BEGIN'); for (let i = 0; i < 10000; i++) statement.run(i, 'row '.repeat(128)); db.exec('COMMIT'); db.close();
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
const stream = 'BT /F1 12 Tf 10 100 Td (pdf-fixture-term) Tj ET'; objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
let pdf = '%PDF-1.4\n', offsets = [];
for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
writeFileSync(join(extras, 'report.pdf'), pdf);

for (const count of [500, 5000, 20000]) {
	const manager = SessionManager.create(projects[0]);
	for (let i = 0; i < count; i++) manager.appendMessage(i % 2 ? { role: 'assistant', content: [{ type: 'text', text: `reply-${i} ` + 'x'.repeat(512) }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'stop', timestamp: Date.now() } : { role: 'user', content: [{ type: 'text', text: `fixture-${i} ` + 'x'.repeat(512) }], timestamp: Date.now() });
	histories[count] = manager.getSessionFile();
}
const largeManager = SessionManager.create(projects[0]);
largeManager.appendMessage({ role: 'user', content: 'Large result fixture', timestamp: Date.now() });
largeManager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'large', name: 'bash', arguments: { command: 'fixture' } }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now() });
largeManager.appendMessage({ role: 'toolResult', toolCallId: 'large', toolName: 'bash', content: [{ type: 'text', text: 'tool output '.repeat(700000) }], isError: false, timestamp: Date.now() });
histories.large = largeManager.getSessionFile();
writeFileSync(join(output, 'environment.json'), JSON.stringify({ mode, seconds, rounds, idleOnly, historyOnly, defaultTools, node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model, totalmem: totalmem(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), lockSha256: createHash('sha256').update(readFileSync('package-lock.json')).digest('hex'), package: JSON.parse(readFileSync('package.json')).version, sdk: JSON.parse(readFileSync('node_modules/@earendil-works/pi-coding-agent/package.json')).version, fixture: { textBytes: 512, messageCounts: [500, 5000, 20000] } }, null, 2));
const recordEnvironment = fields => { const file = join(output, 'environment.json'); writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)), ...fields }, null, 2)); };
const event = record => appendFileSync(join(output, 'events.jsonl'), JSON.stringify({ time: Date.now(), ...record }) + '\n');
const sockets = new Set();
async function wait(predicate, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await predicate(); if (value) return value; await sleep(25); } throw Error(`Timeout: ${predicate}`); }
async function connect(url, clientId) {
	const ws = new WebSocket(url.replace('http', 'ws') + '/ws'); sockets.add(ws);
	let state, seq = 0, bytes = 0;
	ws.on('message', raw => { bytes += raw.length; const m = JSON.parse(raw); if (m.type === 'snapshot') { state = m.state; seq++; } });
	await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', clientId, protocolVersion: 39 })); ws.send(JSON.stringify({ type: 'get_state' }));
	await wait(() => state);
	return { ws, get state() { return state; }, get bytes() { return bytes; }, async request(message) { const before = seq, start = performance.now(); ws.send(JSON.stringify(message)); await sleep(100); ws.send(JSON.stringify({ type: 'get_state' })); await wait(() => seq > before); return performance.now() - start; }, close() { ws.close(); sockets.delete(ws); } };
}
async function port() { const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const value = probe.address().port; await new Promise(r => probe.close(r)); assert(value >= 8900); return value; }
async function injectDesktopProbe(pid) {
	// Packaged Electron removes NODE_OPTIONS before its server fork. Attach only to our
	// health-checked child, import the test sampler, then close the inspector again.
	const reservation = createServer();
	await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(9229, '127.0.0.1', resolve); });
	await new Promise(r => reservation.close(r));
	process.kill(pid, 'SIGUSR1');
	const targets = await wait(async () => { try { return await (await fetch('http://127.0.0.1:9229/json/list')).json(); } catch { return false; } });
	const socket = new WebSocket(targets[0].webSocketDebuggerUrl); await once(socket, 'open');
	let sequence = 0;
	const evaluate = async expression => {
		const id = ++sequence;
		const response = new Promise(resolve => { const listener = raw => { const message = JSON.parse(raw); if (message.id === id) { socket.off('message', listener); resolve(message); } }; socket.on('message', listener); });
		socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
		const result = await response; assert(!result.error && !result.result.exceptionDetails, JSON.stringify(result)); return result.result.result.value;
	};
	try {
		assert.equal(await evaluate('process.pid'), pid);
		await evaluate(`process.getBuiltinModule('module').createRequire(process.cwd()+'/probe.cjs')(${JSON.stringify(resolve('tests/fixtures/resource-probe.mjs'))})`);
		await evaluate("setTimeout(() => process.getBuiltinModule('inspector').close(), 50); true");
	} finally { socket.close(); }
	await sleep(100);
}
let current;
try {
	for (let round = 1; round <= rounds; round++) {
		const directory = join(output, `round-${round}`); mkdirSync(directory, { recursive: true });
		if (historyOnly) {
			// Make automatic project restoration small and deterministic in every round.
			await sleep(20);
			const seed = SessionManager.create(projects[0]);
			seed.appendMessage({ role: 'user', content: `seed-${round}`, timestamp: Date.now() });
			seed.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'seed' }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'stop', timestamp: Date.now() });
		}
		const env = { ...process.env, PI_WEB_CWD: projects[1], PI_WEB_DATA_DIR: join(base, `data-${round}`), PI_CODING_AGENT_DIR: agent, PI_RESOURCE_PROBE: directory, NODE_OPTIONS: `--import=${pathToFileURL(resolve('tests/fixtures/resource-probe.mjs'))}`, PI_WEB_NO_BROWSER: '1' };
		delete env.ELECTRON_RUN_AS_NODE;
		let child, app, browser, page, cdp, url, timer, busy = false, phase = 'startup', netBytes = 0, requests = 0, frontendWsBytes = 0;
		const start = performance.now();
		const roots = new Set();
		const processTree = () => {
			const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu='], { encoding: 'utf8' }).trim().split('\n').map(s => s.trim().split(/\s+/).map(Number));
			const ids = new Set(roots); let last;
			do { last = ids.size; for (const [pid, ppid] of rows) if (ids.has(ppid)) ids.add(pid); } while (last !== ids.size);
			return rows.filter(([pid]) => ids.has(pid)).map(([pid, ppid, rssKiB, cpuPercent]) => ({ pid, ppid, rssKiB, cpuPercent }));
		};
		const sample = async (gc = false) => {
			const processes = processTree();
			if (gc) { for (const { pid } of processes) writeFileSync(join(directory, `gc-${pid}`), ''); if (cdp) await cdp.send('HeapProfiler.collectGarbage'); await sleep(1100); }
			const metrics = cdp ? Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value])) : undefined;
			const dom = cdp ? await cdp.send('Memory.getDOMCounters') : undefined;
			const electronMain = app ? await app.evaluate((_electron, collect) => {
				if (collect) {
					process.getBuiltinModule('v8').setFlagsFromString('--expose_gc');
					process.getBuiltinModule('vm').runInNewContext('gc')();
				}
				return { memory: process.memoryUsage(), cpu: process.cpuUsage(), handles: process._getActiveHandles().length, resources: process.getActiveResourcesInfo() };
			}, gc) : undefined;
			appendFileSync(join(directory, 'samples.jsonl'), JSON.stringify({ time: Date.now(), round, phase, gc, processes, metrics, dom, electronMain, netBytes, requests, frontendWsBytes }) + '\n');
		};
		try {
			if (mode === 'electron') {
				app = await _electron.launch({ executablePath: resolve(electronExecutable), args: [`--user-data-dir=${join(base, `profile-${round}`)}`], env }); current = app;
				roots.add(app.process().pid);
				recordEnvironment({ electronRuntime: await app.evaluate(() => process.versions), executable: resolve(electronExecutable), packaged: true });
				assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
				assert.equal(await app.evaluate(({ app }) => app.getVersion()), JSON.parse(readFileSync('package.json')).version);
				await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.closeDevTools(); });
				page = await wait(() => app.windows().find(w => w.url().startsWith('http://127.0.0.1:')));
				url = new URL(page.url()).origin;
				assert(Number(new URL(url).port) >= 8900);
				await injectDesktopProbe((await (await fetch(url + '/api/health')).json()).pid);
				assert(existsSync(join(directory, 'process.jsonl')), 'Desktop backend probe must be running before any measurements');
			} else {
				const listen = await port(); env.PORT = String(listen); url = `http://127.0.0.1:${listen}`;
				child = spawn(process.execPath, [mode === 'sdk' ? 'tests/fixtures/resource-sdk.mjs' : 'dist/server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); current = child; roots.add(child.pid);
				child.stdout.on('data', d => appendFileSync(join(directory, 'stdout.log'), d)); child.stderr.on('data', d => appendFileSync(join(directory, 'stderr.log'), d));
				if (mode === 'sdk') await once(child, 'message');
				else {
					await wait(async () => { try { return (await fetch(url + '/api/health')).ok; } catch { return false; } });
					event({ round, phase: 'server-ready', ms: performance.now() - start });
					browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
					recordEnvironment({ browserVersion: await browser.version(), executable: CHROME_PATH });
					page = await browser.newPage();
					const browserCdp = await browser.newBrowserCDPSession();
					for (const p of (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo) roots.add(p.id);
				}
			}
			if (page) {
				cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable'); await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
				cdp.on('Network.loadingFinished', m => { netBytes += m.encodedDataLength; requests++; });
				cdp.on('Network.webSocketFrameReceived', m => { frontendWsBytes += Buffer.byteLength(m.response.payloadData); });
				await page.goto(url); await page.locator('.project-item.active').waitFor();
				if (await page.locator('.setup-modal .modal-close').count()) await page.locator('.setup-modal .modal-close').click();
				event({ round, phase: 'ui-ready', ms: performance.now() - start, netBytes, requests });
			}
			timer = setInterval(() => { if (!busy) { busy = true; sample().catch(error => event({ error: String(error) })).finally(() => { busy = false; }); } }, 1000);
			async function stage(name, action) {
				phase = name; event({ round, phase, state: 'start' }); await action?.(); await sleep(2100);
				await wait(() => !busy); busy = true;
				try { await sample(true); } finally { busy = false; }
				event({ round, phase, state: 'end' }); console.log(mode, round, phase);
			}
			await stage('idle');
			if (idleOnly) continue;
			if (mode === 'sdk') {
				for (const count of [1, 3, 8]) await stage(`sessions-${count}`, async () => { child.send({ count }); const [reply] = await once(child, 'message'); assert.equal(reply.count, count); });
			} else {
				const control = await connect(url, `resource-control-${round}`);
				if (!historyOnly) {
					for (const count of [1, 10, 30]) await stage(`clients-${count}`, async () => { for (let i = 0; i < count; i++) { const connection = await connect(url, `resource-${round}-${i}`); connection.close(); } });
					await stage('reconnect-30', async () => { for (let i = 0; i < 30; i++) { const connection = await connect(url, `resource-${round}-0`); connection.close(); } });
					for (const count of [3, 10, 30]) await stage(`projects-${count}`, async () => { for (let i = 0; i < count; i++) { control.ws.send(JSON.stringify({ type: 'set_cwd', path: projects[i], source: 'ui' })); await wait(async () => { await control.request({ type: 'get_state' }); return control.state.cwd === projects[i]; }); } });
				}
				await control.request({ type: 'set_cwd', path: projects[0], source: 'ui' });
				// Use the UI client identity to load real transcripts in the renderer.
				const id = await page.evaluate(() => sessionStorage.getItem('pi-web-client-id'));
				const ui = await connect(url, id);
				await ui.request({ type: 'set_cwd', path: projects[0], source: 'ui' });
				for (const count of [500, 5000, 20000]) await stage(`messages-${count}`, async () => {
					const before = performance.now();
					const transportBefore = { read: ui.ws._socket.bytesRead, written: ui.ws._socket.bytesWritten, decoded: ui.bytes };
					await ui.request({ type: 'switch_session', path: histories[count] });
					await wait(async () => { await ui.request({ type: 'get_state' }); return ui.state.messages.length === count; }, 120000);
					await page.locator('.msg').first().waitFor({ timeout: 120000 });
					if (historyOnly) {
						await page.waitForFunction(count => document.querySelectorAll('[data-msg-id]').length === count, count, { timeout: 120000 });
						let previous, stableSince = performance.now();
						await wait(async () => {
							const state = await page.evaluate(() => { const rows = [...document.querySelectorAll('[data-msg-id]')]; return [rows.length, rows[0]?.getAttribute('data-msg-id'), rows.at(-1)?.getAttribute('data-msg-id')].join('|'); });
							if (state !== previous) { previous = state; stableSince = performance.now(); }
							await sleep(200); return performance.now() - stableSince >= 2000;
						}, 120000);
						const renderedRows = await page.locator('[data-msg-id]').count(); assert.equal(renderedRows, count);
						event({ round, phase, renderedRows, settled: true });
					}
					event({ round, phase, ms: performance.now() - before, decodedWsBytes: ui.bytes, transport: { tcpReceivedBytes: ui.ws._socket.bytesRead - transportBefore.read, tcpSentBytes: ui.ws._socket.bytesWritten - transportBefore.written, decodedReceivedBytes: ui.bytes - transportBefore.decoded, extensions: ui.ws.extensions } });
				});
				if (historyOnly) { ui.close(); control.close(); continue; }
				await stage('large-tool-result-8MB', async () => { await ui.request({ type: 'switch_session', path: histories.large }); await wait(async () => { await ui.request({ type: 'get_state' }); return ui.state.messages.some(m => m.toolCallId === 'large'); }); });
				await stage('streaming-100x1KiB', async () => {
					await ui.request({ type: 'new_chat' });
					await ui.request({ type: 'prompt', text: 'streaming-resource-fixture' });
					await wait(async () => { await ui.request({ type: 'get_state' }); return !ui.state.isStreaming && ui.state.messages.length >= 2; });
				});
				const concurrent = await connect(url, `resource-concurrent-${round}`);
				await concurrent.request({ type: 'set_cwd', path: projects[2], source: 'ui' });
				const activeIds = [];
				for (const count of [1, 3, 8]) await stage(`sessions-${count}`, async () => {
					while (activeIds.length < count) {
						if (activeIds.length) {
							const previous = concurrent.state.conversationId;
							await concurrent.request({ type: 'new_chat' });
							await wait(async () => { await concurrent.request({ type: 'get_state' }); return concurrent.state.conversationId !== previous; });
						}
						await concurrent.request({ type: 'prompt', text: 'held resource fixture' });
						await wait(async () => { await concurrent.request({ type: 'get_state' }); return concurrent.state.isStreaming; });
						activeIds.push(concurrent.state.conversationId);
					}
				});
				await stage('sessions-stopped', async () => {
					for (const conversationId of activeIds) {
						await concurrent.request({ type: 'switch_conversation', id: conversationId });
						await concurrent.request({ type: 'abort' });
						await wait(async () => { await concurrent.request({ type: 'get_state' }); return !concurrent.state.isStreaming; });
					}
				});
				concurrent.close();
				for (const count of [1, 4, 16]) await stage(`terminals-${count}`, async () => { for (let i = count === 1 ? 0 : count === 4 ? 1 : 4; i < count; i++) control.ws.send(JSON.stringify({ type: 'terminal_create', terminalId: `bench-${i}`, cwd: projects[0], cols: 80, rows: 24 })); });
				await stage('terminals-closed', async () => { for (let i = 0; i < 16; i++) control.ws.send(JSON.stringify({ type: 'terminal_kill', terminalId: `bench-${i}` })); });
				await control.request({ type: 'set_cwd', path: extras, source: 'ui' });
				await wait(async () => { await control.request({ type: 'get_state' }); return control.state.cwd === extras; });
				const wiki = async (action, fields = {}) => {
					const response = await fetch(url + '/api/wiki', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, clientId: `resource-control-${round}`, cwd: extras, ...fields }) });
					assert(response.ok, await response.clone().text()); return response.json();
				};
				await stage('wiki-100-documents', async () => { const result = await wiki('state'); assert(result.entries.length >= 100); await wiki('document', { path: 'note-0.md' }); });
				await stage('pdf-search', async () => { const result = await wiki('search', { query: 'pdf-fixture-term' }); assert(result.results.some(r => r.path === 'report.pdf')); });
				await stage('sqlite-10000-rows', async () => { for (const offset of [0, 100, 5000]) { const response = await fetch(url + '/api/sqlite?' + new URLSearchParams({ clientId: `resource-control-${round}`, cwd: extras, path: 'fixture.sqlite', requestId: `sql-${offset}`, table: 'fixture', offset: String(offset) })); assert(response.ok, await response.text()); } });
				await stage('draft-attachment-1MiB', async () => { await page.locator('input[type=file]').first().setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1024 * 1024, 'a') }); await page.locator('.attach-chip').first().waitFor(); });
				ui.close(); control.close();
				if (round === rounds && seconds > 0) {
					// Fixed set: same client, same three projects and view cycle, no new histories.
					const fixed = await connect(url, id); let loops = 0; const deadline = Date.now() + seconds * 1000; phase = 'soak'; event({ round, phase, state: 'start', seconds });
					while (Date.now() < deadline) {
						const begin = performance.now();
						await fixed.request({ type: 'set_cwd', path: projects[loops % 3], source: 'ui' });
						await page.evaluate(index => document.querySelectorAll('[role="tab"]')[index]?.click(), loops % 3);
						event({ round, phase, loop: loops++, ms: performance.now() - begin });
						await sleep(5000);
					}
					await sample(true); fixed.close(); event({ round, phase, state: 'end', loops });
				}
			}
		} finally {
			clearInterval(timer); await wait(() => !busy);
			for (const ws of sockets) ws.close(); sockets.clear();
			await browser?.close(); await app?.close();
			if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
			event({ round, phase: 'cleanup', remaining: processTree() }); current = undefined;
		}
	}
} finally { if (current?.kill) current.kill('SIGTERM'); else await current?.close(); mock.closeAllConnections(); await new Promise(r => mock.close(r)); rmSync(base, { recursive: true, force: true }); }
console.log('Resource evidence:', output);
