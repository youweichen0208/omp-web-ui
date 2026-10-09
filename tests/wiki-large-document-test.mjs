// Zero-token navigation latency and race regressions with a real native SDK session.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
const port = 8998;
assert.equal(await portUp(port), false, 'isolated port must be free');
const base = mkdtempSync(join(tmpdir(), 'wiki-navigation-')), cwd = join(base, 'work'), other = join(base, 'other');
mkdirSync(other); writeFileSync(join(other, 'README.md'), '# Other workspace\n\nDifferent content.');
mkdirSync(cwd);
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'agent', 'auth.json'), JSON.stringify({ local: { type: 'api_key', key: 'unused' } }));
writeFileSync(join(base, 'agent', 'models.json'), JSON.stringify({ providers: { local: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', models: [{ id: 'unused', name: 'Unused local model', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'local', defaultModel: 'unused' }));
const text = '# Large document\n\n' + Array.from({ length: 200 }, (_, i) => `## Section ${i}\n\n\`\`\`typescript\n${'const value = "data"; // sample\n'.repeat(112)}\`\`\`\n\nSome **formatted** text and [a link](https://example.com).\n\n`).join('');
writeFileSync(join(cwd, 'large.md'), text);
console.log(JSON.stringify({ bytes: Buffer.byteLength(text), lines: text.split('\n').length }));
const server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', browser, page;
server.stdout.on('data', data => log += data); server.stderr.on('data', data => log += data);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
 for (let i = 0; i < 100 && !await portUp(port); i++) await wait(100);
 browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
 page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
 page.setDefaultTimeout(120000);
 const cdp = await page.context().newCDPSession(page);
 await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
 await page.goto(`http://127.0.0.1:${port}`);
 await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
 await page.evaluate(() => { window.longTasks = []; new PerformanceObserver(list => window.longTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: 'longtask' }); });
 const start = performance.now();
 await page.locator('.file-name', { hasText: 'large.md' }).evaluate(el => el.click());
 await page.locator('.wiki-prose [contenteditable=true]').waitFor();
 const openMs = performance.now() - start;
 const stats = await page.evaluate(() => ({ longestTask: Math.max(...window.longTasks), totalLongTaskMs: window.longTasks.reduce((a,b) => a+b,0), nodes: document.querySelectorAll('*').length }));
 console.log(JSON.stringify({ openMs, ...stats }));
 assert(openMs < 6500, 'code-dense document must become editable within 6.5s at 4x CPU slowdown');
 const code = page.locator('.wiki-prose pre > code');
 assert.equal(await code.count(), 200, 'all code remains available for editing/search');
 await code.first().scrollIntoViewIfNeeded();
 await page.waitForFunction(() => [...(CSS.highlights.get('rich-code-keyword') ?? [])].some(range => range.toString() === 'const'));
 assert(await page.evaluate(() => [...(CSS.highlights.get('rich-code-plain') ?? [])].length < 10), 'offscreen code is not eagerly highlighted');
 await code.last().scrollIntoViewIfNeeded();
 await page.waitForFunction(() => {
  const last = [...document.querySelectorAll('.wiki-prose pre > code')].at(-1);
  return [...(CSS.highlights.get('rich-code-keyword') ?? [])].some(range => last.contains(range.startContainer) && range.toString() === 'const');
 });
 const marker = 'Large document edit preserved';
 await page.locator('.wiki-prose .fp-rich-document p').last().fill(marker);
 for (let i = 0; i < 100 && !readFileSync(join(cwd, 'large.md'), 'utf8').includes(marker); i++) await wait(100);
 const saved = readFileSync(join(cwd, 'large.md'), 'utf8');
 assert(saved.includes(marker), 'large document autosaves edits');
 assert(saved.startsWith(text.slice(0, text.lastIndexOf('Some **formatted**'))), 'untouched blocks retain exact original Markdown');
 assert.equal(saved.split('```typescript').length - 1, 200);
 await code.last().evaluate(code => {
  code.closest('[contenteditable=true]').focus();
  const range = document.createRange(); range.selectNodeContents(code); range.collapse(false);
  getSelection().removeAllRanges(); getSelection().addRange(range);
 });
 await page.keyboard.press('Enter');
 await page.keyboard.type('return 42;');
 const hasReturnColor = () => page.evaluate(() => {
  const last = [...document.querySelectorAll('.wiki-prose pre > code')].at(-1);
  return [...(CSS.highlights.get('rich-code-keyword') ?? [])].some(range => last.contains(range.startContainer) && range.toString() === 'return');
 });
 assert(await hasReturnColor(), 'visible code updates syntax colors while typing');
 await page.evaluate(() => document.execCommand('undo'));
 assert(!(await code.last().innerText()).includes('return 42;'), 'native undo preserves editable code');
 await page.evaluate(() => document.execCommand('redo'));
 assert(await hasReturnColor(), 'redo restores live syntax ranges');
 console.log('PASS large document opening, lazy syntax colors, last-block scrolling/editing, autosave and source preservation');

} finally { await browser?.close(); server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); rmSync(base, { recursive: true, force: true }); }
