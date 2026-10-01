/** Real bundled rpiv-todo: zero-token loader/lifecycle/state regression. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent';
import { adaptTodoExtensions, TODO_EXTENSION_PATH, TODO_GUIDANCE } from '../dist/server/todo-extension.js';
import { taskHistoryFromSession } from '../dist/server/todo-progress.js';
import { deriveTaskProgress } from '../dist/server/task-progress.js';
import { serializeMessage } from '../dist/server/serialize.js';

const root = mkdtempSync(join(tmpdir(), 'pi-todo-extension-'));
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, noExtensions: true, additionalExtensionPaths: [TODO_EXTENSION_PATH], extensionsOverride: (res) => ({ ...res, extensions: adaptTodoExtensions(res.extensions) }) });
let extension;
const a = SessionManager.inMemory(root);
const b = SessionManager.inMemory(root);
const ctx = (manager) => ({ sessionManager: manager, hasUI: true, ui: { setWidget() { throw Error('Web panel must own rendering'); }, notify() {} } });
const lifecycle = async (event, manager) => { for (const handler of extension.handlers.get(event) ?? []) await handler({}, ctx(manager)); };
let counter = 0;
async function call(manager, params) {
	const id = `todo-${++counter}`;
	const result = await extension.tools.get('todo').definition.execute(id, params, undefined, undefined, ctx(manager));
	manager.appendMessage({ role: 'toolResult', toolName: 'todo', toolCallId: id, content: result.content, details: result.details, isError: false, timestamp: Date.now() });
	return result.details;
}
try {
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	extension = loader.getExtensions().extensions.find((e) => e.tools.has('todo'));
	assert(extension, 'bundled native extension loads without user installation');
	assert.deepEqual(extension.tools.get('todo').definition.promptGuidelines, TODO_GUIDANCE);
	assert.equal(extension.tools.has('task_plan'), false);
	assert.equal(extension.shortcuts.size, 0);
	assert.equal(adaptTodoExtensions([extension, extension]).length, 1);
	a.appendMessage({ role: 'user', content: '实现导出功能', timestamp: 10 });
	await lifecycle('session_start', a);
	await lifecycle('session_start', b);
	assert.equal((await call(a, { action: 'create', subject: '确认需求', metadata: { title: '导出功能', completionCriteria: '测试通过' } })).tasks.length, 1);
	await call(a, { action: 'create', subject: '实施', blockedBy: [1] });
	await call(a, { action: 'update', id: 1, status: 'in_progress' });
	assert.equal((await call(b, { action: 'list' })).tasks.length, 0, 'sessions do not share tasks');
	const rejected = await call(a, { action: 'update', id: 1, addBlockedBy: [2] });
	assert(rejected.error?.includes('cycle'));
	a.appendMessage({ role: 'user', content: '继续', timestamp: 100 });
	const history = () => taskHistoryFromSession(a, (m) => serializeMessage(m, 0));
	assert.equal(deriveTaskProgress('a', history(), null, false).status, 'waiting');
	const branch = a.getBranch();
	a.appendCompaction('Earlier work summarized', branch.at(-1).id, 1000);
	await lifecycle('session_compact', a);
	assert.equal((await call(a, { action: 'list' })).tasks.length, 2);
	assert.equal(deriveTaskProgress('a', history(), null, false).plan.items.length, 2);
	await loader.reload();
	extension = loader.getExtensions().extensions.find((e) => e.tools.has('todo'));
	await lifecycle('session_start', a);
	assert.equal((await call(a, { action: 'list' })).tasks[0].status, 'in_progress');
	await call(a, { action: 'update', id: 1, status: 'completed' });
	await call(a, { action: 'update', id: 2, status: 'completed' });
	assert.equal(deriveTaskProgress('a', history(), null, false).status, 'done');
	await lifecycle('session_shutdown', a);
	a.newSession();
	await lifecycle('session_start', a);
	assert.equal((await call(a, { action: 'list' })).tasks.length, 0, '/new starts with no todos');
	console.log('PASS bundled todo load, guidance, isolation, dependencies, compaction, reload, completion and /new');
} finally {
	if (extension) { await lifecycle('session_shutdown', a); await lifecycle('session_shutdown', b); }
	rmSync(root, { recursive: true, force: true });
}
