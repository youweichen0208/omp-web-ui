import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, loopbackUrl, reportConfig } from "../dev/context-eval/config.mjs";
import { snapshotSources } from "../dev/context-eval/corpus.mjs";
import { evaluateAnswer, parseAnswer, summarize } from "../dev/context-eval/evaluate.mjs";
import { doctor, main, runEvaluation } from "../dev/context-eval/index.mjs";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "pi-context-eval-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "source"));
	await writeFile(join(root, "source", "guide.md"), "# Guide\nsettled means complete\n");
	const data = {
		version: 1, model: { baseUrl: "http://127.0.0.1:11434/v1", id: "local-test-model" },
		openviking: { url: "http://127.0.0.1:1933/mcp", version: "fixture", apiKeyEnv: "TEST_CONTEXT_KEY" },
		sources: [{ id: "guide", kind: "reference", root: "source", files: ["guide.md"], vikingUri: "viking://resources/guide" }],
		questions: [{ id: "settled", prompt: "When is the task complete?", expectedEvidence: [{ sourceId: "guide", path: "guide.md" }] }],
	};
	const configPath = join(root, "config.json");
	await writeFile(configPath, JSON.stringify(data));
	const config = await loadConfig(configPath, { TEST_CONTEXT_KEY: "test-secret" });
	const corpus = await snapshotSources(config.sources, config.baseDir);
	return { root, data, configPath, config, corpus };
}

function validAnswer(extra = {}) {
	return JSON.stringify({
		answer: "The task is complete when settled.", insufficientEvidence: false,
		evidence: [{ sourceId: "guide", path: "guide.md", lineStart: 2, lineEnd: 2, quote: "settled means complete" }],
		...extra,
	});
}

async function listen(t, handler) {
	const server = createServer(handler);
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	assert(server.address().port >= 8900);
	t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
	return `http://127.0.0.1:${server.address().port}`;
}

test("config pins loopback endpoints, resolves corpus relative to config, and redacts credentials", async (t) => {
	const { config, corpus } = await fixture(t);
	assert.equal(config.openviking.apiKey, "test-secret");
	assert(!JSON.stringify(reportConfig(config)).includes("test-secret"));
	assert.equal(corpus.documents.length, 1);
	for (const url of ["https://api.example.com/v1", "http://localhost:8000", "http://10.0.0.1/v1", "http://127.0.0.1/?key=secret", "http://secret@127.0.0.1/"]) {
		assert.throws(() => loopbackUrl(url, "test"), /loopback|127\.0\.0\.1/);
	}
	assert.equal(loopbackUrl("http://[::1]:8000/v1/", "test"), "http://[::1]:8000/v1");
});

test("config rejects duplicate questions and evidence outside explicit allowlists", async (t) => {
	const { data, configPath } = await fixture(t);
	data.questions.push(data.questions[0]);
	await writeFile(configPath, JSON.stringify(data));
	await assert.rejects(loadConfig(configPath), /duplicate question/);
	data.questions.pop();
	data.questions[0].expectedEvidence[0].path = "private.md";
	await writeFile(configPath, JSON.stringify(data));
	await assert.rejects(loadConfig(configPath), /allowlist/);
});

test("citation checks reject invented quotes, unknown sources, invalid ranges and stale content", async (t) => {
	const { config, corpus, root } = await fixture(t);
	const question = config.questions[0];
	const good = await evaluateAnswer(validAnswer(), question, corpus);
	assert.equal(good.validCitations, 1);
	assert.equal(good.expectedFileCoverage, 1);
	assert.equal(good.humanCorrectness, "ungraded");
	for (const changed of [{ quote: "invented fact" }, { sourceId: "other" }, { lineEnd: 999 }, { lineStart: undefined }]) {
		const answer = JSON.parse(validAnswer());
		Object.assign(answer.evidence[0], changed);
		const result = await evaluateAnswer(JSON.stringify(answer), question, corpus);
		assert.equal(result.invalidCitations, 1);
		assert.equal(result.expectedFileCoverage, 0);
	}
	await writeFile(join(root, "source", "guide.md"), "changed\n");
	assert.equal((await evaluateAnswer(validAnswer(), question, corpus)).invalidCitations, 1);
	assert.equal((await evaluateAnswer("I think so", question, corpus)).formatValid, false);
	assert.throws(() => parseAnswer('{}'), /Expected JSON/);
});

