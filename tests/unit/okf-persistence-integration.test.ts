import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextIngestion, publishKnowledge, readCandidates, startIngestion, submitCandidates, type CandidateInput } from "../../server/okf/service.js";
import { privateDirectory } from "../../server/okf/storage.js";

let folder: string, cwd: string;
const producer = "pi-harness/persistence-fixture";
beforeEach(() => {
	folder = realpathSync(mkdtempSync(join(tmpdir(), "okf-persistence-")));
	cwd = join(folder, "workspace"); mkdirSync(cwd);
	vi.stubEnv("PI_WEB_DATA_DIR", join(folder, "data"));
	writeFileSync(join(cwd, "policy.md"), "Support operates on weekdays.\n\nSupport is closed on Saturday.\n");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(folder, { recursive: true, force: true }); });
async function ingest() {
	const job = await startIngestion({ cwd, inputPaths: ["policy.md"] });
	await nextIngestion({ cwd, jobId: job.jobId });
	return job.jobId;
}
async function submit(jobId: string, statement: string) {
	const evidence = await readCandidates({ cwd, jobId }), source = evidence.sources[0];
	const block = source.blocks.find(block => block.text.includes(statement))!;
	await submitCandidates({ cwd, jobId, sourceId: source.sourceId, producer, candidates: [{ conceptId: "support", title: "Support policy", type: "Policy", statement, evidence: [{ sourceId: source.sourceId, sourceHash: source.hash, blockId: block.id, quote: statement }], review: { support: "supported", rationale: "The complete fixture states this directly; the existing support concept was compared.", comparedConceptIds: evidence.existingConcepts.map(concept => concept.id), conflicts: [] } }] });
}

