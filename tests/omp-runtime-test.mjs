import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpRpc } from "../dist/server/omp/rpc.js";
import { ompWorkerPath, ompRuntimePaths } from "../dist/server/omp/paths.js";

const dir = mkdtempSync(join(tmpdir(), "omp-runtime-"));
mkdirSync(join(dir, "agent"));
writeFileSync(join(dir, "agent", "models.yml"), JSON.stringify({ providers: { probe: { baseUrl: "http://127.0.0.1:8999/v1", api: "openai-completions", apiKey: "unused-probe-key", models: [{ id: "probe", name: "Probe", contextWindow: 8192, maxTokens: 1024 }] } } }));
const rpc = new OmpRpc({ cwd: dir, agentDir: join(dir, "agent"), args: ["--no-session", "--no-extensions", "--no-skills", "--provider", "probe", "--model", "probe"] });
try {
	await rpc.start();
	const state = await rpc.request("get_state");
	assert.equal(state.isSettled, true);
	assert.ok(state.sessionId);
	const { toolNames } = await rpc.request("set_host_tools", { tools: [{ name: "host_probe", description: "Probe host registration", parameters: { type: "object", properties: {} } }] });
	assert.ok(toolNames.includes("host_probe"));
	await rpc.request("set_subagent_subscription", { level: "events" });
	assert.ok(Array.isArray((await rpc.request("get_available_models")).models));
	assert.deepEqual((await rpc.request("get_messages")).messages, []);
	console.log("OMP runtime: protocol 2, state, native models and host tools passed");
} finally {
	await rpc.dispose();
	rmSync(dir, { recursive: true, force: true });
}

const clean = mkdtempSync(join(tmpdir(), "omp-unconfigured-"));
const worker = new OmpRpc({ cwd: clean, agentDir: join(clean, "agent"), executable: ompRuntimePaths().bun, entry: ompWorkerPath("bootstrap"), init: { cwd: clean, agentDir: join(clean, "agent"), sessionMode: "memory", restricted: true, tools: [] } });
try {
	await worker.start();
	assert.equal((await worker.request("get_state")).isSettled, true);
	const metadata = await worker.request("webui_metadata");
	assert.deepEqual(metadata.tools, []);
	assert.deepEqual(metadata.skills, []);
	for (let i = 0; i < 3; i++) {
		await worker.request("webui_metadata", {}, 10_000);
	}
	await worker.request("webui_active_tools", { names: [] }, 10_000);
	console.log("OMP bootstrap: unconfigured environment and remote-only tool isolation passed");
} finally { await worker.dispose(); rmSync(clean, { recursive: true, force: true }); }
