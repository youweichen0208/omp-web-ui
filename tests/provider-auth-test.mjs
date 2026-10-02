/** Official ModelRuntime login, fake OAuth provider, isolated credentials. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const root = process.argv[2] || process.cwd();
const { ModelRuntime, SettingsManager } = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')));
const { ProviderAuthService } = await import(pathToFileURL(join(root, 'dist/server/provider-auth.js')));
const directory = mkdtempSync(join(tmpdir(), 'pi-provider-auth-'));
try {
	const runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: join(directory, 'models.json') });
	const settings = SettingsManager.create(directory, directory);
	const base = runtime.getProvider('openai'); assert(base?.auth.oauth);
	let scenario = 'success', changed = 0, response, service;
	const wire = [];
	runtime.registerNativeProvider({ ...base, id: 'desktop-auth-fixture', name: 'Fixture', auth: { oauth: { ...base.auth.oauth, login: async (interaction, options) => {
		assert.match(options.getDeviceId(), /^[0-9a-f-]{36}$/);
		const method = await interaction.prompt({ type: 'select', message: 'Fixture login method', options: [{id:'copy-code',label:'Copy code'},{id:'browser',label:'Browser'}], signal: interaction.signal });
		assert.equal(method, 'copy-code');
		interaction.notify({ type: 'device_code', verificationUri: 'https://example.invalid/device', userCode: 'FIXTURE-DEVICE-CODE' });
		interaction.notify({ type: 'auth_url', url: 'https://example.invalid/fixture-authorize' });
		const value = await interaction.prompt({ type: 'manual_code', message: 'Fixture code', signal: interaction.signal });
		assert.equal(value, 'fixture-code');
		return { type: 'oauth', refresh: 'FIXTURE_REFRESH_SECRET', access: 'FIXTURE_ACCESS_SECRET', expires: Date.now() + 3600000 };
	} } } });
	service = new ProviderAuthService(() => runtime, message => {
		wire.push(message);
		const state = message.state;
		if (state.prompt) {
			response = state;
			if (scenario === 'success') queueMicrotask(() => service.respond(state.requestId, state.prompt.id, state.prompt.kind === 'select' ? 'copy-code' : 'fixture-code'));
			else queueMicrotask(() => service.cancel(state.requestId));
		}
	}, async () => { changed++; }, () => settings.getOrCreateDeviceId());
	await service.login('desktop-auth-fixture');
	assert.equal(wire.at(-1).state.phase, 'success'); assert.equal(changed, 1);
	assert.equal(JSON.parse(readFileSync(join(directory, 'auth.json')))['desktop-auth-fixture'].access, 'FIXTURE_ACCESS_SECRET');
	assert(!JSON.stringify(wire).includes('FIXTURE_ACCESS_SECRET')); assert(!JSON.stringify(wire).includes('FIXTURE_REFRESH_SECRET'));
	const deviceId = settings.getOrCreateDeviceId(); assert.equal(settings.getOrCreateDeviceId(), deviceId);
	scenario = 'cancel'; await service.login('desktop-auth-fixture');
	assert.equal(wire.at(-1).state.phase, 'cancelled'); assert.equal(changed, 1);
	service.respond(response.requestId, response.prompt.id, 'stale-code');
	assert.equal(wire.at(-1).state.phase, 'cancelled');
	console.log('PASS provider OAuth callbacks, stable device ID, credential isolation, cancellation and stale responses');
} finally { rmSync(directory, { recursive: true, force: true }); }