describe("OKF transaction integration with the Markdown-only intake", () => {
	it("uses the committed receipt after interruption before the published job checkpoint", async () => {
		const jobId = await ingest();
		await submit(jobId, "Support operates on weekdays.");
		const jobFile = join(privateDirectory(cwd), `${jobId}.json`), beforePublish = readFileSync(jobFile, "utf8");
		const published = await publishKnowledge({ cwd, jobId, producer });
		const manifestPath = join(cwd, "knowledge/manifest.json"), manifest = readFileSync(manifestPath, "utf8");
		const index = readFileSync(published!.indexPath, "utf8"), report = readFileSync(published!.reportPath, "utf8");
		// The file transaction is durable, but the private job checkpoint was not saved.
		writeFileSync(jobFile, beforePublish);
		expect(await publishKnowledge({ cwd, jobId, producer })).toEqual(published);
		expect(readFileSync(manifestPath, "utf8")).toBe(manifest);
		expect(readFileSync(published!.indexPath, "utf8")).toBe(index);
		expect(readFileSync(published!.reportPath, "utf8")).toBe(report);
		expect(JSON.parse(readFileSync(jobFile, "utf8")).state).toBe("published");
	});

	it("preserves a concept updated by another job and writes a draft proposal", async () => {
		const initial = await ingest();
		await submit(initial, "Support operates on weekdays.");
		await publishKnowledge({ cwd, jobId: initial, producer });
		const first = await ingest(), second = await ingest();
		await submit(first, "Support is closed on Saturday.");
		await submit(second, "Support operates on weekdays.");
		await publishKnowledge({ cwd, jobId: first, producer });
		const path = join(cwd, "knowledge/wiki/concepts/support.md"), committed = readFileSync(path, "utf8");
		const later = await publishKnowledge({ cwd, jobId: second, producer });
		expect(readFileSync(path, "utf8")).toBe(committed);
		expect(later?.protected).toContain("wiki/concepts/support.md");
		expect(later?.proposals).toHaveLength(1);
		expect(readFileSync(join(cwd, "knowledge", later!.proposals[0]), "utf8")).toContain("status: draft");
		expect(later?.stable).not.toContain("support");
	});

	it("reports explicitly rejected candidates without creating new knowledge and preserves withdrawn old evidence as draft", async () => {
		const reject = async (jobId: string) => {
			const review = await readCandidates({ cwd, jobId }), source = review.sources[0], block = source.blocks.find(block => block.text.includes("Support operates on weekdays."))!;
			await submitCandidates({ cwd, jobId, sourceId: source.sourceId, producer, candidates: [{ conceptId: "support", title: "Support policy", type: "Policy", statement: "Support operates continuously.", evidence: [{ sourceId: source.sourceId, sourceHash: source.hash, blockId: block.id, quote: "Support operates on weekdays." }], review: { support: "unsupported", rationale: "The source states weekdays, which does not support continuous operation.", comparedConceptIds: review.existingConcepts.map(concept => concept.id), conflicts: [] } }] });
		};
		const first = await ingest(); await reject(first);
		const rejected = await publishKnowledge({ cwd, jobId: first, producer });
		expect(rejected?.stable).toEqual([]); expect(rejected?.draft).toEqual([]);
		const path = join(cwd, "knowledge/wiki/concepts/support.md");
		expect(existsSync(path)).toBe(false);
		expect(readFileSync(rejected!.reportPath, "utf8")).toContain("Rejected unsupported candidates (1)");
		const report = JSON.parse(readFileSync(rejected!.reportPath.replace(/\.md$/, ".json"), "utf8"));
		expect(report.rejectedCandidates).toHaveLength(1);
		expect(report.rejectedCandidates[0]).toMatchObject({ conceptId: "support", statement: "Support operates continuously.", rationale: "The source states weekdays, which does not support continuous operation." });
		const accepted = await ingest(); await submit(accepted, "Support operates on weekdays."); await publishKnowledge({ cwd, jobId: accepted, producer });
		const later = await ingest(); await reject(later);
		const withdrawn = await publishKnowledge({ cwd, jobId: later, producer });
		expect(withdrawn?.draft).toContain("support");
		expect(readFileSync(path, "utf8")).toContain("Support operates on weekdays.");
		expect(readFileSync(path, "utf8")).not.toContain("Support operates continuously.");
	});

	it("keeps separate proposals for concept IDs whose flattened names collide", async () => {
		const ids = ["a/b", "a--b"];
		const submitBoth = async (jobId: string) => {
			const review = await readCandidates({ cwd, jobId }), source = review.sources[0], block = source.blocks.find(block => block.text.includes("Support operates on weekdays."))!;
			const candidates: CandidateInput[] = ids.map(conceptId => ({ conceptId, title: `Policy ${conceptId}`, type: "Policy", statement: "Support operates on weekdays.", evidence: [{ sourceId: source.sourceId, sourceHash: source.hash, blockId: block.id, quote: "Support operates on weekdays." }], review: { support: "supported", rationale: "Source directly states the claim; both existing concepts were compared.", comparedConceptIds: review.existingConcepts.map(concept => concept.id), conflicts: [] } }));
			await submitCandidates({ cwd, jobId, sourceId: source.sourceId, candidates, producer });
		};
		const first = await ingest(); await submitBoth(first); await publishKnowledge({ cwd, jobId: first, producer });
		for (const id of ids) writeFileSync(join(cwd, "knowledge/wiki/concepts", `${id}.md`), `Manual edit ${id}`);
		const later = await ingest(); await submitBoth(later);
		const published = await publishKnowledge({ cwd, jobId: later, producer });
		expect(published?.proposals).toHaveLength(2);
		expect(new Set(published?.proposals).size).toBe(2);
		for (const id of ids) expect(readFileSync(join(cwd, "knowledge/wiki/concepts", `${id}.md`), "utf8")).toBe(`Manual edit ${id}`);
		const proposals = published!.proposals.map(path => readFileSync(join(cwd, "knowledge", path), "utf8"));
		for (const id of ids) expect(proposals.some(text => text.includes(`title: "Policy ${id}"`) && text.includes("status: draft"))).toBe(true);
	});

	it("refreshes an explicitly selected deleted registered file while unknown missing paths abort the whole scan", async () => {
		const first = await ingest(); await submit(first, "Support operates on weekdays."); await publishKnowledge({ cwd, jobId: first, producer });
		const manifestPath = join(cwd, "knowledge/manifest.json"), before = readFileSync(manifestPath, "utf8");
		rmSync(join(cwd, "policy.md"));
		await expect(startIngestion({ cwd, inputPaths: ["policy.md", "unknown.md"] })).rejects.toThrow(/ENOENT/);
		expect(readFileSync(manifestPath, "utf8")).toBe(before);
		const refreshed = await startIngestion({ cwd, inputPaths: ["policy.md"] });
		expect(refreshed.sourceCount).toBe(0);
		expect(refreshed.warnings).toContain(`Registered source is missing: ${join(cwd, "policy.md")}`);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const source = manifest.sources[Object.keys(manifest.sources)[0]];
		expect(source.state).toBe("missing");
		expect(readFileSync(join(cwd, "knowledge", source.versions[source.latestHash].originalPath), "utf8")).toContain("Support operates on weekdays.");
		expect(manifest.concepts.support.status).toBe("draft");
		expect(readFileSync(join(cwd, "knowledge/wiki/concepts/support.md"), "utf8")).toContain("status: draft");
	});
});
