#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, reportConfig } from "./config.mjs";
import { snapshotSources, readSnapshotBytes } from "./corpus.mjs";
import { evaluateAnswer, summarize } from "./evaluate.mjs";

const HELP = `Local engineering context evaluation (development only)

node dev/context-eval/index.mjs snapshot --config <json> --out <new-directory>
node dev/context-eval/index.mjs doctor --config <json>
node dev/context-eval/index.mjs run --config <json> --out <new-directory> [--arm baseline|openviking|both]

snapshot: copy only declared files and record original hashes/version metadata.
doctor: check explicit endpoints/configuration; no corpus is sent.
run: isolated Pi sessions with local endpoint or model.fromPi=true; saves local evidence.

Reports contain source quotations. Use .context-eval/ or another private ignored directory.
Endpoint validation does not prove OpenViking/model subprocesses have no outbound network.
`;

async function writeJson(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
}

async function jsonRequest(url, headers = {}) {
	const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(5000) });
	if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
	let text = "";
	for await (const chunk of response.body) {
		text += Buffer.from(chunk).toString("utf8");
		if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Response exceeds 1 MiB");
	}
	return JSON.parse(text);
}

export async function doctor(config) {
	const checks = [];
	if (config.model.fromPi) {
		checks.push({ name: "model", ok: true, provider: config.model.provider, model: config.model.id, endpoint: config.model.baseUrl, validation: "native_configuration_and_credentials_only", requestNotSent: true });
	} else try {
		const models = await jsonRequest(`${config.model.baseUrl}/models`);
		if (!Array.isArray(models.data) || !models.data.some((model) => model.id === config.model.id)) throw new Error("Configured model is not advertised by /models");
		checks.push({ name: "model", ok: true, model: config.model.id });
	} catch (error) { checks.push({ name: "model", ok: false, error: error.message }); }
	if (config.openviking) {
		try {
			const url = new URL("/health", config.openviking.url);
			const headers = config.openviking.apiKey ? { "X-API-Key": config.openviking.apiKey } : {};
			const health = await jsonRequest(url, headers);
			if (health.status !== "ok" && health.status !== "healthy") throw new Error("OpenViking health is not ready");
			if (health.version && health.version !== config.openviking.version) throw new Error("OpenViking health version differs from configured version");
			checks.push({ name: "openviking", ok: true, versionCheck: health.version ? "matched" : "not_reported_by_server" });
		} catch (error) { checks.push({ name: "openviking", ok: false, error: error.message }); }
	}
	return { ok: checks.every((check) => check.ok), checks, modelTransport: config.model.fromPi ? "explicit_pi_provider" : "loopback", backendEgress: "not_verified", indexFreshness: "not_verified" };
}

async function exportSnapshot(config, corpus, output) {
	await mkdir(dirname(output), { recursive: true, mode: 0o700 });
	await mkdir(output, { mode: 0o700 });
	for (const document of corpus.documents) {
		const source = corpus.sources.find((item) => item.id === document.sourceId);
		const { bytes: data } = await readSnapshotBytes(corpus, document);
		const target = join(output, "sources", source.id, document.path);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await writeFile(target, data, { flag: "wx", mode: 0o600 });
	}
	await writeJson(join(output, "corpus.json"), { capturedAt: new Date().toISOString(), ...corpus });
	await writeJson(join(output, "config-summary.json"), reportConfig(config));
	await writeJson(join(output, "ingest-manifest.json"), {
		indexState: "not_imported",
		sources: corpus.sources.map((source) => ({ id: source.id, kind: source.kind, directory: `sources/${source.id}`, vikingUri: source.vikingUri ?? null })),
		instruction: "Import these staged directories into your local OpenViking service. Record completion/version separately; this export does not claim the index is fresh.",
	});
}

