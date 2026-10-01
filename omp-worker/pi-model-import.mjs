import { lstat, readFile, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

async function exists(path) {
	try { await lstat(path); return true; }
	catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function readJson(path) {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

// Publish a complete file without replacing a file another process just created.
async function publish(candidate, destination) {
	try { await link(candidate, destination); return true; }
	catch (error) { if (error.code === "EEXIST") return false; throw error; }
}

/** Read-only Pi models.json conversion. Validation and secret handling stay in Bun. */
export async function importPiModels({ sourceDir, agentDir, validate }) {
	const destination = join(agentDir, "models.yml");
	if (await exists(destination) || await exists(join(agentDir, "models.yaml"))) return { imported: false };
	const legacy = await readJson(join(sourceDir, "models.json"));
	if (!legacy?.providers || Object.keys(legacy.providers).length === 0) return { imported: false };
	if (typeof legacy.providers !== "object" || Array.isArray(legacy.providers)) throw new Error("Invalid providers");
	const providers = legacy.providers;
	// A provider may keep its key in Pi auth.json rather than models.json.
	// Only api_key records for imported providers are compatible; OAuth stays in Pi.
	let credentials;
	try { credentials = await readJson(join(sourceDir, "auth.json")); } catch { /* Optional legacy credentials. */ }
	for (const [id, provider] of Object.entries(providers)) {
		if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new Error("Invalid provider");
		const credential = credentials?.[id];
		if (provider.apiKey === undefined && credential?.type === "api_key" && typeof credential.key === "string") {
			provider.apiKey = credential.key;
		}
	}
	const candidate = join(agentDir, `models-import-${randomUUID()}.yml`);
	try {
		await writeFile(candidate, Bun.YAML.stringify({ providers }), { mode: 0o600, flag: "wx" });
		await validate(candidate);
		if (await exists(join(agentDir, "models.yaml")) || !await publish(candidate, destination)) return { imported: false };
	} finally { await unlink(candidate).catch(error => { if (error.code !== "ENOENT") throw error; }); }

	// Import only the model selection, never legacy settings, tools or extensions.
	// Existing OMP settings always win, including alternate config filenames.
	const configPath = join(agentDir, "config.yml");
	let defaultModel;
	try {
		const settings = await readJson(join(sourceDir, "settings.json"));
		if (typeof settings?.defaultProvider === "string" && typeof settings.defaultModel === "string"
			&& providers[settings.defaultProvider]?.models?.some(m => m.id === settings.defaultModel)) {
			defaultModel = `${settings.defaultProvider}/${settings.defaultModel}`;
		}
	} catch { /* Model definitions remain useful without a legacy default. */ }
	if (defaultModel && !await exists(configPath) && !await exists(join(agentDir, "config.yaml")) && !await exists(join(agentDir, "settings.json"))) {
		const configCandidate = join(agentDir, `config-import-${randomUUID()}.yml`);
		try {
			await writeFile(configCandidate, Bun.YAML.stringify({ modelRoles: { default: defaultModel } }), { mode: 0o600, flag: "wx" });
			await publish(configCandidate, configPath);
		} finally { await unlink(configCandidate).catch(error => { if (error.code !== "ENOENT") throw error; }); }
	}
	return { imported: true, providers: Object.keys(providers).length };
}
