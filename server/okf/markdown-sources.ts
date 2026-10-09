import { lstatSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { decodeText } from "../text-sniff.js";
import { assertPlainPath, digest, within } from "./storage.js";

export interface SourceDependency {
	url: string;
	inputPath: string | null;
	hash: string | null;
	bytes: number;
	archivePath?: string;
	bundlePath?: string;
	warning?: string;
}

type MarkdownNode = { type: string; url?: string; identifier?: string; children?: MarkdownNode[] };

/** Only document images inside the explicitly registered input roots are read. */
export function markdownDependencies(path: string, roots: string[]): SourceDependency[] {
	if (![".md", ".markdown"].includes(extname(path).toLowerCase())) return [];
	if (lstatSync(path).size > 16 * 1024 * 1024) throw new Error("Markdown documents are limited to 16 MiB");
	const tree = unified().use(remarkParse).parse(decodeText(readFileSync(path)));
	const nodes: MarkdownNode[] = [];
	const identifiers = new Set<string>();
	const visit = (node: MarkdownNode): void => {
		nodes.push(node);
		if (node.type === "imageReference" && node.identifier) identifiers.add(node.identifier);
		for (const child of node.children ?? []) visit(child);
	};
	visit(tree as MarkdownNode);
	const urls = [...new Set(nodes.filter(node => node.type === "image" || (node.type === "definition" && node.identifier && identifiers.has(node.identifier))).map(node => node.url ?? ""))].sort();
	const dependencies: SourceDependency[] = [];
	for (const url of urls) {
		if (!url || /^(?:https?:|data:|#)/i.test(url)) continue;
		if (dependencies.length >= 200) throw new Error("A Markdown document is limited to 200 local image dependencies");
		const dependency: SourceDependency = { url, inputPath: null, hash: null, bytes: 0 };
		try {
			const decoded = decodeURIComponent(url.split("#")[0]);
			if (isAbsolute(decoded) || /^[a-z]+:/i.test(decoded)) throw new Error("Absolute image paths are not allowed");
			const local = resolve(dirname(path), decoded);
			if (!roots.some(root => within(root, local))) throw new Error("Image is outside the registered source roots");
			assertPlainPath(local);
			if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".tiff"].includes(extname(local).toLowerCase())) throw new Error("Unsupported image format");
			dependency.inputPath = local;
			const stat = lstatSync(local);
			if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error("Image must be a regular file below 20 MiB");
			dependency.hash = digest(readFileSync(local));
			dependency.bytes = stat.size;
		} catch (error) { dependency.warning = error instanceof Error ? error.message : String(error); }
		dependencies.push(dependency);
	}
	return dependencies;
}

export function sourceRevision(documentHash: string, dependencies: SourceDependency[]): string {
	return dependencies.length ? digest(JSON.stringify({ documentHash, dependencies: dependencies.map(({ url, hash }) => ({ url, hash })) })) : documentHash;
}
