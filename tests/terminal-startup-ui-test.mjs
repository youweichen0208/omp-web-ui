import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';

// macOS uses an isolated zsh startup file so a missing prompt is deterministic.
if (process.platform !== 'darwin') { console.log('SKIP macOS terminal startup fixture'); process.exit(0); }
const port = 8998;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-terminal-startup-')));
let server, browser;
try {
	assert.equal(await portUp(port), false);
	writeFileSync(join(root, '.zshrc'), "PS1='PI_TERMINAL_READY> '\n");
	const sessions = join(root, 'agent', 'sessions', `--${root.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
	mkdirSync(sessions, { recursive: true });
	for (const id of ['A', 'B']) writeFileSync(join(sessions, `2026-09-28T00-00-00-000Z_${id}.jsonl`), [
		{ type: 'session', version: 3, id, timestamp: '2026-09-28T00:00:00.000Z', cwd: root },
		{ type: 'message', id: `user-${id}`, parentId: null, timestamp: '2026-09-28T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: `TERMINAL_HISTORY_${id}` }], timestamp: Date.now() } },
	].map(row => JSON.stringify(row)).join('\n') + '\n');
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), OMP_WEB_CWD: root, OMP_WEB_DATA_DIR: join(root, 'data'), OMP_WEB_AGENT_DIR: join(root, 'agent'), SHELL: '/bin/zsh', ZDOTDIR: root }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	assert(await portUp(port));
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	const events = [];
	const creates = [];
	let activeConversationId;
	let socket;
	await page.routeWebSocket('**/ws', route => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage(wire => {
			const message = JSON.parse(wire.toString());
			if (message.type.startsWith('terminal_')) events.push(`${message.type}:${message.conversationId}`);
			if (message.type === 'terminal_create') creates.push(message);
			upstream.send(wire);
		});
		upstream.onMessage(wire => {
			const message = JSON.parse(wire.toString());
			if (message.type === 'snapshot' || message.type === 'snapshot_delta') message.state.piConfigured = true;
			if (message.type === 'terminal_output') events.push(`output:${message.data.length}`);
			if (message.type === 'conversations') { activeConversationId = message.activeId; events.push(`active:${message.activeId}`); }
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.session-item.active').waitFor();
	if (!process.argv.includes('--fresh')) {
		const previousConversationId = activeConversationId;
		const target = (await page.locator('.session-item.active').textContent()).includes('TERMINAL_HISTORY_B') ? 'A' : 'B';
		await page.locator('.session-item', { hasText: `TERMINAL_HISTORY_${target}` }).click();
		await page.locator('.msg-user', { hasText: `TERMINAL_HISTORY_${target}` }).waitFor();
		assert.notEqual(activeConversationId, previousConversationId, 'switch conversations within the same project before opening a terminal');
	}
	await page.getByRole('tab', { name: '终端', exact: true }).click();
	await page.locator('.term-xterm:not(.hidden) .xterm').waitFor();
	try {
		await page.waitForFunction(() => document.querySelector('.term-xterm:not(.hidden)')?.textContent.includes('PI_TERMINAL_READY'), undefined, { timeout: 5000 });
	} catch {
		console.log('Terminal events:', events.join(', '));
		await page.screenshot({ path: '/private/tmp/pi-terminal-startup.png' });
		throw new Error('Terminal remains blank: no startup prompt rendered');
	}
	assert.equal(creates.at(-1)?.conversationId, activeConversationId, 'new shell belongs to the selected conversation');
	console.log('PASS selected conversation terminal shows shell prompt');
	const previousSocket = socket;
	socket.close();
	for (let i = 0; i < 60 && socket === previousSocket; i++) await sleep(100);
	assert.notEqual(socket, previousSocket, 'websocket reconnected');
	await page.waitForFunction(() => document.querySelector('.term-xterm:not(.hidden)')?.textContent.includes('PI_TERMINAL_READY'), undefined, { timeout: 5000 });
	await page.locator('.term-xterm:not(.hidden) .xterm-helper-textarea').pressSequentially("printf 'RESTORED_%s\\n' TERMINAL");
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => document.querySelector('.term-xterm:not(.hidden)')?.textContent.includes('RESTORED_TERMINAL'), undefined, { timeout: 5000 });
	console.log('PASS terminal receives output after reconnect');
} finally {
	await browser?.close();
	if (server?.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await stopped; }
	rmSync(root, { recursive: true, force: true });
}
