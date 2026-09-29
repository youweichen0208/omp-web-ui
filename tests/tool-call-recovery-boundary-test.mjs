/** Queue arrivals after turn_end, using the real SDK loop without network calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import * as recovery from '../dist/server/tool-call-recovery.js';

const model = { id: 'mock', name: 'mock', api: 'openai-completions', provider: 'mock', baseUrl: 'http://127.0.0.1:19999', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 };
const xml = '<invoke name="read"><parameter name="path">runtime.py</parameter></invoke>';
for (const scenario of ['late-steer', 'late-follow-up', 'late-extension', 'preserve-follow-up', 'late-stop-hook', 'stop-hook', 'uninstall-during-run', 'tool-disabled']) {
	const root = mkdtempSync(join(tmpdir(), 'pi-recovery-boundary-'));
	let session, uninstall;
	try {
		const agentDir = join(root, 'agent'); mkdirSync(agentDir);
		writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { mock: { api: model.api, baseUrl: model.baseUrl, apiKey: 'local-test', models: [model] } } }));
		writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ mock: { type: 'api_key', key: 'local-test' } }));
		({ session } = await createAgentSession({ cwd: root, agentDir, model, tools: ['read'], sessionManager: SessionManager.inMemory(root), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) }));
		assert(session.getActiveToolNames().includes('read'), 'the malformed call must target an active tool');
		let calls = 0, injected = false, stopChecks = 0;
		const statuses = [], contexts = [];
		session.agent.streamFunction = (currentModel, context) => {
			contexts.push(JSON.stringify(context.messages));
			const stream = createAssistantMessageEventStream();
			const message = { role: 'assistant', content: [{ type: 'text', text: ++calls === 1 ? xml : '已暂停，等待用户。' }], api: currentModel.api, provider: currentModel.provider, model: currentModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
			stream.push({ type: 'start', partial: message });
			stream.push({ type: 'done', reason: 'stop', message }); stream.end();
			return stream;
		};
		const inject = async () => {
			if (injected) return;
			injected = true;
			if (scenario === 'late-follow-up') await session.followUp('暂停，不要继续执行，只解释原因。');
			else if (scenario === 'late-extension') await session.sendCustomMessage({ customType: 'extension-wait', content: '扩展要求等待确认。', display: true }, { deliverAs: 'followUp', triggerTurn: true });
			else {
				await session.steer('暂停，不要继续执行，只解释原因。');
				if (scenario === 'preserve-follow-up') await session.followUp('保留这条排队消息：只解释原因。');
			}
		};
		const prepare = session.agent.prepareNextTurnWithContext;
		session.agent.prepareNextTurnWithContext = async (...args) => {
			const result = await prepare?.(...args);
			if (scenario === 'uninstall-during-run') { uninstall(); uninstall = undefined; }
			else if (scenario === 'tool-disabled') session.setActiveToolsByName([]);
			else if (!scenario.endsWith('stop-hook')) await inject();
			return result;
		};
		const previousStop = async () => {
			stopChecks++;
			if (scenario === 'late-stop-hook') await inject();
			return scenario === 'stop-hook';
		};
		session.agent.shouldStopAfterTurn = previousStop;
		uninstall = recovery.installToolCallRecovery(session);
		session.subscribe(event => {
			recovery.handleToolCallRecovery(session, event);
			if (event.type === 'message_start' && event.message.customType === 'tool-call-recovery') statuses.push(event.message.details.status);
		});
		await session.prompt('读取文件并验证。');
		assert.equal(calls, ['stop-hook', 'uninstall-during-run', 'tool-disabled'].includes(scenario) ? 1 : scenario === 'preserve-follow-up' ? 3 : 2, `${scenario}: stale correction must not start another model request`);
		assert.equal(stopChecks, calls, 'preserve the existing SDK stop hook');
		assert(!statuses.includes('retrying'), `${scenario}: no obsolete recovery should reach the model`);
		assert(contexts.every(context => !context.includes('That invocation was NOT executed')), 'no recovery prompt after a new instruction');
		if (scenario === 'preserve-follow-up') assert(contexts.at(-1).includes('保留这条排队消息'), 'other queued messages must survive');
		uninstall?.(); uninstall = undefined;
		assert.equal(session.agent.shouldStopAfterTurn, previousStop, 'unbinding must restore the original hook');
		console.log(`PASS ${scenario}: model calls=${calls}, recovery=${statuses.join(',') || 'none'}`);
	} finally {
		uninstall?.(); session?.dispose(); rmSync(root, { recursive: true, force: true });
	}
}
