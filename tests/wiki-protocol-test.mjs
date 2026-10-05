// Zero-token HTTP integration: authentication, real-path boundaries, PDF search, versioned edits and history.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { portUp } from './lib/port-utils.mjs';
const port = 8996, clientId = 'wiki-protocol', token = 'wiki-test-only';
assert.equal(await portUp(port), false, 'isolated port must be free');
const base = mkdtempSync(join(tmpdir(), 'wiki-protocol-')), workspace = join(base, 'work');
mkdirSync(workspace); writeFileSync(join(workspace, 'note.md'), '# Notes\n\nsearch phrase');
writeFileSync(join(base, 'outside.txt'), 'outside');
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
const stream = 'BT /F1 12 Tf 10 100 Td (pdf-only-term) Tj ET'; objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
let pdf = '%PDF-1.4\n', offsets = [];
for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
writeFileSync(join(workspace, 'report.pdf'), pdf);
const server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: token, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent'), PI_WEB_CWD: workspace }, stdio: 'ignore' });
let ws;
try {
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
	const state = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('snapshot timeout')), 10000);
		ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', clientId })));
		ws.on('message', wire => { const m = JSON.parse(wire); if (m.type === 'snapshot') { clearTimeout(timer); resolve(m.state); } }); ws.on('error', reject);
	});
	const cwd = state.cwd, endpoint = `http://127.0.0.1:${port}`;
	const request = (action, args = {}, headers = {}) => fetch(endpoint + '/api/wiki', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ action, clientId, cwd, ...args }) });
	assert.equal((await fetch(endpoint + '/api/wiki', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
	assert.equal((await request('state', {}, { Origin: 'https://unrelated.invalid' })).status, 403);
	assert.equal((await request('state', { cwd: base })).status, 409);
	assert.equal((await request('state', { clientId: 'unknown' })).status, 409);
	assert.equal((await request('document', { path: '../outside.txt' })).status, 400);
	const initial = await (await request('state')).json(); assert(initial.entries.some(e => e.path === 'report.pdf' && e.kind === 'pdf'));
	const found = await (await request('search', { query: 'pdf-only-term' })).json();
	assert.equal(found.results[0]?.path, 'report.pdf'); assert.equal(found.results[0]?.page, 1);
	const media = await fetch(endpoint + '/api/wiki-media?' + new URLSearchParams({ clientId, cwd, path: 'report.pdf', token }));
	assert.equal(media.status, 200); assert.match(media.headers.get('content-type'), /application\/pdf/);
	assert.equal((await fetch(endpoint + '/api/wiki-media?' + new URLSearchParams({ clientId, cwd, path: '../outside.txt', token }))).status, 404);
	const doc = await (await request('document', { path: 'note.md' })).json();
	const content = await (await request('document-content', { path: 'note.md' })).json();
	assert.equal(content.text, doc.text); assert.equal(content.version, doc.version); assert.equal(content.editable, true);
	assert.equal('backlinks' in content, false, 'foreground response has no index dependency');
	assert.deepEqual((await (await request('document-references', { path: 'note.md' })).json()).backlinks, doc.backlinks);
	assert.equal((await request('document-content', { path: '../outside.txt' })).status, 400);
	assert.equal((await request('document-references', { path: '../outside.txt' })).status, 400);
	const saved = await request('write', { path: 'note.md', version: doc.version, text: '# saved' });
	assert.equal(saved.status, 200);
	const savedContent = await saved.json();
	assert.equal(savedContent.text, '# saved');
	assert.equal('backlinks' in savedContent, false, 'save response must not rebuild the reference index');
	assert.equal((await request('write', { path: 'note.md', version: doc.version, text: '# stale' })).status, 400);
	const history = await (await request('state')).json();
	assert.equal(history.revisions.length, 1);
	assert.equal((await request('restore', { id: history.revisions[0].id, undo: true })).status, 200);
	assert.equal(readFileSync(join(workspace, 'note.md'), 'utf8'), '# Notes\n\nsearch phrase');
	const openInfo = await (await request('open-info', { path: 'note.md' })).json(); assert(openInfo.absolute.endsWith('note.md'));
	assert.equal((await request('new-conversation', { path: '../outside.txt', conversationId: state.conversationId })).status, 400);
	assert.equal((await request('new-conversation', { path: 'missing.md', conversationId: state.conversationId })).status, 400);
	assert.equal((await request('new-conversation', { path: 'note.md', conversationId: 'stale' })).status, 400);
	// A cold, asynchronous read survives a same-workspace native session switch.
	const refreshing = request('refresh');
	let conversationId = state.conversationId;
	const identities = new Set([conversationId]);
	for (let i = 0; i < 12; i++) {
		const response = await request('new-conversation', { path: 'note.md', conversationId });
		assert.equal(response.status, 200, 'idle document sessions must not exhaust running slots');
		conversationId = (await response.json()).conversationId;
		assert.equal(identities.has(conversationId), false, 'fresh native conversation even when outgoing chat was empty');
		identities.add(conversationId);
	}
	assert.equal((await refreshing).status, 200);
	assert.equal((await request('document-content', { path: 'note.md', conversationId: state.conversationId })).status, 200);
	assert.equal((await request('prompt', { text: 'do not send', requestId: 'stale', conversationId: state.conversationId })).status, 400);
	assert.equal((await request('new-conversation', { path: 'note.md', conversationId: state.conversationId })).status, 400, 'stale navigation cannot replace current session');
	console.log('PASS Wiki HTTP auth/origin/workspace boundaries, PDF full-text/media, saves and persistent undo');
} finally {
	ws?.terminate(); server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); rmSync(base, { recursive: true, force: true });
}
