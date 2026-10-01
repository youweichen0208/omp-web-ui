import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "../dist/server/omp/models.js";
import { runOmpAdmin } from "../dist/server/omp/admin.js";
import { AgentSession } from "../dist/server/omp/session.js";

const home = await mkdtemp(join(tmpdir(), "omp-pi-model-import-"));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, OMP_WEB_AGENT_DIR: process.env.OMP_WEB_AGENT_DIR };
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.OMP_WEB_AGENT_DIR;
const source = join(home, ".pi", "agent");
const target = join(home, ".omp", "agent");
const models = JSON.stringify({ providers: { legacy: {
	api: "openai-completions", baseUrl: "http://127.0.0.1:8999/v1", apiKey: "fixture-key",
	headers: { "X-Fixture": "fixture-header" },
	models: [
		{ id: "another-model", name: "Another model", contextWindow: 8192, maxTokens: 1024 },
		{ id: "legacy-model", name: "Legacy model", reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 1024 },
	],
} } });
const options = { agentDir: target, cwd: home };
const importModels = (agentDir = target) => runOmpAdmin("import_pi_models", { sourceDir: source }, { ...options, agentDir });
try {
	await mkdir(source, { recursive: true });
	await writeFile(join(source, "models.json"), models);
	await writeFile(join(source, "settings.json"), JSON.stringify({ defaultProvider: "legacy", defaultModel: "legacy-model" }));
	const runtime = await ModelRuntime.create();
	assert.ok((await runtime.getAvailable()).some(m => m.provider === "legacy" && m.id === "legacy-model"), "First startup must discover the Pi model without manual configuration");
	assert.equal(await readFile(join(source, "models.json"), "utf8"), models, "Pi config remains unchanged");
	assert.match(await readFile(join(target, "config.yml"), "utf8"), /legacy\/legacy-model/);
	const session = await AgentSession.create({ cwd: home, agentDir: target, modelRuntime: runtime, restricted: true, customTools: [] });
	try { assert.equal(session.model?.id, "legacy-model", "Native sessions select the imported default model"); }
	finally { await session.dispose(); }
	const auth = await runOmpAdmin("provider_auth", { provider: "legacy" }, options);
	assert.equal(auth.apiKey, "fixture-key");
	assert.equal(auth.headers["X-Fixture"], "fixture-header");
	assert.ok(!JSON.stringify(await runtime.getAvailable()).includes("fixture-header"));
	assert.ok(!JSON.stringify(await runtime.getAvailable()).includes("fixture-key"));
	if (process.platform !== "win32") assert.equal((await stat(join(target, "models.yml"))).mode & 0o777, 0o600);
	console.log("Pi model import: first startup discovers available models without changing Pi");

	// A custom profile must not silently pull credentials from the default home.
	const isolated = await ModelRuntime.create({ agentDir: join(home, "isolated") });
	assert.equal(isolated.getModels("legacy").length, 0);
	await rm(target, { recursive: true, force: true });
	process.env.OMP_WEB_AGENT_DIR = target;
	assert.equal((await ModelRuntime.create()).getModels("legacy").length, 0);
	await assert.rejects(readFile(join(target, "models.yml")), { code: "ENOENT" });
	delete process.env.OMP_WEB_AGENT_DIR;

	// Native validation rejects incompatible models and leaves setup usable.
	await writeFile(join(source, "models.json"), '{"providers":{"legacy":{"api":"not-a-real-api","apiKey":"must-not-leak"}}}');
	await assert.rejects(importModels(), error => !error.message.includes("must-not-leak"));
	assert.equal((await ModelRuntime.create()).getModels("legacy").length, 0);
	await assert.rejects(readFile(join(target, "models.yml")), { code: "ENOENT" });
	assert.ok(!(await readdir(target)).some(name => name.includes("-import-")));
	await writeFile(join(source, "models.json"), models);

	// Concurrent first clients import once; later starts preserve user edits/deletions.
	const imported = await Promise.all([importModels(), importModels()]);
	assert.equal(imported.filter(result => result.imported).length, 1);
	await writeFile(join(target, "models.yml"), "providers: {}\n");
	assert.equal((await ModelRuntime.create()).getModels("legacy").length, 0);
	assert.equal(await readFile(join(target, "models.yml"), "utf8"), "providers: {}\n");
	await rm(join(target, "models.yml"));
	await writeFile(join(target, "models.yaml"), "providers: {}\n");
	assert.equal((await importModels()).imported, false);
	await assert.rejects(readFile(join(target, "models.yml")), { code: "ENOENT" });
	await rm(join(target, "models.yaml"));

	// Only matching API-key credentials are copied; OAuth and unrelated settings stay put.
	const withAuth = JSON.parse(models);
	delete withAuth.providers.legacy.apiKey;
	await writeFile(join(source, "models.json"), JSON.stringify(withAuth));
	const credentials = JSON.stringify({ legacy: { type: "api_key", key: "auth-fixture" }, other: { type: "oauth", refresh: "do-not-copy" } });
	await writeFile(join(source, "auth.json"), credentials);
	await writeFile(join(target, "config.yml"), "modelRoles:\n  default: existing/model\n");
	assert.equal((await importModels()).imported, true);
	assert.equal((await runOmpAdmin("provider_auth", { provider: "legacy" }, options)).apiKey, "auth-fixture");
	assert.equal(await readFile(join(source, "auth.json"), "utf8"), credentials);
	assert.equal(await readFile(join(target, "config.yml"), "utf8"), "modelRoles:\n  default: existing/model\n");
	assert.ok(!(await readFile(join(target, "models.yml"), "utf8")).includes("do-not-copy"));
	await rm(join(target, "models.yml"));
	await rm(join(source, "models.json"));
	assert.equal((await importModels()).imported, false);
	console.log("Pi model import: isolation, validation, concurrency, existing config and API-key fallback passed");
} finally {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	await rm(home, { recursive: true, force: true });
}
