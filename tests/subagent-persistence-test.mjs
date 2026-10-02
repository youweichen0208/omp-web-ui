/** Compiled-manager fault recovery using Node built-ins only; no Vitest, WS or model calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SubagentManager, defaultSubagentConfig } from '../dist/server/subagents.js';

const root = mkdtempSync(join(tmpdir(), 'pi-subagent-persistence-'));
const manager = new SubagentManager();
const directory = join(root, 'subagents/tasks'), backup = directory + '-backup';
const errors = [], previousLog = console.error;
console.error = (...args) => errors.push(args);
try {
	manager.initialize(root); manager.configure({ ...defaultSubagentConfig(), enabled: true }); await manager.flush();
	const input = { clientId: 'fault-fixture', conversationId: 'parent', parentSessionId: 'session', parentRound: 'round', cwd: root, agentDir: root, model: { provider: 'unconfigured-fixture', id: 'none' }, thinking: 'off', roleId: 'analysis', task: 'No model call is allowed' };
	// Directory obstruction also fails when run as root, unlike chmod alone.
	renameSync(directory, backup); writeFileSync(directory, 'temporarily blocked');
	const a = manager.spawn(input);
	await assert.rejects(manager.whenLaunched(a));
	assert.equal(a.status, 'failed'); assert.equal(a.delivered, true); assert.equal(a.startedAt, undefined); assert.equal(manager.has(input.clientId), false);
	rmSync(directory); renameSync(backup, directory);
	const b = manager.spawn({ ...input, parentRound: 'after-recovery' });
	await manager.whenLaunched(b);
	assert.equal(b.status, 'running'); assert.equal(typeof b.startedAt, 'number');
	// Stop immediately: this fixture tests process admission, not SDK/model availability.
	manager.stop(b.id, input.clientId);
	await manager.flush();
	assert.equal((await manager.detail(b.id, input.clientId, input.conversationId)).task.id, b.id);
	assert(errors.length > 0);
	console.log('PASS failed task terminates; recovered disk admits the next worker; flush and detail recover');
} finally {
	if (existsSync(backup)) { rmSync(directory, { recursive: true, force: true }); renameSync(backup, directory); }
	await manager.shutdown(); console.error = previousLog; rmSync(root, { recursive: true, force: true });
}
