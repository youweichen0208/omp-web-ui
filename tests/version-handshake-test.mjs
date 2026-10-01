/** The footer must receive pi-web-ui's release version, not the pi SDK version. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { portUp } from './lib/port-utils.mjs';

const port = 8998;
const root = mkdtempSync(join(tmpdir(), 'pi-version-handshake-'));
const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
let server;
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = '';
	server.stderr.on('data', (chunk) => { stderr += chunk; });
	for (let i = 0; i < 80 && !await portUp(port); i++) await sleep(200);
	assert(await portUp(port), stderr);
	const version = await new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } });
		const timer = setTimeout(() => { socket.terminate(); reject(new Error('ready timeout')); }, 8000);
		socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', clientId: 'version-regression' })));
		socket.on('message', (data) => {
			const message = JSON.parse(data.toString());
			if (message.type !== 'ready') return;
			clearTimeout(timer);
			socket.close();
			resolve(message.serverVersion);
		});
		socket.on('error', (error) => { clearTimeout(timer); reject(error); });
	});
	assert.equal(version, expected, `ready.serverVersion should be pi-web-ui ${expected}, got ${version}`);
	console.log(`PASS ready.serverVersion is pi-web-ui v${expected}`);
} finally {
	if (server) { server.kill(); await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(2000)]); }
	rmSync(root, { recursive: true, force: true });
}
