/**
 * Idle client eviction: sessions of clients whose sockets are gone are disposed
 * after PI_WEB_CLIENT_IDLE_MINUTES, persisted state survives, and a returning
 * clientId gets a fresh session in its remembered workspace.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8961;
const root = mkdtempSync(join(tmpdir(), 'pi-evict-'));
const DATA = join(root, 'data'), WS = join(root, 'ws'), OTHER = join(root, 'other');
mkdirSync(WS, { recursive: true }); mkdirSync(OTHER, { recursive: true });

const server = spawn(process.execPath, [join(REPO, 'dist', 'server', 'index.js')], {
	env: { ...process.env, PORT: String(PORT), PI_WEB_DATA_DIR: DATA, PI_WEB_CWD: WS, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_WEB_CLIENT_IDLE_MINUTES: '0.03' },
	stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);

const sock = process.platform === 'win32' ? `\\\\.\\pipe\\pi-harness-${PORT}` : join(DATA, 'pi-harness.sock');
const status = () => new Promise(resolve => {
	const c = createConnection(sock); let buf = '';
	c.on('connect', () => c.write('{"cmd":"status"}\n'));
	c.on('data', d => { buf += d; if (buf.includes('\n')) { c.destroy(); try { resolve(JSON.parse(buf)); } catch { resolve(null); } } });
	c.on('error', () => resolve(null));
});
async function until(pred, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(200); } throw new Error(`timeout: ${what}\n${log.slice(-800)}`); }

function connect(clientId) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); let cwd = '';
		ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', clientId })));
		ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'snapshot' && m.state?.cwd) cwd = m.state.cwd; if (m.type === 'ready') setTimeout(() => resolve({ ws, cwd: () => cwd }), 500); });
		ws.on('error', reject);
	});
}

try {
	await until(async () => (await status())?.ok, 20000, 'server up');
	const stay = randomUUID(), leave = randomUUID();
	const a = await connect(stay), b = await connect(leave);
	assert.equal((await status()).clientSessions, 2);
	b.ws.send(JSON.stringify({ type: 'set_cwd', path: OTHER, requestId: 'r1' }));
	await until(() => b.cwd() === OTHER, 10000, 'cwd switched');
	b.ws.close();
	await until(async () => (await status()).clientSessions === 1, 20000, 'idle client evicted');
	assert.equal((await status()).connectedClients, 1, 'attached client is never evicted');
	await sleep(4000);
	assert.equal((await status()).clientSessions, 1, 'attached client survives past the idle window');
	const back = await connect(leave);
	assert.equal((await status()).clientSessions, 2, 'returning client gets a new session');
	await until(async () => back.cwd() === OTHER, 10000, 'workspace restored after eviction');
	a.ws.close(); back.ws.close();
	console.log('PASS idle clients are evicted, attached ones are not, state is restored on return');
} finally {
	server.kill();
	await sleep(300);
	rmSync(root, { recursive: true, force: true });
}
