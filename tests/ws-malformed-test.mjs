/**
 * A malformed client message must never take the server down.
 * These types used to crash the whole process (TypeError in the handler):
 * the server must stay up, report sync failures as a notice, and keep serving.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8963;
const root = mkdtempSync(join(tmpdir(), 'pi-malformed-'));
const cwd = join(root, 'ws'); mkdirSync(cwd);
const server = spawn(process.execPath, [join(REPO, 'dist', 'server', 'index.js')], {
	env: { ...process.env, PORT: String(PORT), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') },
	stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let exited = null, log = '';
server.on('exit', (code, signal) => { exited = { code, signal }; });
server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);

const CRASHERS = {
	edit_message: { messageId: 'm', text: [] },
	browse_dirs: { path: 123 },
	list_files: { path: 123 },
	search_files: { query: 123, reqId: 1 },
	set_provider_api_key: { provider: [], apiKey: [] },
	clear_provider_api_key: { provider: {} },
	save_model_config: { providerId: [], config: null },
	clone_provider: { provider: [], reqId: 1 },
	terminal_input: {},
	plugin_settings: {},
};

try {
	for (let i = 0; i < 100 && !exited; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {} await sleep(100); }
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	const notices = [];
	await new Promise(resolve => ws.on('open', resolve));
	ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'notice') notices.push(m.text); });
	ws.send(JSON.stringify({ type: 'hello', clientId: randomUUID() }));
	await sleep(1500);
	for (const [type, fields] of Object.entries(CRASHERS)) {
		ws.send(JSON.stringify({ type, ...fields }));
		await sleep(60);
		assert.equal(exited, null, `server must survive malformed "${type}"\n${log.slice(-600)}`);
	}
	ws.send(JSON.stringify({ type: 'ping-after-malformed-and-not-a-real-type' }));
	ws.send('not json at all');
	ws.send(JSON.stringify({ type: 'get_state' }));
	await sleep(500);
	assert.equal(exited, null);
	assert((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok, 'server still answers HTTP');
	assert(notices.some(t => /请求处理失败/.test(t)), 'synchronous failures are reported to the client');
	ws.close();
	console.log('PASS malformed messages are contained; server stays up');
} finally {
	server.kill();
	await sleep(300);
	rmSync(root, { recursive: true, force: true });
}
