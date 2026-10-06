/** Actual Pi 1.0.4: MCP management, Codemode execution, output limits and image saves. Zero paid tokens. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
const port = 9204, token = 'codemode-fixture', clientId = 'codemode-mcp';
for (const p of [port, port + 1]) assert.equal(await portUp(p), false, `Port ${p} busy`);
const root = mkdtempSync(join(tmpdir(), 'codemode-mcp-')), cwd = join(root, 'work'), agent = join(root, 'agent');
mkdirSync(cwd); mkdirSync(agent); writeFileSync(join(cwd, 'note.txt'), 'native fixture');
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGOYUHDgPwgzwBgAX7QK/QPmt8EAAAAASUVORK5CYII=';
const scripts = {
 success: '// @options: {"max_output_tokens":40}\nawait Promise.allSettled(Array.from({length:10},()=>tools.read({path:"note.txt"}))); text(await tools.mcp__echo__add({a:2,b:3})); image("data:image/png;base64,' + image + '"); text("x".repeat(4000));',
 failure: 'await tools.write({path:"partial.txt",content:"kept"}); await tools.nonexistent_fixture({});',
 limit: 'for (let i=0;i<100001;i++) text("");',
};
const issued = new Set();
const mock = createServer(async (req, res) => {
 let raw = ''; for await (const chunk of req) raw += chunk;
 const body = JSON.parse(raw);
 const prompts = body.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content?.map(p => p.text ?? '').join(''));
 const kind = [...prompts].reverse().find(text => Object.hasOwn(scripts, text)) ?? 'success';
 const after = issued.has(kind); issued.add(kind);
 const delta = after ? { content: 'Done' } : { tool_calls: [{ index: 0, id: `script-${kind}`, type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code: scripts[kind] }) } }] };
 res.writeHead(200, { 'content-type': 'text/event-stream' });
 for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: after ? 'stop' : 'tool_calls' }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [choice] })}\n\n`);
 res.end('data: [DONE]\n\n');
});
await new Promise(r => mock.listen(port + 1, '127.0.0.1', r));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultTools: ['+codemode', '+tool_search'], retry: { enabled: false } }));
writeFileSync(join(agent, 'auth.json'), JSON.stringify({fixture:{type:'api_key',key:'local'}}));
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port + 1}`, apiKey: 'local', models: [{ id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ extra: 'preserve', mcpServers: { echo: { command: process.execPath, args: [resolve('tests/fixtures/mcp-echo-server.mjs')], env: { PRIVATE: 'secret-value' }, exposure: 'codemode' }, disabled: { command: 'not-a-command', enabled: false } } }));
const server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: token, PI_WEB_CWD: cwd, PI_CODING_AGENT_DIR: agent, PI_WEB_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, logs = '', ws, messages = [], counter = 0;
server.stdout.on('data', d => logs += d); server.stderr.on('data', d => logs += d);
const wait = async predicate => { const start = Date.now(); while (Date.now() - start < 20000) { const found = messages.find(predicate); if (found) return found; if (server.exitCode !== null) throw new Error(logs); await new Promise(r => setTimeout(r, 30)); } throw new Error('Message timeout: ' + logs.slice(-3000)); };
const send = value => ws.send(JSON.stringify(value));
const mcp = async (action, extra = {}) => { const requestId = `r${++counter}`; send({ type: 'native_mcp_request', cwd, scope: 'global', requestId, action, ...extra }); return wait(m => m.type === 'native_mcp_result' && m.requestId === requestId); };
try {
 for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
 ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`); ws.on('message', wire => messages.push(JSON.parse(wire)));
 await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }); send({ type: 'hello', clientId }); await wait(m => m.type === 'snapshot');
 let config = await mcp('get'); assert(!config.error, config.error); assert(!JSON.stringify(config).includes('secret-value')); assert.equal(config.codemode.mode, 'on');
 for (let i = 0; i < 25 && !config.servers.some(s => s.name === 'echo' && s.state === 'connected'); i++) { await new Promise(r => setTimeout(r, 100)); config = await mcp('get'); }
 assert(config.servers.some(s => s.name === 'echo' && s.state === 'connected'), JSON.stringify(config)); assert(config.toolInfo.some(t => t.name === 'mcp__echo__add'));
 const saved = await mcp('save', { version: config.state.version, document: { ...config.state.document, autoEnableCodemode: false } }); assert(!saved.error, saved.error);
 assert.equal(JSON.parse(readFileSync(join(agent, 'mcp.json'))).mcpServers.echo.env.PRIVATE, 'secret-value');
 assert((await mcp('save', { version: config.state.version, document: config.state.document })).error?.includes('changed externally'));
 let settings = await mcp('codemode', { version: saved.codemode.version, codemode: { mode: 'only', inlineBudget: 1200 } }); assert(!settings.error, settings.error); assert.equal(settings.codemode.effectiveMode, 'only');
 assert.equal(JSON.parse(readFileSync(join(agent, 'settings.json'))).retry.enabled, false);
 settings = await mcp('codemode', { version: settings.codemode.version, codemode: { mode: 'on', inlineBudget: 3000 } }); assert(!settings.error);
 let project = await mcp('get', { scope: 'project' });
 assert.equal(project.state.inheritedAutoEnableCodemode, false, 'project switch inherits the global setting');
 project = await mcp('save', { scope: 'project', version: project.state.version, document: { mcpServers: { echo: { enabled: false } } } }); assert(!project.error, project.error);
 project = await mcp('trust', { scope: 'project' }); assert(!project.error, project.error); assert(project.state.trusted);
 for (let i = 0; i < 25 && !project.servers.some(s => s.name === 'echo' && s.state === 'disabled'); i++) { await new Promise(r => setTimeout(r, 100)); project = await mcp('get', { scope: 'project' }); }
 assert(project.servers.some(s => s.name === 'echo' && s.state === 'disabled'));
 project = await mcp('save', { scope: 'project', version: project.state.version, document: { mcpServers: {} } }); assert(!project.error, project.error);
 for (const kind of ['success', 'failure', 'limit']) {
  send({ type: 'prompt', text: kind, requestId: kind });
  const result = await wait(m => (m.type === 'snapshot' || m.type === 'snapshot_delta') && (m.state.messages ?? m.appended)?.some(v => v.toolCallId === `script-${kind}`));
  const tool = (result.state.messages ?? result.appended).find(v => v.toolCallId === `script-${kind}`);
  assert.equal(tool.isError, kind !== 'success', JSON.stringify(tool));
  if (kind === 'success') { assert.equal(tool.codemode.totalCalls, 11); assert(tool.codemode.fullOutputPath); assert(tool.content.some(b => b.type === 'image')); assert(messages.some(m => m.type === 'tool_delta' && m.codemode?.calls.some(c => c.status === 'running'))); }
  if (kind === 'failure') assert.equal(readFileSync(join(cwd, 'partial.txt'), 'utf8'), 'kept');
  if (kind === 'limit') assert(tool.content.some(b => b.type === 'text' && /output|RangeError|limit/i.test(b.text)));
  // Request an authoritative settled snapshot before the next prompt.
  for (let i = 0; i < 100; i++) { const start = messages.length; send({ type: 'get_state' }); await new Promise(r => setTimeout(r, 50)); if (messages.slice(start).some(m => m.type === 'snapshot' && !m.state.isStreaming)) break; }
 }
 const imageRequest = (args = {}, headers = {}) => fetch(`http://127.0.0.1:${port}/api/codemode-image`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ clientId, cwd, dataUrl: `data:image/png;base64,${image}`, ...args }) });
 assert.equal((await imageRequest({}, { Origin: 'https://evil.invalid' })).status, 403); assert.equal((await imageRequest({ cwd: root })).status, 409); assert.equal((await imageRequest({ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
 const response = await imageRequest(); assert.equal(response.status, 200); const { path } = await response.json(); assert.equal(readFileSync(join(cwd, path)).toString('base64'), image);

 if (process.argv.includes('--browser')) {
  browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(clientId => sessionStorage.setItem('pi-web-client-id', clientId), clientId);
  await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
  const card = page.locator('.codemode-card[data-tool-call-id="script-success"]');
  await card.waitFor(); await card.scrollIntoViewIfNeeded();
  assert.equal(await card.locator('.codemode-call').count(), 8);
  await card.getByRole('button', { name: /展开全部/ }).click(); assert.equal(await card.locator('.codemode-call').count(), 11);
  await card.getByRole('tab', { name: '脚本', exact: true }).click(); assert((await card.locator('[role=tabpanel]').innerText()).includes('Promise.allSettled'));
  await page.keyboard.press('ArrowRight'); assert.equal(await card.getByRole('tab', { name: '输出', exact: true }).getAttribute('aria-selected'), 'true');
  await card.locator('.codemode-full-output').waitFor();
  await card.getByRole('button', { name: '保存到当前目录', exact: true }).click(); await card.locator('.codemode-feedback', { hasText: '已保存' }).waitFor();
  await card.getByRole('button', { name: '附加到下一条消息', exact: true }).click(); await page.locator('.attach-chip', { hasText: 'codemode-0.png' }).waitFor();
  await card.getByRole('tab', { name: /调用/ }).click();
  await page.screenshot({ path: 'tests/scratch/codemode-card.png', fullPage: true });
  await page.getByRole('button', { name: '设置', exact: true }).first().click(); await page.getByText('所有设置', { exact: true }).click(); await page.getByText('MCP 与 Codemode', { exact: true }).first().click();
  const echo = page.locator('.mcp-server', { has: page.locator('strong', { hasText: /^echo$/ }) }); await echo.locator('.mcp-server-toggle').click();
  await echo.locator('.mcp-tool-table select').first().waitFor(); assert((await echo.innerText()).includes('add'));
  assert.equal(await page.getByRole('button', { name: '保存并应用', exact: true }).count(), 0);
  await page.getByRole('group', { name: 'codemode.inlineBudget', exact: true }).getByRole('button', { name: '8000', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="codemode.inlineBudget"] button[aria-pressed="true"]')?.textContent === '8000');
  assert.equal(JSON.parse(readFileSync(join(agent, 'settings.json'))).codemode.inlineBudget, 8000);
  await page.getByRole('group', { name: 'codemode.mode', exact: true }).getByRole('button', { name: 'only', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="codemode.mode"] button[aria-pressed="true"]')?.textContent === 'only');
  assert.equal(JSON.parse(readFileSync(join(agent, 'settings.json'))).codemode.mode, 'only');
  const auto = page.getByRole('switch', { name: 'autoEnableCodemode', exact: true });
  await auto.check();
  await page.waitForFunction(() => document.querySelector('.mcp-workbench')?.dataset.dirty === 'false');
  assert.equal(JSON.parse(readFileSync(join(agent, 'mcp.json'))).autoEnableCodemode, true);
  await echo.locator('.mcp-server-head select').selectOption('direct');
  await page.waitForFunction(() => document.querySelector('.mcp-workbench')?.dataset.dirty === 'false');
  assert.equal(JSON.parse(readFileSync(join(agent, 'mcp.json'))).mcpServers.echo.exposure, 'direct');
  assert.equal(JSON.parse(readFileSync(join(agent, 'mcp.json'))).mcpServers.echo.env.PRIVATE, 'secret-value');
  const external = JSON.parse(readFileSync(join(agent, 'mcp.json')));
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ ...external, externalSetting: 'preserve' }));
  await echo.locator('.mcp-server-head select').selectOption('codemode');
  await page.getByRole('alert').filter({ hasText: 'changed externally' }).waitFor();
  assert.equal(JSON.parse(readFileSync(join(agent, 'mcp.json'))).mcpServers.echo.exposure, 'direct', 'conflict does not overwrite external changes');
  await page.getByRole('button', { name: '重试保存', exact: true }).waitFor();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('.settings-rail').getByRole('button', { name: '技能', exact: true }).click();
  assert(await page.locator('.mcp-workbench').isVisible(), 'failed save draft guards navigation');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.mcp-error').getByRole('button').click();
  await page.waitForFunction(() => document.querySelector('.mcp-workbench')?.dataset.dirty === 'false');
  await echo.locator('.mcp-server-head select').selectOption('codemode');
  await page.waitForFunction(() => document.querySelector('.mcp-workbench')?.dataset.dirty === 'false');
  assert.equal(JSON.parse(readFileSync(join(agent, 'mcp.json'))).externalSetting, 'preserve');
  await page.screenshot({ path: 'tests/scratch/codemode-mcp-connected.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'tests/scratch/codemode-mcp-mobile.png', fullPage: true });
  assert(await page.locator('.settings-modal').evaluate(el => el.getBoundingClientRect().width <= window.innerWidth));
  assert.deepEqual(errors, []); await browser.close(); browser = undefined;
  console.log('PASS real browser Codemode tabs, call window, native images, attachment, MCP tools, saved settings, mobile layout');
 }
 console.log('PASS Pi 1.0.4 MCP status, secrets, config conflicts, project overrides, native settings, live Codemode, failure effects, output limit, images');
} catch (error) { console.error(logs.slice(-4000)); throw error; }
finally { await browser?.close(); ws?.terminate(); server.kill(); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); mock.closeAllConnections(); await new Promise(r => mock.close(r)); rmSync(root, { recursive: true, force: true }); }
