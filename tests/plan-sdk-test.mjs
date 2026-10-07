/** Real Pi 1.0.4, local model: model-only plan persistence and branch/loadout contracts. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, SettingsManager, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { nativeToolExtensions } from '../dist/server/native-tools.js';
import { latestPlan } from '../dist/server/plan/state.js';
import { PlanSettings } from '../dist/server/plan/settings.js';
const root = mkdtempSync(join(tmpdir(), 'pi-plan-sdk-')), agentDir = join(root, 'agent');
mkdirSync(agentDir, { recursive: true });
const preference = new PlanSettings(root);
let session, handler, failure;
const requests = [];
const server = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	let calls = [];
	try { const request = JSON.parse(raw); requests.push(request); calls = handler(request) ?? []; } catch (error) { failure = error; }
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const deltas = calls.length ? [{ tool_calls: calls.map(([id, args], index) => ({ index, id, type: 'function', function: { name: 'plan', arguments: JSON.stringify(args) } })) }] : [{ content: 'fixture done' }];
	for (const delta of deltas) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\n`);
	res.end('data: [DONE]\n\n');
});
const input = { action: 'create', title: 'SDK plan', status: 'active', steps: [{ id: 'a', title: 'Read', detail: 'Full details' }, { id: 'b', title: 'Test' }], currentStepId: 'a', completedStepIds: [], completionCriteria: 'All checks pass' };
const latest = () => latestPlan(session.sessionManager.getBranch())?.snapshot;
const update = (snapshot, patch = {}) => ({ ...snapshot, action: 'update', expectedRevision: snapshot.revision, ...patch });
async function prompt(text, next) { handler = next; failure = undefined; await session.prompt(text); if (failure) throw failure; }
async function make(mode, factories = nativeToolExtensions(), manager = SessionManager.create(root, join(root, 'sessions'))) {
	const settingsManager = SettingsManager.inMemory({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultTools: ['+codemode'], codemode: { mode }, retry: { enabled: false }, compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, extensionFactories: factories }); await resourceLoader.reload();
	const { session: created } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: manager });
	await created.bindExtensions({ mode: 'rpc' }); return created;
}
try {
	await new Promise(r => server.listen(0, '127.0.0.1', r)); assert(server.address().port >= 8900);
	writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 2000 }] } } }));
	for (const mode of ['on', 'only']) {
		session = await make(mode);
		assert.equal(session.getActiveToolNames().includes('plan'), false);
		preference.set(true); preference.coordinate(session, true);
		assert(preference.state(session).effective, JSON.stringify(session.getAllTools().find(t => t.name === 'plan')));
		let round = 0;
		await prompt('Implement with a plan', request => {
			assert(request.tools.some(t => t.function.name === 'plan'));
			assert(session.getToolDefinition('plan').executionMode === 'sequential');
			assert.equal(session.getCallableToolNames().includes('plan'), false);
			return round++ === 0 ? [['create', input]] : [];
		});
		const first = latest(); assert.equal(first.revision, 1);
		const firstLeaf = session.sessionManager.getLeafId();
		round = 0;
		await prompt('Continue implementation', () => round++ === 0 ? [['update-1', update(first, { currentStepId: 'b', completedStepIds: ['a'] })], ['update-2', update({ ...first, revision: 2 }, { currentStepId: 'b', completedStepIds: ['a'] })]] : []);
		assert.equal(latest().revision, 3);
		const success = latest();
		round = 0;
		await prompt('Reject stale identity then correct it', request => {
			if (round++ === 0) return [['bad', update(first, { planId: 'stale-id' })]];
			if (round === 2) {
				assert.equal(latest().revision, 3);
				assert.match(JSON.stringify(request.messages), /expectedRevision.*3/);
				assert.match(JSON.stringify(request.messages), /Full details/);
				return [['correct', update(success)]];
			}
		});
		assert.equal(latest().revision, 4);
		const newerLeaf = session.sessionManager.getLeafId();
		// Reopen a native compacted branch whose model context contains only the summary.
		session.sessionManager.appendCompaction('Implementation is in progress.', null, 16000);
		const compactedFile = session.sessionManager.getSessionFile();
		session.dispose(); session = await make(mode, nativeToolExtensions(), SessionManager.open(compactedFile));
		preference.coordinate(session, true);
		await prompt('Is this relevant to my new request?', request => {
			const serialized = JSON.stringify(request.messages);
			assert(serialized.includes('Historical plan background'));
			assert(serialized.includes('Full details'));
			assert(serialized.includes(first.planId));
			assert(serialized.includes('expectedRevision'));
			assert(serialized.includes('not authorization to continue'));
		});
		assert(!readFileSync(compactedFile, 'utf8').includes('pi-harness:plan-background'));

		preference.set(false); preference.coordinate(session, true);
		await session.navigateTree(firstLeaf, { summarize: false });
		preference.coordinate(session, true);
		assert.equal(session.getActiveToolNames().includes('plan'), false);
		assert.equal(latest().revision, 1);
		await prompt('An ordinary question while disabled', request => {
			assert(!request.tools.some(t => t.function.name === 'plan'));
			const system = request.messages.filter(m => m.role === 'system');
			assert(!JSON.stringify(system).includes('Record and update a multi-step'));
			assert(!JSON.stringify(request.messages).includes('Historical plan background'));
		});
		await session.navigateTree(newerLeaf, { summarize: false }); preference.coordinate(session, true);
		assert.equal(latest().revision, 4); assert.equal(session.getActiveToolNames().includes('plan'), false);
		await session.reload(); preference.coordinate(session, true); assert.equal(preference.state(session).effective, false);
		const file = session.sessionManager.getSessionFile();
		assert.match(readFileSync(file, 'utf8'), /"planSnapshot"/);
		assert(!readFileSync(file, 'utf8').includes('pi-harness:plan-background'));
		session.dispose(); session = await make(mode, [], SessionManager.open(file));
		assert(latest()); await prompt('CLI without plan extension', () => []);
		session.dispose(); session = undefined;
		console.log(`PASS plan SDK ${mode}: direct result persistence, sequential revisions, errors, branch correction, disable/reload, extension-free reopen`);
	}
	// A third-party name wins; the service must never activate/deactivate it.
	const { Type } = await import('typebox');
	const thirdParty = { name: 'third-party', factory: pi => pi.registerTool({ name: 'plan', label: 'Third party', description: 'Third party', parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'third party' }], details: {} }) }) };
	session = await make('on', [...nativeToolExtensions(), thirdParty]);
	assert.equal(preference.state(session).reason, 'conflict');
	for (const enabled of [true, false]) { preference.set(enabled); const before = session.getActiveToolNames(); preference.coordinate(session, true); assert.deepEqual(session.getActiveToolNames(), before); }
	console.log('PASS third-party plan tool is untouched');
} finally { session?.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); }
