import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { digest, privateDirectory, recoverTransaction, withKnowledgeLock } from "../../server/okf/storage.js";
import { getIngestionStatus, nextIngestion, publishKnowledge, readCandidates, startIngestion, submitCandidates, type CandidateInput } from "../../server/okf/service.js";
import type { KnowledgeManifest } from "../../server/okf/types.js";
import { saveUpload } from "../../server/uploads.js";

const converter = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("../../server/document-conversion/service.js", () => ({
	DOCUMENT_EXTENSIONS: new Set([".txt", ".md", ".pdf", ".docx", ".xlsx", ".pptx"]),
	convertDocument: async ({ inputPath, outputDir, signal }: { inputPath: string; outputDir: string; signal?: AbortSignal }) => {
		converter.calls++;
		signal?.throwIfAborted();
		const text = readFileSync(inputPath, "utf8");
		if (converter.fail || text.startsWith("FAIL")) throw new Error("Parser could not read this source");
		if (existsSync(outputDir) && readdirSync(outputDir).some(name => !["document.md", "structure.json", "source-map.json"].includes(name))) throw new Error("Conversion output has added files");
		mkdirSync(outputDir, { recursive: true });
		const blocks = text.split("\n\n").map((text, index) => ({ id: `block-${index + 1}`, text, locator: { page: index + 1 } }));
		const markdownPath = join(outputDir, "document.md");
		writeFileSync(markdownPath, text);
		writeFileSync(join(outputDir, "structure.json"), JSON.stringify({ blocks }));
		writeFileSync(join(outputDir, "source-map.json"), JSON.stringify({ blocks }));
		return { markdownPath, structurePath: join(outputDir, "structure.json"), sourceMapPath: join(outputDir, "source-map.json"), assetsDir: join(outputDir, "assets"), sourceHash: digest(text), parserVersion: "fixture-1", warnings: text.startsWith("PARTIAL") ? ["Unreadable content"] : text.startsWith("ADVISORY") ? ["Review code indentation"] : [], status: text.startsWith("PARTIAL") ? "partial" : "complete", blocks };
	},
}));

let folder: string;
let cwd: string;
let raw: string;
const producer = "pi-harness/test";
beforeEach(() => {
	folder = realpathSync(mkdtempSync(join(tmpdir(), "okf-unit-")));
	cwd = join(folder, "workspace");
	raw = join(cwd, "raw");
	mkdirSync(raw, { recursive: true });
	vi.stubEnv("PI_WEB_DATA_DIR", join(folder, "runtime"));
	converter.fail = false;
	converter.calls = 0;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(folder, { recursive: true, force: true }); });

function writeSource(name: string, text: string): string {
	const path = join(raw, name);
	writeFileSync(path, text);
	return path;
}
async function ingest(outputDir?: string) {
	const started = await startIngestion({ cwd, inputPaths: ["raw"], outputDir });
	let result = started;
	while (result.sources.some(source => source.state === "pending")) result = await nextIngestion({ cwd, jobId: result.jobId });
	return result;
}
async function candidate(jobId: string, sourceId?: string, conceptId = "policies/refunds"): Promise<{ sourceId: string; candidate: CandidateInput }> {
	const read = await readCandidates({ cwd, jobId, sourceId });
	const source = read.sources[0];
	return { sourceId: source.sourceId, candidate: { conceptId, title: "Refund policy", type: "Policy", statement: source.blocks[0].text, evidence: [{ sourceId: source.sourceId, sourceHash: source.hash, blockId: source.blocks[0].id, quote: source.blocks[0].text }], review: { support: "supported", rationale: "Read the full policy and compared its scope with existing concepts.", comparedConceptIds: read.existingConcepts.map(concept => concept.id), conflicts: [] } } };
}
async function submit(jobId: string, sourceId?: string, conceptId?: string) {
	const result = await candidate(jobId, sourceId, conceptId);
	await submitCandidates({ cwd, jobId, ...result, candidates: [result.candidate], producer });
	return result;
}
function manifest(outputDir = "knowledge"): KnowledgeManifest { return JSON.parse(readFileSync(join(cwd, outputDir, "manifest.json"), "utf8")); }

