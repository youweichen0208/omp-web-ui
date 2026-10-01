/** Render native tool history and OAuth interactions without model or provider requests. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { serializeMessage } from '../dist/server/serialize.js';
const directory = mkdtempSync(join(tmpdir(), 'pi-native-browser-'));
const port = 31000 + Math.floor(Math.random() * 10000);
const server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, HOME: directory, PORT: String(port), PI_WEB_DATA_DIR: directory, PI_WEB_CWD: directory, PI_CODING_AGENT_DIR: join(directory, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser;
server.stdout.on('data', data => { logs += data; });
server.stderr.on('data', data => { logs += data; });
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null) throw new Error(logs);
		try { const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); assert.equal(health.pid, server.pid); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
	}
	assert(ready, logs);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	for (const language of ['zh', 'en']) {
		const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
		const errors = [], sent = [];
		let socket, baseState;
		page.on('pageerror', error => errors.push(String(error)));
		const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1kAAAAASUVORK5CYII=';
		const result = serializeMessage({ role: 'toolResult', toolCallId: 'native', toolName: 'codemode', isError: false, timestamp: 2, content: [{ type: 'text', text: 'Fixture result' }, { type: 'image', mimeType: 'image/png', data: image }], nestedCalls: { complete: true, calls: [{ id: 'child', name: 'mcp__echo__add', arguments: { a: 2, b: 3 }, status: 'ok', durationMs: 12 }] } }, 1);
		await page.routeWebSocket('**/ws', route => {
			socket = route;
			const upstream = route.connectToServer();
			route.onMessage(wire => { const message = JSON.parse(wire.toString()); sent.push(message); if (!['provider_auth_response', 'cancel_provider_login'].includes(message.type)) upstream.send(wire); });
			upstream.onMessage(wire => {
				const message = JSON.parse(wire.toString());
				if (message.type === 'snapshot') {
					message.state.piConfigured = true;
					message.state.model = { id: 'router', name: 'Router', provider: 'fixture', vision: false };
					message.state.routedModel = { id: 'physical', name: 'Physical', provider: 'fixture', vision: false, thinkingLevel: 'high' };
					message.state.messages = [{ id: 'assistant', role: 'assistant', timestamp: 1, content: [{ type: 'toolCall', id: 'native', name: 'codemode', argumentsText: '{"code":"fixture"}' }] }, result];
					baseState = message.state;
				}
				route.send(JSON.stringify(message));
			});
		});
		await page.addInitScript(language => { localStorage.setItem('pi-web-ui:lang', language); localStorage.setItem('pi-left-collapsed', 'true'); }, language);
		await page.goto(`http://127.0.0.1:${port}`);
		await page.locator('.tool-nested-calls').waitFor();
		await page.locator('.chip-routed-model:visible').first().waitFor();
		assert.match(await page.locator('.chip-routed-model:visible').first().textContent(), /Physical/);
		assert.match(await page.locator('.tool-nested-calls').textContent(), /mcp__echo__add/);
		await page.locator('.tool-nested-call > summary').click();
		assert.match(await page.locator('.tool-nested-call').textContent(), /"a":2/);
		const picture = page.locator('.tool-result-image img');
		await picture.waitFor();
		assert(await picture.evaluate(node => node.complete && node.naturalWidth === 1));
		socket.send(JSON.stringify({ type: 'snapshot', state: { ...baseState, isStreaming: true, messages: baseState.messages.slice(0, 1) } }));
		const child = { type: 'tool_status', conversationId: baseState.conversationId, toolCallId: 'live-child', parentToolCallId: 'native', toolName: 'mcp__http__add', running: true, isError: false, argumentsText: '{"a":4,"b":5}' };
		socket.send(JSON.stringify(child));
		await page.waitForFunction(() => document.querySelector('.tool-nested-calls')?.textContent.includes('mcp__http__add'));
		socket.send(JSON.stringify({ ...child, conversationId: 'other-conversation', toolCallId: 'foreign-child', toolName: 'foreign-tool' }));
		socket.send(JSON.stringify({ ...child, running: false, durationMs: 123 }));
		await page.waitForFunction(() => document.querySelector('.tool-nested-calls')?.textContent.includes('0.1'));
		assert(!await page.locator('.tool-nested-calls').textContent().then(text => text.includes('foreign-tool')));
		socket.send(JSON.stringify({ type: 'snapshot', state: baseState }));
		await page.waitForFunction(() => document.querySelector('.tool-nested-calls')?.textContent.includes('mcp__echo__add'));
		assert.equal(await page.locator('.tool-nested-call').count(), 1);
		const state = { requestId: 'auth-fixture', provider: 'openai', phase: 'pending', url: 'https://example.invalid/authorize', prompt: { id: 'code', kind: 'manual_code', message: 'Fixture authorization code' } };
		socket.send(JSON.stringify({ type: 'provider_auth', state }));
		await page.locator('.provider-auth-modal').waitFor();
		assert.equal(await page.locator('.provider-auth-modal a').getAttribute('href'), state.url);
		await page.locator('.provider-auth-modal input').fill('fixture-code');
		await page.locator('.provider-auth-modal button[type="submit"]').click();
		assert(sent.some(message => message.type === 'provider_auth_response' && message.value === 'fixture-code' && message.requestId === state.requestId && message.promptId === 'code'));
		await page.keyboard.press('Escape');
		await page.locator('.provider-auth-modal').waitFor({ state: 'hidden' });
		assert(sent.some(message => message.type === 'cancel_provider_login' && message.requestId === state.requestId));
		assert.deepEqual(errors, []);
		await page.close();
		console.log(`PASS ${language}: nested tool history, tool image, OAuth response and cancellation`);
	}
} finally {
	await browser?.close();
	if (server.exitCode === null) { const exit = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exit; }
	rmSync(directory, { recursive: true, force: true });
}