test("paired evaluation alternates order, records errors, and keeps failed questions in coverage denominator", async (t) => {
	const { config, corpus, root } = await fixture(t);
	config.questions.push({ ...config.questions[0], id: "second" });
	const order = [];
	const runner = async (_config, input) => {
		order.push(`${input.question.id}:${input.arm}`);
		if (input.question.id === "second" && input.arm === "openviking") throw new Error("MCP unavailable");
		return { answer: validAnswer(), durationMs: input.question.id === "second" ? 15 : 5, usage: { totalTokens: 12 }, toolCalls: [] };
	};
	const out = join(root, "result");
	assert.equal(await runEvaluation(config, corpus, out, "both", runner), false);
	assert.deepEqual(order, ["settled:baseline", "settled:openviking", "second:openviking", "second:baseline"]);
	const reportText = await readFile(join(out, "report.json"), "utf8");
	const report = JSON.parse(reportText);
	assert(!reportText.includes("test-secret"));
	assert.equal(report.summary.openviking.errors, 1);
	assert.equal(report.summary.openviking.expectedFileCoverage, 0.5);
	assert.equal(report.summary.baseline.medianDurationMs, 10);
	assert.equal(report.summary.openviking.questionsUsingMcp, 0);
	assert.equal(report.summary.openviking.successfulMcpCalls, 0);
	assert.equal(report.backendEgress, "not_verified");
	assert.equal(report.comparisonEligibility, "requires_backend_inventory_verification");
	assert.equal(report.promotionDecision, "pending_real_data_and_human_review");
	await assert.rejects(runEvaluation(config, corpus, out, "both", runner), /EEXIST/);
});

test("snapshot command exports only selected bytes and metadata, never API keys", async (t) => {
	const { configPath, root } = await fixture(t);
	await writeFile(join(root, "source", "not-selected.md"), "not part of evaluation");
	const out = join(root, "nested", "export");
	await main(["snapshot", "--config", configPath, "--out", out]);
	assert.equal(await readFile(join(out, "sources", "guide", "guide.md"), "utf8"), "# Guide\nsettled means complete\n");
	await assert.rejects(readFile(join(out, "sources", "guide", "not-selected.md")), /ENOENT/);
	assert.equal(JSON.parse(await readFile(join(out, "ingest-manifest.json"))).indexState, "not_imported");
	await assert.rejects(main(["snapshot", "--config", configPath, "--out", out]), /EEXIST/);
});

test("run fails missing required evidence or a wrong insufficiency claim while preserving scores", async (t) => {
	const { config, corpus, root } = await fixture(t);
	for (const [id, answer, expected] of [
		["unsupported", validAnswer({ evidence: [] }), false],
		["wrong-insufficiency", validAnswer({ insufficientEvidence: true }), false],
		["supported", validAnswer(), true],
	]) {
		const out = join(root, id);
		assert.equal(await runEvaluation(config, corpus, out, "baseline", async () => ({ answer, durationMs: 5 })), expected);
		const report = JSON.parse(await readFile(join(out, "report.json")));
		assert.equal(report.evidenceChecksPassed, expected);
		assert.equal(report.summary.baseline.evidenceChecksPassed, Number(expected));
		assert.equal(report.humanCorrectness, "ungraded");
	}
	config.questions[0] = { ...config.questions[0], expectedEvidence: [], expectInsufficient: true };
	assert.equal(await runEvaluation(config, corpus, join(root, "correct-insufficiency"), "baseline", async () => ({ answer: validAnswer({ insufficientEvidence: true, evidence: [] }), durationMs: 5 })), true);
});

test("doctor only probes endpoints and refuses redirects before contacting a destination", async (t) => {
	const { config } = await fixture(t);
	let destinationCalls = 0;
	const destination = await listen(t, (_request, response) => { destinationCalls++; response.end('{}'); });
	const origin = await listen(t, (request, response) => {
		if (request.url === "/health") { response.setHeader("Content-Type", "application/json"); response.end('{"status":"ok"}'); }
		else { response.writeHead(302, { Location: destination }); response.end(); }
	});
	config.model.baseUrl = origin;
	config.openviking.url = `${origin}/mcp`;
	const result = await doctor(config);
	assert.equal(result.ok, false);
	assert.equal(result.checks[0].ok, false);
	assert.equal(result.checks[1].ok, true);
	assert.equal(result.checks[1].versionCheck, "not_reported_by_server");
	assert.equal(destinationCalls, 0);
});

test("a model reporting insufficient evidence is distinguishable from valid supported conclusions", async (t) => {
	const { corpus } = await fixture(t);
	const question = { expectedEvidence: [], expectInsufficient: true };
	const score = await evaluateAnswer(validAnswer({ insufficientEvidence: true, evidence: [] }), question, corpus);
	assert.equal(score.insufficiencyMatches, true);
	assert.equal(score.expectedFileCoverage, null);
	assert.deepEqual(summarize([]), {});
});

test("MCP availability is distinguished from attempted and successful retrieval", () => {
	const summary = summarize([
		{ arm: "openviking", expectedEvidenceCount: 1, error: "timeout", toolCalls: [{ name: "mcp__openviking__find", isError: false }, { name: "mcp__openviking__read", blocked: true }] },
		{ arm: "openviking", expectedEvidenceCount: 1, error: "invalid output", toolCalls: [{ name: "read", isError: false }] },
	]).openviking;
	assert.equal(summary.questions, 2);
	assert.equal(summary.questionsUsingMcp, 1);
	assert.equal(summary.mcpCalls, 2);
	assert.equal(summary.successfulMcpCalls, 1);
});