describe("persistent OKF ingestion", () => {
	test("archives explicitly selected chat attachments while broad scans exclude runtime data", async () => {
		const upload = saveUpload("attachment-client", "company.md", Buffer.from("# Company\n\nThe support team responds within one day."));
		const runtimeOnly = join(folder, "runtime", "private-notes.md");
		writeFileSync(runtimeOnly, "Internal runtime content must not become knowledge.");
		const started = await startIngestion({ cwd, inputPaths: [upload.abs] });
		expect(started.sourceCount).toBe(1);
		const normalized = await nextIngestion({ cwd, jobId: started.jobId });
		expect(normalized.sourceCounts.complete).toBe(1);
		const source = Object.values(manifest().sources)[0];
		expect(source.inputPath).toBe(upload.abs);
		expect(readFileSync(join(cwd, "knowledge", source.versions[source.latestHash].originalPath), "utf8")).toContain("The support team responds within one day.");

		writeSource("public.txt", "A separate explicitly scanned source.");
		const broad = await startIngestion({ cwd, inputPaths: [folder] });
		expect(broad.sourceCount).toBe(1);
		expect(broad.sources[0].path).toBe(join(raw, "public.txt"));
		expect(broad.warnings.some(warning => warning.includes("Skipped document runtime data"))).toBe(true);
		expect(manifest().sources[source.id].state).toBe("current");
		const privateSelection = await startIngestion({ cwd, inputPaths: [runtimeOnly, join(folder, "runtime", "uploads")] });
		expect(privateSelection.sourceCount).toBe(0);
		expect(manifest().sources[source.id].state).toBe("current");
	});

	test("archives every source, emits standard frontmatter and relative evidence, and resumes idempotently", async () => {
		writeSource("policy.txt", "Refunds are available within 30 days.");
		writeSource("empty-of-knowledge.md", "A cover page.");
		const job = await ingest();
		const policy = job.sources.find(source => source.path?.endsWith("policy.txt"))!;
		await submit(job.jobId, policy.sourceId);
		for (const source of job.sources.filter(source => source !== policy)) await submitCandidates({ cwd, jobId: job.jobId, sourceId: source.sourceId, candidates: [], producer });
		const published = await publishKnowledge({ cwd, jobId: job.jobId, producer });
		expect(published?.stable).toEqual(["policies/refunds"]);
		expect(await publishKnowledge({ cwd, jobId: job.jobId, producer })).toEqual(published);
		const state = manifest();
		expect(state).toMatchObject({ kind: "pi-harness-knowledge", version: 1, evidenceDirectory: "evidence" });
		expect(Object.values(state.sources)).toHaveLength(2);
		for (const source of Object.values(state.sources)) expect(readFileSync(join(cwd, "knowledge", source.versions[source.latestHash].originalPath), "utf8")).toBe(readFileSync(source.inputPath, "utf8"));
		const page = readFileSync(join(cwd, "knowledge/wiki/concepts/policies/refunds.md"), "utf8");
		expect(page).toContain("status: stable");
		expect(page).toContain("description:");
		expect(page).toContain("../../references/");
		expect(page).not.toContain("verified:");
		expect(readFileSync(join(cwd, "knowledge/wiki/index.md"), "utf8")).toContain('okf_version: "0.2"');
		expect(readFileSync(join(cwd, "knowledge/wiki/log.md"), "utf8")).toContain(job.jobId);
		expect(readFileSync(published!.reportPath, "utf8")).toContain("# Knowledge ingestion report");
		expect(privateDirectory(cwd).startsWith(cwd)).toBe(false);
		const oldBytes = page;
		const repeated = await ingest();
		const repeatedPolicy = repeated.sources.find(source => source.sourceId === policy.sourceId)!;
		await submit(repeated.jobId, repeatedPolicy.sourceId);
		for (const source of repeated.sources.filter(source => source !== repeatedPolicy)) await submitCandidates({ cwd, jobId: repeated.jobId, sourceId: source.sourceId, candidates: [], producer });
		await publishKnowledge({ cwd, jobId: repeated.jobId, producer });
		expect(readFileSync(join(cwd, "knowledge/wiki/concepts/policies/refunds.md"), "utf8")).toBe(oldBytes);
		expect(Object.values(manifest().sources)).toHaveLength(2);
	});

	test("requires the complete batch to normalize and every readable source to be reviewed", async () => {
		writeSource("a.txt", "A fact");
		writeSource("b.txt", "Another fact");
		const started = await startIngestion({ cwd, inputPaths: ["raw"] });
		await nextIngestion({ cwd, jobId: started.jobId });
		const item = await candidate(started.jobId);
		await expect(submitCandidates({ cwd, jobId: started.jobId, sourceId: item.sourceId, candidates: [item.candidate], producer })).rejects.toThrow("complete selected batch");
		await nextIngestion({ cwd, jobId: started.jobId });
		await submit(started.jobId, item.sourceId);
		await expect(publishKnowledge({ cwd, jobId: started.jobId, producer })).rejects.toThrow("every readable source");
	});

	test("does not equate quotes with truth; uncertain support stays draft and unknown verification is discarded", async () => {
		writeSource("policy.txt", "The trial does not promise 99.9% availability.");
		const job = await ingest();
		const item = await candidate(job.jobId);
		item.candidate.statement = "The trial promises 99.9% availability.";
		item.candidate.review.support = "uncertain";
		const supplied = { ...item.candidate, verified: { by: "human:fake" }, generated: { by: "human:fake" } };
		await submitCandidates({ cwd, jobId: job.jobId, sourceId: item.sourceId, candidates: [supplied], producer });
		expect((await publishKnowledge({ cwd, jobId: job.jobId, producer }))?.draft).toEqual(["policies/refunds"]);
		const text = readFileSync(join(cwd, "knowledge/wiki/concepts/policies/refunds.md"), "utf8");
		expect(text).not.toContain("human:fake");
		expect(text).not.toContain("verified:");
	});

	test("rejects forged evidence, unsafe paths, and human producer identities", async () => {
		writeSource("policy.txt", "Source evidence.");
		const job = await ingest();
		const item = await candidate(job.jobId);
		const call = (candidate: CandidateInput, author = producer) => submitCandidates({ cwd, jobId: job.jobId, sourceId: item.sourceId, candidates: [candidate], producer: author });
		await expect(call({ ...item.candidate, evidence: [{ ...item.candidate.evidence[0], quote: "Invented" }] })).rejects.toThrow("does not match");
		for (const conceptId of ["../escape", "a/index", "references/source", "con", "a/nul", "lpt1"]) await expect(call({ ...item.candidate, conceptId })).rejects.toThrow();
		await expect(call(item.candidate, "human:pretend")).rejects.toThrow("producer");
	});

	test("source changes invalidate stable knowledge while retaining immutable previous evidence", async () => {
		const original = writeSource("policy.txt", "Refunds within 30 days.");
		const first = await ingest();
		await submit(first.jobId);
		await publishKnowledge({ cwd, jobId: first.jobId, producer });
		writeFileSync(original, "Refunds within 14 days.");
		const second = await startIngestion({ cwd, inputPaths: ["raw"] });
		expect(second.sources[0].sourceId).toBe(first.sources[0].sourceId);
		expect(manifest().concepts["policies/refunds"].status).toBe("draft");
		expect(readFileSync(join(cwd, "knowledge/wiki/concepts/policies/refunds.md"), "utf8")).toContain("status: draft");
		expect(Object.keys(Object.values(manifest().sources)[0].versions)).toHaveLength(2);
	});

	test("detects a raw file changed after review, before stable publication", async () => {
		const path = writeSource("policy.txt", "Original fact");
		const job = await ingest();
		await submit(job.jobId);
		writeFileSync(path, "Changed fact");
		await expect(publishKnowledge({ cwd, jobId: job.jobId, producer })).rejects.toThrow("changed after");
		expect(Object.values(manifest().sources)[0].state).toBe("changed");
	});

	test("deleted sources are retained as evidence and invalidate dependent concepts", async () => {
		const path = writeSource("policy.txt", "Original fact");
		const job = await ingest();
		await submit(job.jobId);
		await publishKnowledge({ cwd, jobId: job.jobId, producer });
		rmSync(path);
		await startIngestion({ cwd, inputPaths: ["raw"] });
		const source = Object.values(manifest().sources)[0];
		expect(source.state).toBe("missing");
		expect(readFileSync(join(cwd, "knowledge", source.versions[source.latestHash].originalPath), "utf8")).toBe("Original fact");
		expect(manifest().concepts["policies/refunds"].status).toBe("draft");
	});

	test("protects manual changes and writes the complete generated proposal separately", async () => {
		writeSource("policy.txt", "Original fact");
		const first = await ingest();
		await submit(first.jobId);
		await publishKnowledge({ cwd, jobId: first.jobId, producer });
		const path = join(cwd, "knowledge/wiki/concepts/policies/refunds.md");
		writeFileSync(path, "User-edited text that must not disappear");
		const second = await ingest();
		await submit(second.jobId);
		const published = await publishKnowledge({ cwd, jobId: second.jobId, producer });
		expect(readFileSync(path, "utf8")).toBe("User-edited text that must not disappear");
		expect(published?.protected).toContain("wiki/concepts/policies/refunds.md");
		expect(published?.proposals).toHaveLength(1);
		expect(readFileSync(join(cwd, "knowledge", published!.proposals[0]), "utf8")).toContain("Original fact");
	});

	test("partial or failed files prevent stable publication, but an explicit failed retry can recover", async () => {
		writeSource("a.txt", "Good fact");
		writeSource("b.txt", "FAIL document");
		const job = await ingest();
		await submit(job.jobId, job.sources.find(source => source.state === "complete")!.sourceId);
		expect((await publishKnowledge({ cwd, jobId: job.jobId, producer }))?.draft).toEqual(["policies/refunds"]);
		writeSource("b.txt", "Now readable");
		const retry = await startIngestion({ cwd, inputPaths: ["raw/b.txt"], outputDir: "retry-knowledge" });
		converter.fail = true;
		expect((await nextIngestion({ cwd, jobId: retry.jobId })).sources[0].state).toBe("failed");
		converter.fail = false;
		expect((await nextIngestion({ cwd, jobId: retry.jobId, retryFailed: true })).sources[0].state).toBe("complete");
	});

	test("informational parser warnings allow supported publication while partial parsing stays draft", async () => {
		writeSource("advisory.pdf", "ADVISORY Code retains its documented indentation.");
		const job = await ingest();
		await submit(job.jobId);
		expect((await publishKnowledge({ cwd, jobId: job.jobId, producer }))?.stable).toContain("policies/refunds");
		writeSource("advisory.pdf", "PARTIAL Some page text could not be parsed.");
		const partial = await ingest();
		await submit(partial.jobId);
		expect((await publishKnowledge({ cwd, jobId: partial.jobId, producer }))?.draft).toContain("policies/refunds");
	});

	test("exact duplicates merge into one statement without inventing verification", async () => {
		writeSource("a.txt", "Refunds within 30 days.");
		writeSource("b.txt", "Refunds within 30 days.");
		const job = await ingest();
		for (const source of job.sources) await submit(job.jobId, source.sourceId);
		await publishKnowledge({ cwd, jobId: job.jobId, producer });
		const page = readFileSync(join(cwd, "knowledge/wiki/concepts/policies/refunds.md"), "utf8");
		expect(page.split("\n---\n")[1].match(/Refunds within 30 days\./g)).toHaveLength(1);
		expect(page).not.toContain("verified:");
		expect(manifest().concepts["policies/refunds"].claims).toHaveLength(2);
	});

	test("a new contradiction downgrades both its own concept and previously stable target", async () => {
		writeSource("policy.txt", "Refunds within 30 days.");
		const first = await ingest();
		await submit(first.jobId);
		await publishKnowledge({ cwd, jobId: first.jobId, producer });
		writeSource("competing.txt", "Refunds are never allowed.");
		const second = await startIngestion({ cwd, inputPaths: ["raw/competing.txt"] });
		await nextIngestion({ cwd, jobId: second.jobId });
		const item = await candidate(second.jobId, undefined, "policies/new-refunds");
		item.candidate.review.conflicts = ["policies/refunds"];
		await submitCandidates({ cwd, jobId: second.jobId, sourceId: item.sourceId, candidates: [item.candidate], producer });
		const result = await publishKnowledge({ cwd, jobId: second.jobId, producer });
		expect(result?.draft.sort()).toEqual(["policies/new-refunds", "policies/refunds"]);
	});

	test("stop prevents candidate writes and publication, and archival yields to abort signals", async () => {
		writeSource("policy.txt", "Original fact");
		const controller = new AbortController();
		await expect(startIngestion({ cwd, inputPaths: ["raw"], signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow();
		const job = await ingest();
		await submit(job.jobId);
		await expect(publishKnowledge({ cwd, jobId: job.jobId, producer, signal: controller.signal })).rejects.toThrow();
		expect(Object.keys(manifest().concepts)).toHaveLength(0);
	});

	test("cancelling after one archive rolls back only new unregistered evidence before a retry", async () => {
		writeSource("a.txt", "First raw document");
		writeSource("b.txt", "Second raw document");
		let progress = 0;
		const controller = new AbortController();
		await expect(startIngestion({ cwd, inputPaths: ["raw"], signal: controller.signal, onProgress: () => { if (++progress === 2) controller.abort(); } })).rejects.toThrow();
		expect(Object.keys(manifest().sources)).toHaveLength(0);
		expect(existsSync(join(cwd, "knowledge/evidence"))).toBe(false);
		const retried = await ingest();
		expect(retried.sources).toHaveLength(2);
		expect(readdirSync(join(cwd, "knowledge/evidence"))).toHaveLength(2);
	});

	test("reuses an archive copied before its source registration reached the manifest", async () => {
		writeSource("policy.txt", "Original source");
		const first = await startIngestion({ cwd, inputPaths: ["raw"] });
		const interrupted = manifest();
		interrupted.sources = {};
		delete interrupted.latestJobId;
		writeFileSync(join(cwd, "knowledge/manifest.json"), JSON.stringify(interrupted));
		const retried = await startIngestion({ cwd, inputPaths: ["raw"] });
		expect(retried.sources[0].sourceId).toBe(first.sources[0].sourceId);
		expect(readdirSync(join(cwd, "knowledge/evidence"))).toHaveLength(1);
	});

	test("tampered normalization cannot be used as proof for new claims", async () => {
		writeSource("policy.txt", "Original fact");
		const job = await ingest();
		const item = await candidate(job.jobId);
		const source = (await readCandidates({ cwd, jobId: job.jobId })).sources[0];
		writeFileSync(source.blocksPath!, JSON.stringify([{ id: "block-1", text: "Forged fact", locator: { page: 1 } }]));
		item.candidate.statement = "Forged fact";
		item.candidate.evidence[0].quote = "Forged fact";
		await expect(submitCandidates({ cwd, jobId: job.jobId, sourceId: item.sourceId, candidates: [item.candidate], producer })).rejects.toThrow("externally modified");
	});

	test("archives Markdown image dependencies and versions asset-only changes", async () => {
		writeSource("policy.md", "# Policy\n\n![Diagram](diagram.png)");
		const image = writeSource("diagram.png", "image revision one");
		const first = await ingest();
		await submit(first.jobId);
		await publishKnowledge({ cwd, jobId: first.jobId, producer });
		const source = Object.values(manifest().sources)[0];
		const version = source.versions[source.latestHash];
		expect(version.documentHash).not.toBe(version.hash);
		expect(version.dependencies).toHaveLength(1);
		expect(readFileSync(join(cwd, "knowledge", version.dependencies[0].archivePath!), "utf8")).toBe("image revision one");
		writeFileSync(image, "image revision two");
		await startIngestion({ cwd, inputPaths: ["raw"] });
		expect(Object.values(manifest().sources)[0].latestHash).not.toBe(source.latestHash);
		expect(manifest().concepts["policies/refunds"].status).toBe("draft");
	});

	test("Markdown cannot archive image content outside registered source roots", async () => {
		writeSource("policy.md", "![Outside](../outside.png)");
		writeFileSync(join(cwd, "outside.png"), "Must not become evidence");
		await startIngestion({ cwd, inputPaths: ["raw/policy.md"] });
		const source = Object.values(manifest().sources)[0];
		const dependency = source.versions[source.latestHash].dependencies[0];
		expect(dependency).toMatchObject({ inputPath: null, hash: null });
		expect(dependency.warning).toContain("outside the registered");
		expect(dependency.archivePath).toBeUndefined();
	});

	test("rechecks retained source evidence when only a different source is being ingested", async () => {
		const a = writeSource("a.txt", "Existing policy.");
		const first = await ingest();
		await submit(first.jobId);
		await publishKnowledge({ cwd, jobId: first.jobId, producer });
		writeFileSync(a, "Changed existing policy.");
		writeSource("b.txt", "Additional policy.");
		const second = await startIngestion({ cwd, inputPaths: ["raw/b.txt"] });
		await nextIngestion({ cwd, jobId: second.jobId });
		await submit(second.jobId);
		await expect(publishKnowledge({ cwd, jobId: second.jobId, producer })).rejects.toThrow("changed after");
		expect(manifest().concepts["policies/refunds"].status).toBe("draft");
	});

	test("a manually edited Reference for retained evidence prevents stable republishing from another source", async () => {
		writeSource("a.txt", "Existing policy.");
		const first = await ingest();
		await submit(first.jobId);
		await publishKnowledge({ cwd, jobId: first.jobId, producer });
		const reference = Object.keys(manifest().managedFiles).find(path => path.startsWith("wiki/references/"))!;
		writeFileSync(join(cwd, "knowledge", reference), "Human-edited evidence reference");
		writeSource("b.txt", "Additional policy.");
		const second = await startIngestion({ cwd, inputPaths: ["raw/b.txt"] });
		await nextIngestion({ cwd, jobId: second.jobId });
		await submit(second.jobId);
		const published = await publishKnowledge({ cwd, jobId: second.jobId, producer });
		expect(published?.stable).toEqual([]);
		expect(published?.draft).toContain("policies/refunds");
		expect(published?.protected).toContain(reference);
		expect(readFileSync(join(cwd, "knowledge", reference), "utf8")).toBe("Human-edited evidence reference");
	});

	test("a second output root does not re-ingest the first root as raw knowledge", async () => {
		writeSource("policy.txt", "Existing policy.");
		const first = await ingest();
		await submit(first.jobId);
		await publishKnowledge({ cwd, jobId: first.jobId, producer });
		const second = await startIngestion({ cwd, inputPaths: ["."], outputDir: "second-export" });
		expect(second.sources).toHaveLength(1);
		expect(second.sources[0].path).toBe(join(raw, "policy.txt"));
		expect(second.warnings.some(warning => warning.includes("existing knowledge"))).toBe(true);
	});

	test("cancels a queued operation immediately without running it after the current holder exits", async () => {
		writeSource("policy.txt", "Fact");
		let release!: () => void;
		let entered!: () => void;
		const running = new Promise<void>(resolve => { entered = resolve; });
		const holding = withKnowledgeLock(cwd, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
		await running;
		const controller = new AbortController();
		const queued = startIngestion({ cwd, inputPaths: ["raw"], signal: controller.signal });
		controller.abort();
		const result = await Promise.race([queued.then(() => "ran", () => "cancelled"), new Promise<string>(resolve => setTimeout(() => resolve("waiting"), 100))]);
		release();
		await holding;
		expect(result).toBe("cancelled");
		expect(existsSync(join(cwd, "knowledge/manifest.json"))).toBe(false);
	});

	test("refuses oversized manifests before replacing the previous readable state", async () => {
		writeSource("policy.txt", "Original policy.");
		await ingest();
		const prior = readFileSync(join(cwd, "knowledge/manifest.json"), "utf8");
		const byteLength = Buffer.byteLength.bind(Buffer);
		vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => typeof value === "string" && value.startsWith('{\n  "kind": "pi-harness-knowledge"') ? 17 * 1024 * 1024 : byteLength(value, encoding));
		await expect(startIngestion({ cwd, inputPaths: ["raw"] })).rejects.toThrow("manifest exceeds 16 MiB");
		expect(readFileSync(join(cwd, "knowledge/manifest.json"), "utf8")).toBe(prior);
		expect(existsSync(join(privateDirectory(cwd), "transaction.json"))).toBe(false);
	});

	test("custom output stays confined, read operations page sources and expose full evidence paths", async () => {
		for (let index = 0; index < 3; index++) writeSource(`${index}.txt`, "x".repeat(3000));
		const job = await ingest("generated/company");
		const first = await readCandidates({ cwd, jobId: job.jobId });
		expect(first.sources).toHaveLength(1);
		expect(first.sources[0].blocks[0].text).toHaveLength(2000);
		expect(first.sources[0].blocks[0].textTruncated).toBe(true);
		expect(first.nextSourceOffset).toBe(1);
		expect(first.sources[0].blocksPath).toContain("generated/company/evidence");
		expect((await getIngestionStatus({ cwd })).outputDirectory).toBe(join(cwd, "generated/company"));
		await expect(startIngestion({ cwd, inputPaths: ["raw"], outputDir: "../escape" })).rejects.toThrow("subdirectory");
	});

	test("status and next stay bounded while reporting pending sources beyond the displayed page", async () => {
		for (let index = 0; index < 25; index++) writeSource(`${index.toString().padStart(2, "0")}.txt`, `Fact ${index}`);
		let status = await startIngestion({ cwd, inputPaths: ["raw"] });
		expect(status).toMatchObject({ sourceCount: 25, sourcesTruncated: true, sourceCounts: { pending: 25 } });
		expect(status.sources).toHaveLength(20);
		for (let index = 0; index < 21; index++) status = await nextIngestion({ cwd, jobId: status.jobId });
		expect(status.sourceCounts.pending).toBe(4);
		expect(status.nextSourceId).not.toBeNull();
		expect(status.sources.every(source => source.state === "complete")).toBe(true);
	});

	test("refuses symbolic-link outputs and skips links encountered inside source directories", async () => {
		writeSource("a.txt", "Fact");
		const outside = join(folder, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(raw, "linked"), process.platform === "win32" ? "junction" : "dir");
		const job = await ingest();
		expect(job.warnings.some(warning => warning.includes("symbolic link"))).toBe(true);
		symlinkSync(outside, join(cwd, "unsafe"), process.platform === "win32" ? "junction" : "dir");
		await expect(startIngestion({ cwd, inputPaths: ["raw"], outputDir: "unsafe" })).rejects.toThrow("Symbolic");
		expect(readdirSync(outside)).toEqual([]);
	});

	test("replays interrupted transactions without overwriting intervening manual changes", async () => {
		const root = join(cwd, "knowledge");
		mkdirSync(root);
		writeFileSync(join(root, "a.txt"), "already committed");
		const journal = join(privateDirectory(cwd), "transaction.json");
		writeFileSync(journal, JSON.stringify({ version: 1, cwd, outputDirectory: root, writes: [{ path: "a.txt", expectedHash: null, contents: "already committed" }, { path: "b.txt", expectedHash: null, contents: "pending" }] }));
		await recoverTransaction(cwd);
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("pending");
		writeFileSync(journal, JSON.stringify({ version: 1, cwd, outputDirectory: root, writes: [{ path: "b.txt", expectedHash: digest("pending"), contents: "new version" }] }));
		writeFileSync(join(root, "b.txt"), "human edit");
		await expect(recoverTransaction(cwd)).rejects.toThrow("externally modified");
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("human edit");
	});
});