export async function runEvaluation(config, corpus, output, arm, runner) {
	if (arm !== "baseline" && !config.openviking) throw new Error("openviking config is required for this arm");
	if (arm !== "baseline" && corpus.sources.some((source) => !source.vikingUri)) throw new Error("Every source needs a vikingUri for the OpenViking arm");
	await mkdir(dirname(output), { recursive: true, mode: 0o700 });
	await mkdir(output, { mode: 0o700 });
	await writeJson(join(output, "corpus.json"), { capturedAt: new Date().toISOString(), ...corpus });
	await writeJson(join(output, "questions.json"), config.questions);
	const samples = [];
	const plannedSamples = config.questions.length * (arm === "both" ? 2 : 1);
	const evidenceChecksPassed = () => samples.length === plannedSamples && samples.every((sample) => !sample.error && sample.evaluation.evidenceChecksPassed);
	const controller = new AbortController();
	const interrupt = () => controller.abort(new Error("Evaluation interrupted"));
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	try {
		for (const [index, question] of config.questions.entries()) {
			// Alternate order to reduce systematic model warmup/order bias. Never run models concurrently.
			const arms = arm === "both" ? (index % 2 ? ["openviking", "baseline"] : ["baseline", "openviking"]) : [arm];
			for (const selected of arms) {
				if (controller.signal.aborted) throw controller.signal.reason;
				process.stderr.write(`${question.id}: ${selected}\n`);
				const started = performance.now();
				let sample = { questionId: question.id, arm: selected, expectedEvidenceCount: question.expectedEvidence.length };
				try {
					const run = await runner(config, { arm: selected, question, corpus, signal: controller.signal });
					if (run.error) throw new Error(run.error);
					sample = { ...sample, ...run, evaluation: await evaluateAnswer(run.answer, question, corpus) };
				} catch (error) {
					sample = { ...sample, durationMs: performance.now() - started, ...error.result, error: error.message };
				}
				samples.push(sample);
				await writeJson(join(output, `${question.id}.${selected}.json`), sample);
			}
		}
	} finally {
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", interrupt);
		await writeJson(join(output, "report.json"), {
			createdAt: new Date().toISOString(), config: reportConfig(config),
			node: process.version, sdk: "1.0.4", interrupted: controller.signal.aborted,
			completedSamples: samples.length, plannedSamples, evidenceChecksPassed: evidenceChecksPassed(),
			summary: summarize(samples), humanCorrectness: "ungraded", promotionDecision: "pending_real_data_and_human_review",
			backendEgress: "not_verified", indexFreshness: arm === "baseline" ? "not_applicable" : "not_verified",
			comparisonEligibility: arm === "baseline" ? "no_comparison" : "requires_backend_inventory_verification",
			corpusScope: { baseline: "staged_file_allowlist", openviking: "registered_uri_prefixes_only" },
			memoryMeasurement: "runner process only; excludes local model and OpenViking service",
		});
	}
	return evidenceChecksPassed();
}

export async function main(args = process.argv.slice(2)) {
	if (!args.length || args.includes("--help")) { console.log(HELP); return; }
	const [command, ...rest] = args;
	if (!["snapshot", "doctor", "run"].includes(command)) throw new Error("Unknown command; use --help");
	const options = {};
	for (let i = 0; i < rest.length; i += 2) {
		if (!["--config", "--out", "--arm"].includes(rest[i]) || !rest[i + 1] || options[rest[i]]) throw new Error("Invalid or duplicate CLI option; use --help");
		options[rest[i]] = rest[i + 1];
	}
	if (!options["--config"]) throw new Error("--config is required");
	const config = await loadConfig(options["--config"]);
	if (command === "doctor") {
		const result = await doctor(config);
		console.log(JSON.stringify(result, null, "\t"));
		if (!result.ok) process.exitCode = 1;
		return;
	}
	if (!options["--out"]) throw new Error("--out must be a new private directory");
	const output = resolve(options["--out"]);
	const corpus = await snapshotSources(config.sources, config.baseDir);
	if (command === "snapshot") await exportSnapshot(config, corpus, output);
	else {
		const arm = options["--arm"] ?? "both";
		if (!["baseline", "openviking", "both"].includes(arm)) throw new Error("--arm must be baseline, openviking or both");
		const { runQuestion } = await import("./session.mjs");
		if (!await runEvaluation(config, corpus, output, arm, runQuestion)) process.exitCode = 1;
	}
	console.log(`Saved local evaluation artifacts: ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
