/** Real Pi SDK/Codemode with a local model; document tools never contact a model themselves. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { createAgentSession, SettingsManager, SessionManager, DefaultResourceLoader, createCodemodeExtension, createToolSearchExtension } from '@earendil-works/pi-coding-agent';
import { createPdfMarkdownExtension } from '../dist/server/document-conversion/extension.js';
import { createOkfExtension } from '../dist/server/okf/extension.js';
import { updateDocumentSettings } from '../dist/server/document-conversion/settings.js';

const root = mkdtempSync(join(tmpdir(), 'pi-document-sdk-')), agentDir = join(root, 'agent');
const previousData = process.env.PI_WEB_DATA_DIR;
process.env.PI_WEB_DATA_DIR = join(root, 'data');
mkdirSync(agentDir, { recursive: true });
let session, handler = () => undefined, failure;
const requests = [], events = [];
const server = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	let call;
	try { const payload = JSON.parse(raw); requests.push(payload); call = handler(payload); }
	catch (error) { failure = error; }
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const delta = call ? { tool_calls: [{ index: 0, id: `fixture-${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: 'Fixture completed.' };
	for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'document-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [choice] })}\n\n`);
	res.end('data: [DONE]\n\n');
});
function factories() {
	return [
		{ name: 'pi-harness-pdf-markdown', replaceable: true, factory: createPdfMarkdownExtension() },
		{ name: 'pi-harness-okf', replaceable: true, factory: createOkfExtension() },
		{ name: 'codemode', builtin: true, factory: createCodemodeExtension() },
		{ name: 'tool-search', builtin: true, factory: createToolSearchExtension() },
	];
}
async function create(cwd, mode) {
	const settingsManager = SettingsManager.inMemory({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultTools: ['+codemode', '+tool_search'], codemode: { mode }, retry: { enabled: false }, compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: factories() });
	await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const created = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });
	await created.session.bindExtensions({ mode: 'rpc' });
	created.session.subscribe(event => events.push(event));
	return created.session;
}
async function call(name, args, signal) {
	const tool = session.getToolDefinition(name); assert(tool, name);
	const value = await tool.execute(`direct-${name}`, args, signal, undefined, session.extensionRunner.createCommandContext());
	assert(!value.isError, JSON.stringify(value));
	assert(Check(tool.outputSchema, value.structuredContent), `${name} output must match its schema`);
	return value.structuredContent.result ?? value.structuredContent;
}
async function script(mode, code, errorExpected = false) {
	const before = requests.length;
	let round = 0; failure = undefined;
	handler = request => {
		if (mode === 'only') {
			assert(request.tools.some(tool => tool.function.name === 'codemode'));
			assert(!request.tools.some(tool => ['read', 'bash', 'edit', 'write'].includes(tool.function.name)), 'native only mode hides direct file-tool declarations');
		}
		if (round++ === 0) return { name: 'codemode', args: { code } };
	};
	await session.prompt('Run the explicit local document fixture.');
	if (failure) throw failure;
	assert.equal(requests.length - before, 2, 'one requested tool turn and one final answer; no hidden model calls');
	const result = session.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'codemode');
	assert(result, 'codemode result');
	assert.equal(!!result.isError, errorExpected, JSON.stringify(result));
	return result;
}
async function modelCommand(text) {
	const before = requests.length;
	handler = () => undefined; failure = undefined;
	let stop, timer;
	const settled = new Promise((resolve, reject) => {
		timer = setTimeout(() => reject(Error(`Command did not settle: ${text}`)), 10_000);
		stop = session.subscribe(event => { if (event.type === 'agent_settled') resolve(); });
	});
	try { await session.prompt(text); await settled; }
	finally { clearTimeout(timer); stop(); }
	if (failure) throw failure;
	assert.equal(requests.length - before, 1, 'an explicit conversion/resume command starts exactly one native user turn');
	assert(session.messages.findLast(message => message.role === 'user'), 'the request remains visible in native history');
}

try {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	assert(server.address().port >= 8900);
	writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 64000, maxTokens: 4000 }] } } }));
	for (const mode of ['on', 'only']) {
		const cwd = join(root, mode); mkdirSync(join(cwd, 'raw'), { recursive: true });
		writeFileSync(join(cwd, 'raw', 'policy.md'), '# Support policy\n\nThe support desk operates on weekdays.\n\n![Support diagram](support.png)\n');
		writeFileSync(join(cwd, 'raw', 'support.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZI0AAAAASUVORK5CYII=', 'base64'));
		writeFileSync(join(cwd, 'fixture.pdf'), '%PDF-1.7\nfixture');
		updateDocumentSettings({ pdfEnabled: true, okfEnabled: true });
		session = await create(cwd, mode);
		const names = ['pdf_to_markdown', 'okf_ingest', 'okf_candidates', 'okf_publish'];
		for (const name of names) {
			assert.equal(session.getAllTools().find(tool => tool.name === name)?.exposure, 'deferred');
			assert(!session.getActiveToolNames().includes(name), `${name} is not globally injected`);
			assert(session.getToolDefinition(name).outputSchema, `${name} has programmatic output`);
		}
		assert(!session.systemPrompt.includes('This is an explicitly requested ingestion workflow'));
		assert(session.extensionRunner.getCommand('pdf-md'));
		assert(session.extensionRunner.getCommand('okf'));
		if (mode === 'on' && process.platform !== 'win32') {
			// Exercise the native command and owned child process without installing packages.
			const runtimePath = join(root, 'fixture-runtime'), python = join(runtimePath, 'venv', 'bin', 'python'), marker = join(root, 'fixture-setup.pid');
			mkdirSync(join(runtimePath, 'venv', 'bin'), { recursive: true });
			writeFileSync(python, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
			chmodSync(python, 0o755);
			updateDocumentSettings({ runtimePath });
			const beforeSetup = requests.length;
			const setup = session.prompt('/pdf-md setup');
			try {
				await Promise.race([setup, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(Error('Setup command blocked its acknowledgment')), 1000); timer.unref(); })]);
				for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
				assert(existsSync(marker), 'native setup starts the isolated fixture runtime');
				const pid = Number(readFileSync(marker, 'utf8'));
				process.kill(pid, 0);
				await session.prompt('/pdf-md cancel');
				for (let attempt = 0; attempt < 250; attempt++) {
					try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
					await new Promise(resolve => setTimeout(resolve, 20));
				}
				assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'cancel removes only the setup child');
				assert.equal(requests.length, beforeSetup, 'setup/cancel never calls a model');
			} finally { await session.prompt('/pdf-md cancel'); await setup; updateDocumentSettings({ runtimePath: undefined }); }
		} else if (mode === 'on' && process.platform === 'win32') console.log('SKIP setup child fixture on Windows: fixture uses a POSIX executable script; command ownership/abort behavior is covered by the portable unit test.');
		const beforeDirect = requests.length;
		await session.getToolDefinition('tool_search').execute('find-documents', { query: 'okf_ingest' });
		assert(session.getActiveToolNames().includes('okf_ingest'));
		await assert.rejects(call('pdf_to_markdown', { inputPath: 'raw/policy.md' }), /accepts PDF/);
		await assert.rejects(call('pdf_to_markdown', { inputPath: 'fixture.pdf', outputDir: '../escape' }), /inside the current workspace/);
		if (process.platform !== 'win32') {
			symlinkSync(join(root, 'missing-target'), join(cwd, 'dangling'));
			await assert.rejects(call('pdf_to_markdown', { inputPath: 'fixture.pdf', outputDir: 'dangling/output' }), /ENOENT|workspace|symbolic/i);
			assert(!existsSync(join(root, 'missing-target')), 'dangling output link never creates external files');
		}
		const aborted = new AbortController(); aborted.abort();
		await assert.rejects(call('okf_ingest', { action: 'start', paths: ['raw'] }, aborted.signal), /abort/i);
		const started = await call('okf_ingest', { action: 'start', paths: ['raw'] });
		const jobId = started.jobId ?? started.id ?? started.job?.id;
		assert.equal(typeof jobId, 'string', JSON.stringify(started));
		await call('okf_ingest', { action: 'next', jobId });
		const evidence = await call('okf_candidates', { action: 'read', jobId });
		assert.match(JSON.stringify(evidence), /support desk operates on weekdays/);
		const source = evidence.sources[0], block = source.blocks.find(block => block.text.includes('support desk operates on weekdays'));
		assert(block, JSON.stringify(source));
		assert.equal(source.state, 'complete', JSON.stringify(source));
		assert.match(readFileSync(source.markdownPath, 'utf8'), /assets\//, 'archived Markdown keeps its local images');
		const candidate = { conceptId: 'support-hours', title: 'Support hours', type: 'Policy', statement: 'The support desk operates on weekdays.', evidence: [{ sourceId: source.sourceId, sourceHash: source.hash, blockId: block.id, quote: 'The support desk operates on weekdays.' }], review: { support: 'supported', rationale: 'The full single-source fixture states this directly and no existing concept contradicts it.', comparedConceptIds: [], conflicts: [] } };
		await assert.rejects(call('okf_publish', { jobId }), /submit|review/i, 'publication requires explicit Agent review');
		await call('okf_candidates', { action: 'submit', jobId, sourceId: source.sourceId, candidates: [candidate] });
		const published = await call('okf_publish', { jobId });
		assert(published.stable.includes('support-hours'), JSON.stringify(published));
		assert(existsSync(published.indexPath));
		const page = readFileSync(join(cwd, 'knowledge', 'wiki', 'concepts', 'support-hours.md'), 'utf8');
		assert.match(page, /status: stable/);
		assert.match(page, /\[\^s-/);
		assert(!/^verified:/m.test(page), 'automatic publication never claims human verification');
		// This uses the real text converter, whose manifest rejects untracked files.
		// OKF sidecars must remain outside its owned normalized directory.
		const repeated = await call('okf_ingest', { action: 'start', paths: ['raw'] });
		const repeatedStep = await call('okf_ingest', { action: 'next', jobId: repeated.jobId });
		assert.equal(repeatedStep.sources[0].state, 'complete', JSON.stringify(repeatedStep));
		assert.equal(readFileSync(join(cwd, 'knowledge', 'wiki', 'concepts', 'support-hours.md'), 'utf8'), page);
		const custom = await call('okf_ingest', { action: 'start', paths: ['raw'], outputDir: 'exports/company' });
		assert(custom.outputDirectory.replaceAll('\\', '/').endsWith('/exports/company'));
		const customStep = await call('okf_ingest', { action: 'next', jobId: custom.jobId });
		assert.equal(customStep.sources[0].state, 'complete', JSON.stringify(customStep));
		assert((await call('okf_ingest', { action: 'status', jobId })).outputDirectory.replaceAll('\\', '/').endsWith('/knowledge'), 'job identity retains its own output directory');
		const status = await call('okf_ingest', { action: 'status', jobId });
		assert.match(JSON.stringify(status), new RegExp(jobId));
		assert.equal(requests.length, beforeDirect, 'parsing and candidate reads use no model');
		const normal = await script(mode, `text(await searchTools("okf_ingest")); text(await tools.okf_ingest({action:"status",jobId:${JSON.stringify(jobId)}}));`);
		assert(normal.nestedCalls?.calls.some(call => call.name === 'okf_ingest' && call.status === 'ok'));
		assert(events.some(event => event.type === 'agent_settled'));
		const invalid = await script(mode, 'text(await tools.okf_ingest({action:"start",paths:42}));', true);
		assert.match(JSON.stringify(invalid), /valid|array|paths/i, 'SDK rejects invalid tool arguments');
		await modelCommand('/pdf-md convert fixture.pdf');
		await modelCommand(`/okf resume ${jobId}`);
		const beforeStatus = requests.length;
		await session.prompt(`/okf status ${jobId}`);
		assert.equal(requests.length, beforeStatus, 'status is a local operation without a model turn');
		const staleTool = session.getToolDefinition('okf_ingest');
		updateDocumentSettings({ pdfEnabled: false, okfEnabled: false });
		await assert.rejects(staleTool.execute('disabled', { action: 'status', jobId }), /disabled/);
		await session.reload();
		for (const name of names) assert(!session.getCallableToolNames().includes(name), `${name} unavailable after disable/reload`);
		const disabledSearch = await session.getToolDefinition('tool_search').execute('disabled-discovery', { query: 'okf_ingest' });
		assert(!session.getActiveToolNames().includes('okf_ingest'), JSON.stringify(disabledSearch));
		const hidden = await script(mode, 'text(await tools.okf_ingest({action:"status"}));', true);
		assert.match(JSON.stringify(hidden), /not.*(available|found|callable)|unknown|undefined|not a function/i);
		assert(session.extensionRunner.getCommand('pdf-md'), 'setup/settings remain available when disabled');
		assert(session.extensionRunner.getCommand('okf'), 'settings remain available when disabled');
		const beforeSettings = requests.length;
		const command = session.extensionRunner.getCommand('okf');
		await command.handler('settings on', session.extensionRunner.createCommandContext());
		await session.reload();
		assert.equal(session.getAllTools().find(tool => tool.name === 'okf_ingest')?.exposure, 'deferred');
		assert.equal(requests.length, beforeSettings, 'settings/reload does not call a model');
		assert.match(readFileSync(join(root, 'data', 'document-extensions.json'), 'utf8'), /"okfEnabled": true/);
		session.dispose(); session = undefined;
		console.log(`PASS document extensions SDK ${mode}: deferred discovery, structured output, local parsing, cancellation, path guards, schema rejection, disable and reload`);
	}
} finally {
	session?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
	if (previousData === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousData;
	rmSync(root, { recursive: true, force: true });
}
