import { existsSync, mkdirSync, readFileSync, lstatSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { bundleFile, bundleHash, documentBundleRoot, readDocumentBundle } from "../document-bundle.js";
import { preserveMarkdownImages, textBlocks } from "../markdown-document.js";
import { decodeText } from "../text-sniff.js";
import { atomicWrite } from "./storage.js";
import { markdownDependencies, type SourceDependency } from "./markdown-sources.js";

export function evidenceDependencies(path: string, roots: string[]): SourceDependency[] {
	const root = documentBundleRoot(path);
	if (!root) return markdownDependencies(path, roots);
	const { bundle } = readDocumentBundle(root);
	if (path !== join(root, bundle.markdown)) throw new Error("Select the bundle directory or its document.md");
	return [...Object.keys(bundle.files).filter(name => name !== bundle.markdown), "bundle.json"].sort().map(name => {
		const inputPath = bundleFile(root, name);
		return { url: name, bundlePath: name, inputPath, hash: bundleHash(readFileSync(inputPath)), bytes: lstatSync(inputPath).size };
	});
}

/** Markdown-only intake: no converter, Python environment, or model invocation. */
export async function normalizeMarkdownEvidence(input: { inputPath: string; outputDir: string; bundlePath?: string; signal?: AbortSignal; markdownAssets?: Record<string, string | null> }) {
	input.signal?.throwIfAborted();
	if (![".md", ".markdown"].includes(extname(input.inputPath).toLowerCase())) throw new Error("This legacy job contains raw files. Convert with document_to_markdown and start a new Markdown ingestion job.");
	const sourceHash = bundleHash(readFileSync(input.inputPath));
	if (input.bundlePath) {
		const { bundle, blocks } = readDocumentBundle(input.bundlePath);
		return { sourceHash, blocks, markdownPath: bundleFile(input.bundlePath, bundle.markdown), parserVersion: bundle.parserVersion, warnings: bundle.warnings, status: bundle.status };
	}
	if (lstatSync(input.inputPath).size > 16 * 1024 * 1024) throw new Error("Markdown exceeds 16 MiB");
	const original = decodeText(readFileSync(input.inputPath)).replace(/\r\n?/g, "\n");
	if (original.includes("\0")) throw new Error("Markdown contains binary data");
	const warnings: string[] = [];
	mkdirSync(join(input.outputDir, "assets"), { recursive: true });
	const markdown = await preserveMarkdownImages(original, input.inputPath, input.outputDir, warnings, input.markdownAssets, true);
	const markdownPath = join(input.outputDir, "document.md");
	if (existsSync(markdownPath) && readFileSync(markdownPath, "utf8") !== markdown) throw new Error("Normalized Markdown was externally modified");
	input.signal?.throwIfAborted();
	atomicWrite(markdownPath, markdown);
	const normalizedFiles = Object.fromEntries([markdownPath, ...readdirSync(join(input.outputDir, "assets")).map(name => join(input.outputDir, "assets", name))].map(path => [path, bundleHash(readFileSync(path))]));
	return { sourceHash, blocks: textBlocks(original), markdownPath, normalizedFiles, parserVersion: "markdown-evidence-v1", warnings, status: warnings.length ? "partial" as const : "complete" as const };
}
