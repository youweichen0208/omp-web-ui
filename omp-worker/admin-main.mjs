import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { completeSimple } from "@oh-my-pi/pi-ai/stream";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { getPluginsPackageJson } from "@oh-my-pi/pi-utils";
import { importPiModels } from "./pi-model-import.mjs";

let auth;
let request;
try {
	request = JSON.parse(await Bun.stdin.text());
	const data = await dispatch(request);
	auth?.close();
	process.stdout.write(JSON.stringify({ ok: true, data }), () => process.exit(0));
} catch (error) {
	auth?.close();
	// Model validation failures can quote user config. Only expose known non-secret summaries.
	const message = error?.publicMessage ?? "OMP configuration or management operation failed";
	process.stdout.write(JSON.stringify({ ok: false, error: message }), () => process.exit(1));
}

async function context(modelsPath) {
	const agentDir = getAgentDir();
	await mkdir(agentDir, { recursive: true });
	const settings = await Settings.loadIsolated({ cwd: process.cwd(), agentDir });
	auth = await discoverAuthStorage(agentDir, { settings, cwd: process.cwd() });
	const registry = new ModelRegistry(auth, modelsPath ?? (await readModels()).path, { settings });
	await registry.refresh("offline");
	return { settings, registry, agentDir };
}
async function readModels() {
	const dir = getAgentDir();
	for (const name of ["models.yml", "models.yaml"]) {
		try { return { path: join(dir, name), value: Bun.YAML.parse(await readFile(join(dir, name), "utf8")) ?? {} }; }
		catch (error) { if (error.code !== "ENOENT") throw error; }
	}
	return { path: join(dir, "models.yml"), value: {} };
}
async function dispatch(input) {
	switch (input.operation) {
		case "import_pi_models": {
			const agentDir = getAgentDir();
			await mkdir(agentDir, { recursive: true });
			return importPiModels({ sourceDir: input.sourceDir, agentDir, validate: async candidate => {
				const { registry } = await context(candidate);
				if (registry.getError()) throw { publicMessage: "Pi 模型配置不兼容 OMP，原配置已保留" };
			} });
		}
		case "plugins_list": {
			const manager = new PluginManager(process.cwd());
			const plugins = await manager.list();
			let dependencies = {};
			try { dependencies = JSON.parse(await readFile(getPluginsPackageJson(), "utf8")).dependencies ?? {}; } catch (error) { if (error.code !== "ENOENT") throw error; }
			return plugins.map(p => ({ name: p.name, version: p.version, path: p.path, spec: dependencies[p.name] }));
		}
		case "plugin_update": return new PluginManager(process.cwd()).upgrade(input.name);
		case "provider_auth": {
			const { registry } = await context();
			const model = registry.getAll().find(m => m.provider === input.provider);
			if (!model) return {};
			const result = await registry.getApiKeyAndHeaders(model);
			return result.ok ? { apiKey: result.apiKey, headers: result.headers } : {};
		}
		case "sessions": return input.all ? SessionManager.listAll() : SessionManager.list(input.cwd, input.sessionDir);
		case "session": {
			const manager = await SessionManager.open(input.path);
			try {
				if (typeof input.name === "string") await manager.setSessionName(input.name, "user");
				return { cwd: manager.getCwd(), name: manager.getSessionName(), sessionId: manager.getSessionId(), entries: manager.getEntries(), branch: manager.getBranch(), leafId: manager.getLeafId() };
			} finally { await manager.close(); }
		}
		case "models_read": return (await readModels()).value;
		case "models_write": {
			const current = await readModels();
			const { agentDir } = await context();
			const candidate = join(agentDir, `models-candidate-${randomUUID()}.yml`);
			try {
				await writeFile(candidate, Bun.YAML.stringify({ ...current.value, providers: input.providers }), { mode: 0o600 });
				const settings = await Settings.loadIsolated({ cwd: process.cwd(), agentDir });
				const registry = new ModelRegistry(auth, candidate, { settings });
				await registry.refresh("offline");
				if (registry.getError()) throw { publicMessage: "OMP 模型配置校验失败，原配置已保留" };
				await rename(candidate, current.path);
				return true;
			} finally { await unlink(candidate).catch(() => {}); }
		}
		case "credential_set": {
			await context();
			await auth.credentials.upsert(input.provider, { type: "api_key", key: input.key, source: "login" });
			return true;
		}
		case "credential_clear": {
			await context();
			const rows = auth.credentials.list(input.provider).filter(row => row.credential.type === "api_key");
			for (const row of rows) await auth.credentials.removeById(input.provider, row.id);
			return rows.length > 0;
		}
		case "catalog": {
			const { registry } = await context();
			if (input.online) await registry.refresh("online");
			const all = registry.getAll();
			const available = registry.getAvailable();
			const ids = new Set([...getBundledProviders(), ...all.map(m => m.provider)]);
			const models = all.map(({ headers, ...model }) => model);
			return { models, available: available.map(m => `${m.provider}/${m.id}`), providers: [...ids].map(id => ({
				id, name: id, baseUrl: all.find(m => m.provider === id)?.baseUrl,
				configured: available.some(m => m.provider === id),
				source: auth.credentials.has(id) ? "stored" : auth.keys.source(id) ? "env" : undefined,
			})) };
		}
		case "complete": {
			const { registry } = await context();
			const model = registry.find(input.provider, input.modelId);
			if (!model) throw { publicMessage: "OMP 模型不可用，请检查配置" };
			const credentials = await registry.getApiKeyAndHeaders(model);
			if (!credentials.ok) throw { publicMessage: "OMP 模型尚未配置可用凭据" };
			return completeSimple(model, input.context, { ...input.options, ...credentials });
		}
		default: throw { publicMessage: "Unknown OMP management operation" };
	}
}
