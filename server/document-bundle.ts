import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Portable data contract shared by independent producers and knowledge consumers. */
export interface DocumentLocator {
	page?: number; heading?: string; member?: string; sheet?: string; cell?: string; slide?: number;
	lineStart?: number; lineEnd?: number; repository?: string; commit?: string; path?: string; dirty?: boolean;
}
export interface DocumentBlock { id: string; text: string; locator: DocumentLocator }
export interface DocumentOrigin {
	id: string;
	name: string;
	format: string;
	contentHash: string;
	original: string;
	inputPath: string;
	git?: { repository: string; commit: string; branch?: string; path: string; dirty: boolean };
}
export interface DocumentBundle {
	kind: "pi-harness-normalized-document";
	version: 1;
	source: DocumentOrigin;
	markdown: "document.md";
	sourceMap: "source-map.json";
	structure: "structure.json";
	parserVersion: string;
	status: "complete" | "partial";
	warnings: string[];
	files: Record<string, string>;
}
export const bundleHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function bundleFile(root: string, relative: string): string {
	if (!relative || isAbsolute(relative) || /[\\:\0]/.test(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`Unsafe evidence bundle path: ${relative}`);
	let path = resolve(root);
	for (const part of ["", ...relative.split("/")]) {
		path = join(path, part);
		if (lstatSync(path).isSymbolicLink()) throw new Error("Evidence bundle contains a symbolic link");
	}
	return path;
}

export function documentBundleRoot(input: string): string | undefined {
	const root = dirname(input);
	return existsSync(join(root, "bundle.json")) ? root : undefined;
}

export function readDocumentBundle(root: string): { bundle: DocumentBundle; blocks: DocumentBlock[] } {
	const marker = bundleFile(root, "bundle.json");
	if (lstatSync(marker).size > 8 * 1024 * 1024) throw new Error("Evidence bundle manifest exceeds 8 MiB");
	const bundle: DocumentBundle = JSON.parse(readFileSync(marker, "utf8"));
	if (bundle.kind !== "pi-harness-normalized-document" || bundle.version !== 1 || bundle.markdown !== "document.md" || bundle.sourceMap !== "source-map.json" || bundle.structure !== "structure.json" || !bundle.files || !bundle.source || !["complete", "partial"].includes(bundle.status) || !Array.isArray(bundle.warnings) || bundle.warnings.some(warning => typeof warning !== "string") || typeof bundle.parserVersion !== "string") throw new Error("Invalid normalized Markdown evidence bundle");
	if (typeof bundle.source.name !== "string" || typeof bundle.source.id !== "string" || typeof bundle.source.format !== "string" || typeof bundle.source.inputPath !== "string" || !/^[a-f0-9]{64}$/.test(bundle.source.contentHash)) throw new Error("Invalid original-source metadata");
	const entries = Object.entries(bundle.files);
	if (entries.length > 20000) throw new Error("Evidence bundle exceeds 20000 files");
	let total = 0;
	for (const [relative, hash] of entries) {
		if (relative === "bundle.json" || relative === "manifest.json" || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid evidence bundle file hash");
		const path = bundleFile(root, relative), stat = lstatSync(path);
		if (!stat.isFile() || stat.size > 256 * 1024 * 1024 || (total += stat.size) > 1024 * 1024 * 1024) throw new Error("Evidence bundle exceeds file or total byte limits");
		if (bundleHash(readFileSync(path)) !== hash) throw new Error(`Normalized evidence was modified: ${relative}; convert the original again or ingest explicitly authored Markdown separately`);
	}
	for (const name of [bundle.markdown, bundle.sourceMap, bundle.structure, bundle.source.original]) if (!Object.hasOwn(bundle.files, name)) throw new Error(`Missing evidence bundle artifact: ${name}`);
	if (bundle.files[bundle.source.original] !== bundle.source.contentHash) throw new Error("Original source hash does not match the bundle");
	const mapPath = bundleFile(root, bundle.sourceMap);
	if (lstatSync(mapPath).size > 64 * 1024 * 1024) throw new Error("Source map exceeds 64 MiB");
	const map: { sourceHash: string; blocks: DocumentBlock[] } = JSON.parse(readFileSync(mapPath, "utf8"));
	if (map.sourceHash !== bundle.source.contentHash || !Array.isArray(map.blocks) || map.blocks.length > 100000) throw new Error("Invalid evidence source map");
	const ids = new Set<string>();
	for (const block of map.blocks) {
		if (!block || typeof block.id !== "string" || !block.id || ids.has(block.id) || typeof block.text !== "string" || !block.locator || typeof block.locator !== "object" || Array.isArray(block.locator)) throw new Error("Invalid or duplicate evidence block");
		ids.add(block.id);
	}
	return { bundle, blocks: map.blocks };
}
