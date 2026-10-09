/**
 * PI_WEB_TOKEN authenticates browsers; it must not be inherited by terminals (or the
 * agent's bash tool), where `env` would put it into model context.
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
const PORT = 8972;
const TOKEN = 'tok-' + randomUUID();
const root = mkdtempSync(join(tmpdir(), 'pi-envleak-'));
const cwd = join(root, 'ws'); mkdirSync(cwd);
const server = spawn(process.execPath, [join(REPO, 'dist', 'server', 'index.js')], {
	env: { ...process.env, PORT: String(PORT), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_WEB_TOKEN: TOKEN, SHELL: process.env.SHELL || '/bin/sh' },
	stdio: 'ignore', windowsHide: true,
});
try {
	for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {} await sleep(100); }
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
	let output = '';
	await new Promise(resolve => ws.on('open', resolve));
	ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'terminal_output') output += m.data; });
	ws.send(JSON.stringify({ type: 'hello', clientId: randomUUID() }));
	await sleep(1500);
	ws.send(JSON.stringify({ type: 'terminal_create', terminalId: 'envcheck', cwd, cols: 120, rows: 30 }));
	await sleep(1500);
	// Print a marker around the lookup so an empty variable is distinguishable from "no output yet".
	ws.send(JSON.stringify({ type: 'terminal_input', terminalId: 'envcheck', data: 'echo "[[${PI_WEB_TOKEN}]]"; env | grep -c PI_WEB_TOKEN; echo END-MARK\r' }));
	for (let i = 0; i < 100 && !/END-MARK\s*\r?\n/.test(output.replace(/echo "[^\n]*END-MARK/g, '')); i++) await sleep(100);
	assert(output.includes('[[]]'), `terminal did not run the probe: ${JSON.stringify(output.slice(-300))}`);
	assert(!output.includes(TOKEN), 'PI_WEB_TOKEN must not be visible inside terminals');
	ws.close();
	// Anonymous health checks stay open but must never receive the token cookie.
	const anonymous = await fetch(`http://127.0.0.1:${PORT}/api/health`);
	assert.equal(anonymous.status, 200);
	assert.equal(anonymous.headers.get('set-cookie'), null, 'anonymous /api/health must not set the token cookie');
	assert.equal((await fetch(`http://127.0.0.1:${PORT}/`)).status, 401);
	const withToken = await fetch(`http://127.0.0.1:${PORT}/api/health?token=${TOKEN}`);
	assert.match(withToken.headers.get('set-cookie') ?? '', /pi_web_token=/, 'an authenticated request still gets the cookie');
	console.log('PASS PI_WEB_TOKEN is not inherited by terminals, and only authenticated requests get the token cookie');
} finally {
	server.kill();
	await sleep(300);
	rmSync(root, { recursive: true, force: true });
}
