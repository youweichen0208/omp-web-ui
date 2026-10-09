import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertDocument, textBlocks } from "../../server/document-conversion/service.js";
import { doctorRuntime, runDocumentProcess } from "../../server/document-conversion/runtime.js";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

let root: string, prior: string | undefined;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "document-conversion-")); prior = process.env.PI_WEB_DATA_DIR; process.env.PI_WEB_DATA_DIR = join(root, "data"); });
afterEach(async () => { if (prior === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = prior; await rm(root, { recursive: true, force: true }); });

describe("local document conversion", () => {
	it("normalizes encoding/newlines without reinterpreting tables or code indentation", async () => {
		const input = join(root, "公司资料.md"), output = join(root, "out");
		const text = "# 资料\r\n\r\n| 项 | 值 |\r\n|---|---|\r\n| A | 123 |\r\n\r\n```python\r\ndef total():\r\n    return 123\r\n```\r\n";
		await writeFile(input, "\uFEFF" + text);
		const result = await convertDocument({ inputPath: input, outputDir: output });
		expect(await readFile(result.markdownPath, "utf8")).toBe(text.replace(/\r\n/g, "\n"));
		expect(result.blocks.find(block => block.text.includes("return"))?.text).toContain("    return 123");
		expect(result.blocks[0].locator.lineStart).toBe(1);
		expect(result.status).toBe("complete");
	});
	it("shares content cache across destinations and binds provenance to the new source", async () => {
		const first = join(root, "first.txt"), second = join(root, "second.txt");
		await writeFile(first, "Shared evidence\n"); await writeFile(second, "Shared evidence\n");
		const one = await convertDocument({ inputPath: first, outputDir: join(root, "one") });
		const progress: string[] = [];
		const two = await convertDocument({ inputPath: second, outputDir: join(root, "two"), onProgress: line => progress.push(line) });
		expect(two.sourceHash).toBe(one.sourceHash);
		expect(progress.some(line => line.includes("content cache"))).toBe(true);
		expect(JSON.parse(await readFile(two.sourceMapPath, "utf8")).source).toBe(second);
	});
	it("copies Markdown image assets, invalidates changed images and ignores code examples", async () => {
		const input = join(root, "raw.md"), picture = join(root, "picture.png"), output = join(root, "out");
		await writeFile(input, "![diagram](picture.png)\n\n```md\n![example](missing.png)\n```\n");
		await writeFile(picture, "image one");
		const first = await convertDocument({ inputPath: input, outputDir: output });
		const firstMarkdown = await readFile(first.markdownPath, "utf8");
		expect(firstMarkdown).toMatch(/!\[diagram\]\(assets\//);
		expect(first.warnings).toEqual([]);
		await writeFile(picture, "image two");
		const second = await convertDocument({ inputPath: input, outputDir: output });
		expect(await readFile(second.markdownPath, "utf8")).not.toBe(firstMarkdown);
	});
	it("marks missing Markdown assets partial without fetching external images", async () => {
		const input = join(root, "raw.md");
		await writeFile(input, "![missing](gone.png)\n![remote](https://example.invalid/picture.png)\n");
		const result = await convertDocument({ inputPath: input, outputDir: join(root, "out") });
		expect(result.status).toBe("partial");
		expect(result.warnings).toHaveLength(1);
		expect(await readFile(result.markdownPath, "utf8")).toContain("https://example.invalid/picture.png");
	});
	it("resolves archived Markdown image mappings without falling back to live raw files", async () => {
		const input = join(root, "raw.md"), archived = join(root, "archived.png");
		await writeFile(input, "![diagram](picture.png)\n");
		await writeFile(join(root, "picture.png"), "live image");
		await writeFile(archived, "archived image");
		const missing = await convertDocument({ inputPath: input, outputDir: join(root, "missing"), markdownAssets: {} });
		expect(missing.status).toBe("partial");
		expect(missing.warnings[0]).toContain("archived evidence snapshot");
		const copied = await convertDocument({ inputPath: input, outputDir: join(root, "mapped"), markdownAssets: { "picture.png": archived } });
		expect(copied.status).toBe("complete");
		const markdown = await readFile(copied.markdownPath, "utf8");
		const asset = markdown.match(/\((assets\/[^)]+)\)/)?.[1];
		expect(asset).toBeTruthy();
		expect(await readFile(join(root, "mapped", asset!), "utf8")).toBe("archived image");
	});
	it("refuses to overwrite edited outputs or unrelated existing files", async () => {
		const input = join(root, "raw.md"), output = join(root, "out");
		await writeFile(input, "original");
		const result = await convertDocument({ inputPath: input, outputDir: output });
		await writeFile(result.markdownPath, "human edit");
		await expect(convertDocument({ inputPath: input, outputDir: output })).rejects.toThrow("edited");
		expect(await readFile(result.markdownPath, "utf8")).toBe("human edit");
		const other = join(root, "other"); await mkdir(other); await writeFile(join(other, "keep.txt"), "keep");
		await expect(convertDocument({ inputPath: input, outputDir: other })).rejects.toThrow("existing files");
		expect(await readFile(join(other, "keep.txt"), "utf8")).toBe("keep");
	});
	it("reconverts changed sources only when generated artifacts remain unchanged", async () => {
		const input = join(root, "raw.txt"), output = join(root, "out");
		await writeFile(input, "version one");
		const first = await convertDocument({ inputPath: input, outputDir: output });
		await writeFile(input, "version two");
		const second = await convertDocument({ inputPath: input, outputDir: output });
		expect(second.sourceHash).not.toBe(first.sourceHash);
		expect(await readFile(second.markdownPath, "utf8")).toBe("version two\n");
	});
	it.each(["document.md", "structure.json"])("preserves a native queued edit to %s made while conversion is waiting to commit", async (filename) => {
		const input = join(root, "raw.txt"), output = join(root, "out");
		await writeFile(input, "version one");
		await convertDocument({ inputPath: input, outputDir: output });
		await writeFile(input, "version two");
		let beginEdit!: () => void, editorEntered!: () => void, committing!: () => void;
		const editGate = new Promise<void>(resolve => { beginEdit = resolve; });
		const editorReady = new Promise<void>(resolve => { editorEntered = resolve; });
		const commitReady = new Promise<void>(resolve => { committing = resolve; });
		const editor = withFileMutationQueue(join(output, filename), async () => { editorEntered(); await editGate; await writeFile(join(output, filename), "human edit"); });
		await editorReady;
		const conversion = convertDocument({ inputPath: input, outputDir: output, onProgress: line => { if (line.includes("Committing")) committing(); } });
		const rejected = expect(conversion).rejects.toThrow("edited");
		await commitReady;
		beginEdit();
		await editor;
		await rejected;
		expect(await readFile(join(output, filename), "utf8")).toBe("human edit");
	});
	it("reports missing runtime honestly and does not install during conversion", async () => {
		const input = join(root, "raw.pdf"); await writeFile(input, "%PDF-1.4");
		expect((await doctorRuntime()).ready).toBe(false);
		await expect(convertDocument({ inputPath: input, outputDir: join(root, "out") })).rejects.toThrow("not ready");
	});
	it("cancels only its isolated child process and rejects before starting an aborted request", async () => {
		const controller = new AbortController();
		const result = runDocumentProcess(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		await expect(result).rejects.toThrow("canceled");
		await expect(runDocumentProcess(process.execPath, ["-e", "process.exit(0)"], { signal: controller.signal })).rejects.toThrow();
	});
	it("shuts down owned setup/conversion children and rejects later process starts", async () => {
		const runtime = new URL("../../server/document-conversion/runtime.ts", import.meta.url).href;
		const script = `const {runDocumentProcess,shutdownDocumentRuntime}=await import(${JSON.stringify(runtime)}); const child=runDocumentProcess(process.execPath,["-e","setInterval(()=>{},1000)"]); setTimeout(()=>shutdownDocumentRuntime(),50); try{await child;}catch{console.log("child stopped");} await shutdownDocumentRuntime(); try{await runDocumentProcess(process.execPath,["-e",""]);}catch(error){console.log(error.message);}`;
		const result = await runDocumentProcess(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 10_000 });
		expect(result).toContain("child stopped");
		expect(result).toContain("shutting down");
	});
	it("keeps headings inside fenced code out of document structure", () => {
		const blocks = textBlocks("# Actual\n\n```sh\n# comment\n\n echo hi\n```\n");
		expect(blocks).toHaveLength(2);
		expect(blocks[1].locator.heading).toBe("Actual");
		expect(blocks[1].text).toContain("# comment\n\n echo hi");
	});
});
