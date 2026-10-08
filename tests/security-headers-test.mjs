/** Baseline security headers are present on app pages, API routes and auth failures. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8970;
const root = mkdtempSync(join(tmpdir(), 'pi-headers-'));
const cwd = join(root, 'ws'); mkdirSync(cwd);
const server = spawn(process.execPath, [join(REPO, 'dist', 'server', 'index.js')], {
	env: { ...process.env, PORT: String(PORT), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_WEB_TOKEN: 'secret' },
	stdio: 'ignore', windowsHide: true,
});
try {
	for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {} await sleep(100); }
	for (const [label, path, status] of [['health (open)', '/api/health', 200], ['page with token', '/?token=secret', 200], ['401 without token', '/', 401]]) {
		const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
		assert.equal(response.status, status, label);
		assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'self'", `${label}: CSP`);
		assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN', `${label}: X-Frame-Options`);
		assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${label}: nosniff`);
		assert.equal(response.headers.get('referrer-policy'), 'no-referrer', `${label}: Referrer-Policy`);
	}
	console.log('PASS security headers on pages, API and 401 responses');
} finally {
	server.kill();
	await sleep(300);
	rmSync(root, { recursive: true, force: true });
}
