import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePiModel } from "../dev/context-eval/pi-model.mjs";
import { loadConfig, reportConfig } from "../dev/context-eval/config.mjs";

async function nativeFixture(t) {
	const root = await mkdtemp(join(tmpdir(), "context-pi-model-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const files = {
		"settings.json": { defaultProvider: "eval_native_one", defaultModel: "default-model" },
		"models.json": { providers: {
			eval_native_one: {
				api: "anthropic-messages", baseUrl: "https://intranet.example.invalid/compatible/anthropic",
				headers: { "X-Gateway-Key": "fixture-gateway-secret" },
				models: [{ id: "default-model", name: "Default", input: ["text"], contextWindow: 100000, maxTokens: 8192, compat: { supportsStrictTools: false } }],
			},
			eval_native_two: {
				api: "openai-completions", baseUrl: "http://10.20.30.40/v1",
				models: [{ id: "override-model", name: "Override", input: ["text"], contextWindow: 64000, maxTokens: 2048 }],
			},
		} },
		"auth.json": {
			eval_native_one: { type: "api_key", key: "fixture-default-secret" },
			eval_native_two: { type: "api_key", key: "fixture-override-secret" },
		},
	};
	const original = new Map();
	for (const [name, document] of Object.entries(files)) {
		const text = `${JSON.stringify(document, null, "\t")}\n`;
		await writeFile(join(agentDir, name), text, { mode: 0o600 });
		original.set(name, text);
	}
	return { root, agentDir, files, async replace(name, document) {
		const text = `${JSON.stringify(document, null, "\t")}\n`;
		await writeFile(join(agentDir, name), text, { mode: 0o600 });
		original.set(name, text);
	}, async assertUnchanged() {
		for (const [name, text] of original) assert.equal(await readFile(join(agentDir, name), "utf8"), text, `${name} must remain unchanged`);
	} };
}

test("Pi default model resolves native credentials and headers without editing original files", async t => {
	const fixture = await nativeFixture(t);
	const model = await resolvePiModel({ fromPi: true, agentDir: "agent" }, fixture.root);
	assert.equal(model.fromPi, true);
	assert.equal(model.provider, "eval_native_one");
	assert.equal(model.id, "default-model");
	assert.equal(model.api, "anthropic-messages");
	assert.equal(model.baseUrl, "https://intranet.example.invalid/compatible/anthropic");
	assert.equal(model.contextWindow, 100000);
	assert.equal(model.maxTokens, 4096);
	assert.equal(model.apiKey, "fixture-default-secret");
	assert.equal(model.headers["X-Gateway-Key"], "fixture-gateway-secret");
	assert.equal(model.compat.supportsStrictTools, false);
	await fixture.assertUnchanged();
});

test("explicit Pi provider/model and token limits override saved defaults", async t => {
	const fixture = await nativeFixture(t);
	const model = await resolvePiModel({ fromPi: true, agentDir: fixture.agentDir, provider: "eval_native_two", id: "override-model", contextWindow: 32000, maxTokens: 1000 }, fixture.root);
	assert.equal(model.provider, "eval_native_two");
	assert.equal(model.id, "override-model");
	assert.equal(model.api, "openai-completions");
	assert.equal(model.baseUrl, "http://10.20.30.40/v1");
	assert.equal(model.contextWindow, 32000);
	assert.equal(model.maxTokens, 1000);
	assert.equal(model.apiKey, "fixture-override-secret");
	assert.ok(!JSON.stringify(model).includes("fixture-default-secret"));
	assert.ok(!JSON.stringify(model).includes("fixture-gateway-secret"));
	await fixture.assertUnchanged();
});

test("fromPi configuration produces credential-free report metadata and fails unknown selections", async t => {
	const fixture = await nativeFixture(t);
	const configPath = join(fixture.root, "config.json");
	const input = {
		version: 1, model: { fromPi: true, agentDir: "agent" },
		sources: [{ id: "docs", kind: "reference", root: "source", files: ["guide.md"] }],
		questions: [{ id: "check", prompt: "What is documented?", expectedEvidence: [{ sourceId: "docs", path: "guide.md" }] }],
	};
	const original = `${JSON.stringify(input)}\n`;
	await writeFile(configPath, original);
	const config = await loadConfig(configPath);
	assert.equal(config.model.apiKey, "fixture-default-secret");
	const report = reportConfig(config), serialized = JSON.stringify(report);
	assert.equal(report.model.provider, "eval_native_one");
	assert.equal(report.model.api, "anthropic-messages");
	assert.ok(!serialized.includes("fixture-default-secret"));
	assert.ok(!serialized.includes("fixture-gateway-secret"));
	assert.ok(!Object.hasOwn(report.model, "apiKey"));
	assert.ok(!Object.hasOwn(report.model, "headers"));
	assert.equal(await readFile(configPath, "utf8"), original);
	await assert.rejects(resolvePiModel({ fromPi: true, agentDir: "agent", id: "missing-model" }, fixture.root), /Pi model not found/);
	await fixture.assertUnchanged();
});

test("expired OAuth credentials are rejected before token refresh or network access", async t => {
	const fixture = await nativeFixture(t);
	await fixture.replace("settings.json", { defaultProvider: "anthropic", defaultModel: "default-model" });
	await fixture.replace("models.json", { providers: { anthropic: fixture.files["models.json"].providers.eval_native_one } });
	await fixture.replace("auth.json", { anthropic: { type: "oauth", access: "sk-ant-oat-fixture-access", refresh: "fixture-refresh-secret", expires: 0 } });
	const originalFetch = globalThis.fetch;
	let networkRequests = 0;
	globalThis.fetch = async () => { networkRequests++; throw new Error("Unexpected auth network request"); };
	try {
		await assert.rejects(resolvePiModel({ fromPi: true, agentDir: "agent" }, fixture.root), /OAuth\/subscription authentication is not supported/);
		assert.equal(networkRequests, 0);
		await fixture.assertUnchanged();
	} finally { globalThis.fetch = originalFetch; }
});

test("OAuth-only subscription providers fail explicitly even without stored tokens", async t => {
	const fixture = await nativeFixture(t);
	await fixture.replace("settings.json", { defaultProvider: "openai-codex", defaultModel: "default-model" });
	await fixture.replace("models.json", { providers: { "openai-codex": fixture.files["models.json"].providers.eval_native_one } });
	await fixture.replace("auth.json", {});
	await assert.rejects(resolvePiModel({ fromPi: true, agentDir: "agent" }, fixture.root), /OAuth\/subscription authentication is not supported/);
	await fixture.assertUnchanged();
});

test("API keys remain supported for dual-mode Anthropic but not Copilot subscription tokens", async t => {
	const fixture = await nativeFixture(t);
	for (const provider of ["anthropic", "github-copilot"]) {
		await fixture.replace("models.json", { providers: { [provider]: fixture.files["models.json"].providers.eval_native_one } });
		await fixture.replace("auth.json", { [provider]: { type: "api_key", key: "fixture-direct-key" } });
		const selection = { fromPi: true, agentDir: "agent", provider, id: "default-model" };
		if (provider === "anthropic") assert.equal((await resolvePiModel(selection, fixture.root)).apiKey, "fixture-direct-key");
		else await assert.rejects(resolvePiModel(selection, fixture.root), /OAuth\/subscription authentication is not supported/);
		await fixture.assertUnchanged();
	}
});

test("Anthropic OAuth tokens passed as API keys or headers cannot bypass the auth boundary", async t => {
	const fixture = await nativeFixture(t);
	await fixture.replace("auth.json", { eval_native_one: { type: "api_key", key: "sk-ant-oat-disguised-secret" } });
	await assert.rejects(resolvePiModel({ fromPi: true, agentDir: "agent" }, fixture.root), /OAuth\/subscription authentication is not supported/);
	await fixture.replace("auth.json", fixture.files["auth.json"]);
	await fixture.replace("models.json", { providers: { eval_native_one: { ...fixture.files["models.json"].providers.eval_native_one, headers: { Authorization: "Bearer sk-ant-oat-header-secret" } } } });
	await assert.rejects(resolvePiModel({ fromPi: true, agentDir: "agent" }, fixture.root), /OAuth\/subscription authentication is not supported/);
	await fixture.assertUnchanged();
});
