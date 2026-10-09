import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function readJson(path) {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return {}; throw new Error(`Cannot read Pi configuration: ${path}`); }
}

/** Resolve the selected Pi model with native auth handling, without editing the user's configuration. */
export async function resolvePiModel(selection, baseDir) {
	const agentDir = selection.agentDir ? resolve(baseDir, selection.agentDir) : (process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
	const settings = await readJson(join(agentDir, "settings.json"));
	const provider = selection.provider ?? settings.defaultProvider;
	const id = selection.id ?? settings.defaultModel;
	if (typeof provider !== "string" || typeof id !== "string" || !provider || !id) throw new Error("Select model.provider/model.id or configure Pi's defaultProvider/defaultModel");
	const directory = await mkdtemp(join(tmpdir(), "pi-context-auth-"));
	try {
		const models = await readJson(join(agentDir, "models.json"));
		const auth = await readJson(join(agentDir, "auth.json"));
		await writeFile(join(directory, "models.json"), JSON.stringify({ ...models, providers: models.providers?.[provider] ? { [provider]: models.providers[provider] } : {} }), { mode: 0o600 });
		await writeFile(join(directory, "auth.json"), JSON.stringify(auth[provider] ? { [provider]: auth[provider] } : {}), { mode: 0o600 });
		const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
		const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json"), modelsStorePath: join(directory, "store.json"), allowModelNetwork: false, refreshOnCreate: false });
		const model = runtime.getModel(provider, id);
		if (!model) throw new Error(`Pi model not found: ${provider}/${id}`);
		if (!["openai-completions", "anthropic-messages", "openai-responses"].includes(model.api)) throw new Error(`Evaluation does not support Pi model API: ${model.api}`);
		// With refreshOnCreate:false, isUsingOAuth() has no populated auth snapshot.
		// Public credential metadata detects OAuth before native resolution could refresh a token.
		const storedCredential = (await runtime.listCredentials()).find(credential => credential.providerId === provider);
		const providerAuth = runtime.getProvider(provider)?.auth;
		const unsupportedAuth = "Context evaluation supports API-key/header providers only; OAuth/subscription authentication is not supported";
		// Copilot's token mode also needs provider-specific subscription request handling.
		if (storedCredential?.type === "oauth" || (providerAuth?.oauth && !providerAuth.apiKey) || provider === "github-copilot") throw new Error(unsupportedAuth);
		const credentials = await new ModelRegistry(runtime).getApiKeyAndHeaders(model);
		if (!credentials.ok) throw new Error(`Pi credentials unavailable for provider ${provider}`);
		const headers = { ...model.headers, ...credentials.headers };
		// Native Anthropic treats these tokens specially even when supplied as an API key.
		const authValues = [credentials.apiKey, ...Object.entries(headers).filter(([name]) => /^(authorization|x-api-key)$/i.test(name)).map(([, value]) => value)];
		if (model.api === "anthropic-messages" && authValues.some(value => typeof value === "string" && value.includes("sk-ant-oat"))) throw new Error(unsupportedAuth);
		const baseUrl = credentials.baseUrl ?? model.baseUrl;
		let url;
		try { url = new URL(baseUrl); } catch { throw new Error("Pi model needs a configured HTTP(S) base URL"); }
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Pi model URL must not contain credentials, query or fragment");
		return {
			fromPi: true, provider, id, api: model.api, baseUrl: url.href.replace(/\/$/, ""),
			contextWindow: selection.contextWindow ?? model.contextWindow, maxTokens: selection.maxTokens ?? Math.min(model.maxTokens, 4096),
			apiKey: credentials.apiKey, headers, compat: model.compat,
		};
	} finally { await rm(directory, { recursive: true, force: true }); }
}
