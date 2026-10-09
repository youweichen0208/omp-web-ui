import { createHash } from "node:crypto";
import { readFile, stat, copyFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve, join } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { DocumentBlock } from "./document-bundle.js";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hashFile = async (path: string) => digest(await readFile(path));

type MarkdownNode = { type: string; url?: string; alt?: string | null; title?: string | null; identifier?: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: MarkdownNode[] };
function markdownImageNodes(text: string): MarkdownNode[] {
	const tree = unified().use(remarkParse).parse(text);
	const nodes: MarkdownNode[] = [], references = new Set<string>();
	const visit = (node: MarkdownNode) => { nodes.push(node); if (node.type === "imageReference" && node.identifier) references.add(node.identifier); node.children?.forEach(visit); };
	visit(tree as MarkdownNode);
	return nodes.filter(node => node.type === "image" || (node.type === "definition" && node.identifier && references.has(node.identifier)));
}
function imageSource(url: string, source: string, assets?: Record<string, string | null>): string {
	if (assets !== undefined) {
		if (!Object.hasOwn(assets, url) || !assets[url]) throw new Error("Image is not present in the archived evidence snapshot");
		return assets[url];
	}
	return resolve(dirname(source), decodeURIComponent(url.split("#")[0]));
}
export async function markdownDependencyFingerprint(text: string, source: string, assets?: Record<string, string | null>): Promise<string> {
	const dependencies: string[] = [];
	for (const node of markdownImageNodes(text)) {
		const url = node.url ?? "";
		if (!url || /^(?:[a-z]+:|#)/i.test(url) || isAbsolute(url)) continue;
		try {
			const path = imageSource(url, source, assets), info = await stat(path);
			if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("Unsupported asset");
			dependencies.push(`${url}:${await hashFile(path)}`);
		}
		catch { dependencies.push(`${url}:missing`); }
	}
	return digest(JSON.stringify(dependencies));
}
export async function preserveMarkdownImages(text: string, source: string, output: string, warnings: string[], assets?: Record<string, string | null>, immutable = false): Promise<string> {
	const replacements: { start: number; end: number; text: string }[] = [];
	for (const node of markdownImageNodes(text)) {
		const url = node.url ?? "";
		if (!url || /^(?:https?:|data:|#)/i.test(url)) continue;
		try {
			if (isAbsolute(url) || /^[a-z]+:/i.test(url)) throw new Error("absolute image paths are not portable");
			const local = imageSource(url, source, assets);
			if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".tiff"].includes(extname(local).toLowerCase())) throw new Error("unsupported image format");
			const info = await stat(local);
			if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("image is not a regular file below 20 MiB");
			const target = `assets/${(await hashFile(local)).slice(0, 24)}${extname(local).toLowerCase()}`;
			if (immutable) {
				try { if (await hashFile(join(output, target)) !== await hashFile(local)) throw new Error("Archived normalized image was modified"); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			}
			await copyFile(local, join(output, target));
			const start = node.position?.start.offset, end = node.position?.end.offset;
			if (start !== undefined && end !== undefined) replacements.push({ start, end, text: node.type === "definition" ? `[${node.identifier}]: ${target}${node.title ? ` ${JSON.stringify(node.title)}` : ""}` : `![${(node.alt ?? "").replace(/]/g, "\\]")}](${target}${node.title ? ` ${JSON.stringify(node.title)}` : ""})` });
		} catch (error) {
			if (immutable && error instanceof Error && error.message === "Archived normalized image was modified") throw error;
			warnings.push(`Markdown image was not copied: ${url}: ${error instanceof Error ? error.message : error}`);
		}
	}
	for (const replacement of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
	return text;
}

export function textBlocks(text: string): DocumentBlock[] {
	const lines = text.split("\n"), blocks: DocumentBlock[] = [];
	let start = 0, heading: string | undefined, fence: string | undefined;
	const emit = (end: number) => {
		const value = lines.slice(start, end).join("\n");
		if (value.trim()) blocks.push({ id: `block-${blocks.length + 1}`, text: value, locator: { lineStart: start + 1, lineEnd: end, ...(heading ? { heading } : {}) } });
		start = end;
	};
	for (let i = 0; i < lines.length; i++) {
		const marker = lines[i].match(/^\s*(`{3,}|~{3,})/);
		if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined; }
		if (!fence && /^#{1,6}\s+/.test(lines[i])) { emit(i); heading = lines[i].replace(/^#{1,6}\s+/, ""); }
		if (!fence && !lines[i].trim()) { emit(i); start = i + 1; }
	}
	emit(lines.length);
	return blocks;
}
