/** Native npm removal must flush settings and deliver a final worker result (#46). */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const appRoot = resolve(process.argv[2] || '.');
const sdk = pathToFileURL(join(appRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
const root = mkdtempSync(join(tmpdir(), 'pi-package-worker-'));
const cwd = join(root, 'work'), agentDir = join(root, 'agent'), prefix = join(agentDir, 'npm');
// Exercise a legitimately asynchronous settings reload with no referenced I/O.
// A once('message') listener drops IPC's keepalive before this operation finishes.
const preload = join(root, 'delayed-settings.mjs');
writeFileSync(preload, `import { SettingsManager } from ${JSON.stringify(sdk)};
const reload = SettingsManager.prototype.reload;
SettingsManager.prototype.reload = async function (...args) {
 await new Promise(resolve => setTimeout(resolve, 40).unref());
 return reload.apply(this, args);
};`);
const packagePath = join(prefix, 'node_modules', 'pi-worker-fixture');
for (const dir of [cwd, packagePath]) mkdirSync(dir, { recursive: true });
writeFileSync(join(packagePath, 'package.json'), JSON.stringify({ name: 'pi-worker-fixture', version: '1.0.0', pi: { extensions: ['index.js'] } }));
writeFileSync(join(packagePath, 'index.js'), 'export default () => {};');
writeFileSync(join(prefix, 'package.json'), JSON.stringify({ private: true, dependencies: { 'pi-worker-fixture': '1.0.0' } }));
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-worker-fixture'] }));
async function run(input) {
	const child = fork(join(appRoot, 'dist/server/extensions-worker.js'), ['--extensions-worker'], { execArgv: input.action === 'mutate' ? ['--import', preload] : [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
	let result, error, logs = '';
	child.stdout.on('data', value => logs += value); child.stderr.on('data', value => logs += value);
	child.on('message', message => { if (message.progress) logs += message.progress + '\n'; if (message.state) result = message.state; if (message.error) error = message.error; });
	const timer = setTimeout(() => child.kill(), 15000);
	try {
		child.send({ cwd, agentDir, ...input });
		await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { console.log(`worker exit ${code}/${signal}: ${logs.trim()}`); resolve(); }); });
		assert(result && !error, `Package worker stopped without final state: ${error ?? ''}\n${logs}`);
		return result;
	} finally { clearTimeout(timer); }
}
try {
	const state = await run({ action: 'list' });
	const item = state.packages.find(item => item.name === 'pi-worker-fixture'); assert(item);
	const after = await run({ action: 'mutate', version: state.version, operation: { action: 'remove', id: item.id } });
	assert(!after.packages.some(candidate => candidate.id === item.id));
	assert(!existsSync(packagePath));
	assert.deepEqual(JSON.parse(readFileSync(join(agentDir, 'settings.json'))).packages, []);
	console.log('PASS native npm removal returns final state and persists settings');
} finally { rmSync(root, { recursive: true, force: true }); }
