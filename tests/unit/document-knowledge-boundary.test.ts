import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convertDocument } from "../../server/document-conversion/service.js";
import { readDocumentBundle } from "../../server/document-bundle.js";
import { updateDocumentSettings } from "../../server/document-extension-settings.js";
import { nextIngestion, previewKnowledgeReview, publishKnowledge, readCandidates, startIngestion, submitCandidates, verifyKnowledge } from "../../server/okf/service.js";
import type { CandidateInput } from "../../server/okf/types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createOkfExtension } from "../../server/okf/extension.js";

let root: string, cwd: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "document-boundary-")));
	cwd = join(root, "workspace"); mkdirSync(cwd);
	vi.stubEnv("PI_WEB_DATA_DIR", join(root, "data"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function draft(basis: CandidateInput["basis"] = "fact", staleAfter?: string) {
	writeFileSync(join(cwd, "policy.md"), "Support opens on weekdays.\n");
	const job = await startIngestion({ cwd, inputPaths: ["policy.md"] });
	await nextIngestion({ cwd, jobId: job.jobId });
	const source = (await readCandidates({ cwd, jobId: job.jobId })).sources[0];
	await submitCandidates({ cwd, jobId: job.jobId, sourceId: source.sourceId, producer: "pi/test", candidates: [{ basis, staleAfter, section: "conditions", conceptId: "support", title: "Support", type: "Playbook", statement: "Support opens on weekdays.", evidence: [{ sourceId: source.sourceId, sourceHash: source.hash, blockId: source.blocks[0].id, quote: "Support opens on weekdays." }], review: { support: "supported", rationale: "The fixture states the condition directly.", comparedConceptIds: [], conflicts: [] } }] });
	const result = await publishKnowledge({ cwd, jobId: job.jobId, producer: "pi/test" });
	return { jobId: job.jobId, result };
}

test("portable bundle preserves source snapshots and Git line locations without a conversion dependency in OKF", async () => {
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	git("init");
	writeFileSync(join(cwd, "replication.ts"), "export const code = 1032;\n");
	git("add", "replication.ts"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
	const outputDir = join(cwd, "parsed");
	await convertDocument({ inputPath: join(cwd, "replication.ts"), outputDir });
	const { bundle, blocks } = readDocumentBundle(outputDir);
	expect(bundle.source.git?.dirty).toBe(false);
	expect(bundle.source.git?.commit).toMatch(/^[a-f0-9]{40}$/);
	expect(blocks[0].locator).toMatchObject({ lineStart: 1, lineEnd: 1, path: "replication.ts", commit: bundle.source.git?.commit });
	updateDocumentSettings({ pdfEnabled: false });
	const job = await startIngestion({ cwd, inputPaths: [outputDir] });
	expect(job.sourceCount).toBe(1);
	expect((await nextIngestion({ cwd, jobId: job.jobId })).sourceCounts.complete).toBe(1);
	const evidence = (await readCandidates({ cwd, jobId: job.jobId })).sources[0];
	expect(evidence.blocks[0].locator).toEqual(blocks[0].locator);
	const manifest = JSON.parse(readFileSync(join(cwd, "knowledge/manifest.json"), "utf8"));
	const version = manifest.sources[evidence.sourceId].versions[evidence.hash];
	expect(readFileSync(join(cwd, "knowledge", version.bundlePath, bundle.source.original), "utf8")).toBe("export const code = 1032;\n");
	await submitCandidates({ cwd, jobId: job.jobId, sourceId: evidence.sourceId, producer: "pi/test", candidates: [] });
	expect((await publishKnowledge({ cwd, jobId: job.jobId, producer: "pi/test" }))?.draft).toEqual([]);
});

test("OKF rejects unconverted raw formats and detects bundle tampering before archiving", async () => {
	writeFileSync(join(cwd, "manual.pdf"), "%PDF-fixture");
	await expect(startIngestion({ cwd, inputPaths: ["manual.pdf"] })).rejects.toThrow(/document_to_markdown/);
	writeFileSync(join(cwd, "raw.txt"), "Raw evidence.");
	const converted = await convertDocument({ inputPath: join(cwd, "raw.txt"), outputDir: join(cwd, "parsed") });
	writeFileSync(converted.markdownPath, "Untracked rewrite.");
	await expect(startIngestion({ cwd, inputPaths: ["parsed"] })).rejects.toThrow(/modified/);
});

test("plain Markdown intake works with conversion disabled and no Python runtime", async () => {
	updateDocumentSettings({ pdfEnabled: false, pythonPath: join(root, "missing-python") });
	const { result } = await draft();
	expect(result?.stable).toEqual([]); expect(result?.draft).toEqual(["support"]);
	const page = readFileSync(join(cwd, "knowledge/wiki/concepts/support.md"), "utf8");
	expect(page).toContain("**fact**"); expect(page).not.toContain("verified:");
});

test("actual human review records verification and promotes only the inspected revision", async () => {
	const { jobId } = await draft();
	const preview = await previewKnowledgeReview({ cwd, jobId });
	expect(preview.concepts[0].reasons).toEqual([]);
	await verifyKnowledge({ cwd, jobId, conceptIds: ["support"], token: preview.token, reviewer: "fixture-reviewer", notes: "Read fixture source and checked the weekday condition.", });
	const page = readFileSync(join(cwd, "knowledge/wiki/concepts/support.md"), "utf8");
	expect(page).toContain("status: stable"); expect(page).toContain('"by":"human:fixture-reviewer"');
	expect(readFileSync(join(cwd, "knowledge/wiki/index.md"), "utf8")).toMatch(/# Knowledge\n\n- \[Support\]/);
	writeFileSync(join(cwd, "policy.md"), "Support is closed.");
	await startIngestion({ cwd, inputPaths: ["policy.md"] });
	const invalidated = readFileSync(join(cwd, "knowledge/wiki/concepts/support.md"), "utf8");
	expect(invalidated).toContain("status: draft"); expect(invalidated).not.toContain("verified:");
});

test.each(["inference", "hypothesis", "outdated"] as const)("a supported quote cannot promote %s to verified fact", async basis => {
	const { jobId } = await draft(basis);
	const preview = await previewKnowledgeReview({ cwd, jobId });
	expect(preview.concepts[0].reasons.join(" ")).toContain(basis);
	await expect(verifyKnowledge({ cwd, jobId, conceptIds: ["support"], token: preview.token, reviewer: "person", notes: "Reviewed." })).rejects.toThrow(/Resolve/);
});

test("expired knowledge and changes during a review cannot be approved", async () => {
	const { jobId } = await draft("fact", "2000-01-01T00:00:00Z");
	const preview = await previewKnowledgeReview({ cwd, jobId });
	expect(preview.concepts[0].reasons.join(" ")).toContain("expired");
	writeFileSync(join(cwd, "policy.md"), "New condition.");
	await expect(verifyKnowledge({ cwd, jobId, conceptIds: ["support"], token: preview.token, reviewer: "person", notes: "Reviewed." })).rejects.toThrow(/changed during review/);
});

test("the knowledge extension never imports a conversion or Python runtime module", () => {
	for (const file of ["service.ts", "extension.ts", "markdown-evidence.ts", "storage.ts", "types.ts"]) {
		expect(readFileSync(new URL(`../../server/okf/${file}`, import.meta.url), "utf8")).not.toMatch(/from\s+["'][^"']*document-conversion\//);
	}
});

test("human command cancellation leaves drafts untouched; approval is absent from Agent tools", async () => {
	const { jobId } = await draft();
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const tools: string[] = [];
	await createOkfExtension()({ registerTool: tool => { tools.push(tool.name); }, registerCommand: (_name, options) => { command = options; } } as ExtensionAPI);
	expect(tools).toEqual(["okf_ingest", "okf_candidates", "okf_publish"]);
	const input = vi.fn().mockResolvedValueOnce("reviewer").mockResolvedValueOnce("Read and checked the fixture source.");
	const confirm = vi.fn().mockResolvedValue(false), notify = vi.fn();
	const ctx = { cwd, hasUI: true, isIdle: () => true, ui: { input, confirm, notify } } as unknown as ExtensionCommandContext;
	const path = join(cwd, "knowledge/wiki/concepts/support.md"), before = readFileSync(path, "utf8");
	await command!.handler(`review ${jobId}`, ctx);
	expect(confirm).toHaveBeenCalledOnce(); expect(readFileSync(path, "utf8")).toBe(before);
	input.mockResolvedValueOnce("reviewer").mockResolvedValueOnce("Checked source and applicable condition.");
	confirm.mockResolvedValueOnce(true);
	await command!.handler(`review ${jobId}`, ctx);
	expect(readFileSync(path, "utf8")).toContain("status: stable");
});

test("normalized Markdown edits cannot silently pass the human verification gate", async () => {
	const { jobId } = await draft();
	const source = (await readCandidates({ cwd, jobId })).sources[0];
	writeFileSync(source.markdownPath!, "Altered normalized evidence.");
	const preview = await previewKnowledgeReview({ cwd, jobId });
	expect(preview.concepts[0].reasons.join(" ")).toContain("Normalized evidence was externally modified");
	await expect(verifyKnowledge({ cwd, jobId, conceptIds: ["support"], token: preview.token, reviewer: "person", notes: "Checked." })).rejects.toThrow(/Resolve/);
});
