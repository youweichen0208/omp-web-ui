import { unified } from "unified";
import remarkParse from "remark-parse";

const parser = unified().use(remarkParse);
type TextNode = { type: string; value?: string; depth?: number; children?: TextNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };
function plain(node: TextNode): string {
	if (["code", "html", "definition"].includes(node.type)) return "";
	return node.value ?? node.children?.map(plain).join("") ?? "";
}
function visit(node: TextNode, fn: (node: TextNode) => void) {
	fn(node);
	if (!["code", "inlineCode", "html", "definition"].includes(node.type)) node.children?.forEach(child => visit(child, fn));
}
function scalar(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) { try { return JSON.parse(trimmed); } catch { /* YAML also accepts non-JSON strings. */ } }
	return trimmed.replace(/^(['"])([\s\S]*)\1$/, "$2").replaceAll("''", "'");
}
/** Shared metadata and reading presentation. The source is never rewritten on disk. */
export function wikiMetadata(text: string): { tags: string[]; title?: string; body: string; readingBody: string; minutes: number } {
	const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	const body = front ? text.slice(front[0].length) : text;
	const yaml = front?.[1] ?? "", tags = new Set<string>();
	const addTag = (value: string) => {
		const tag = scalar(value).replace(/^#/, "").trim();
		if (tag && !/^(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(tag)) tags.add(tag);
	};
	const field = /^tags?:[ \t]*(.*)$/m.exec(yaml);
	if (field?.[1].trim()) for (const item of field[1].replace(/^\[|\]$/g, "").split(/[,\s]+/)) addTag(item);
	if (field && !field[1].trim()) {
		for (const line of yaml.slice(field.index + field[0].length).split(/\r?\n/)) {
			if (!line.trim()) continue;
			const item = /^\s*-\s+(.+)$/.exec(line);
			if (!item) break;
			addTag(item[1]);
		}
	}
	const tree = parser.parse(body);
	let firstHeading: TextNode | undefined;
	visit(tree, node => {
		if (!firstHeading && node.type === "heading" && node.depth === 1) firstHeading = node;
		if (node.type === "text" && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
			const offset = node.position.start.offset, raw = body.slice(offset, node.position.end.offset);
			for (const match of raw.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
				if (match.index === 0 && raw.startsWith("#") && offset > 0 && !/\s/.test(body[offset - 1])) continue;
				addTag(match[1]);
			}
		}
	});
	const heading = firstHeading ? plain(firstHeading).trim() : undefined;
	const title = scalar(/^title:[ \t]*(.*)$/m.exec(yaml)?.[1] ?? "") || heading;
	let readingBody = body;
	if (title && heading === title.trim() && firstHeading?.position) {
		const { start, end } = firstHeading.position;
		if (start.offset !== undefined && end.offset !== undefined) readingBody = body.slice(0, start.offset) + body.slice(end.offset);
	}
	const prose = tree.children.map(node => plain(node)).join(" ");
	const chinese = (prose.match(/\p{Script=Han}/gu) ?? []).length;
	const words = (prose.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
	return { tags: [...tags].slice(0, 100), title, body, readingBody, minutes: Math.max(1, Math.ceil(chinese / 400 + words / 200)) };
}
/** Blank code ranges while preserving line/offset positions for link indexing. */
export function withoutCode(text: string): string {
	const tree = parser.parse(text), ranges: [number, number][] = [];
	visit(tree, node => {
		if ((node.type === "code" || node.type === "inlineCode") && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) ranges.push([node.position.start.offset, node.position.end.offset]);
	});
	let result = "", at = 0;
	for (const [start, end] of ranges) { result += text.slice(at, start) + text.slice(start, end).replace(/[^\n]/g, " "); at = end; }
	return result + text.slice(at);
}
/** Path lookups for resolving many links against one workspace listing. */
export type WikiLinkIndex = { paths: Set<string>; byName: Map<string, string[]> };
const linkName = (path: string) => (path.split("/").at(-1) ?? "").replace(/\.(md|txt)$/i, "");
export function wikiLinkIndex(paths: string[]): WikiLinkIndex {
	const byName = new Map<string, string[]>();
	for (const p of paths) { const name = linkName(p), list = byName.get(name); if (list) list.push(p); else byName.set(name, [p]); }
	return { paths: new Set(paths), byName };
}
export function resolveWikiLink(source: string, target: string, paths: string[] | WikiLinkIndex): string | undefined {
	let raw: string;
	try { raw = decodeURIComponent(target.split("|")[0].split("#")[0]).replaceAll("\\", "/"); } catch { return; }
	if (!raw || /^(?:[a-z]+:|\/)/i.test(raw)) return;
	const normalize = (v: string) => {
		const out: string[] = [];
		for (const p of v.split("/")) { if (p === "..") { if (!out.length) return ""; out.pop(); } else if (p && p !== ".") out.push(p); }
		return out.join("/");
	};
	const parent = source.includes("/") ? source.slice(0, source.lastIndexOf("/") + 1) : "";
	const index = Array.isArray(paths) ? wikiLinkIndex(paths) : paths;
	for (const candidate of [normalize(parent + raw), normalize(raw)]) {
		for (const p of [candidate, candidate + ".md", candidate + ".txt"]) if (index.paths.has(p)) return p;
	}
	const matches = index.byName.get(raw.replace(/\.(md|txt)$/i, "")) ?? [];
	return matches.length === 1 ? matches[0] : undefined;
}
export function wikiReferences(text: string): { target: string; snippet: string; line: number }[] {
	return withoutCode(text.replace(/`([^`\n]+\.[A-Za-z0-9]+)`/g, (_all, path: string) => `[[${path}]]`)).split(/\r?\n/).flatMap((line, index) => [...line.matchAll(/\[\[([^\]]+)\]\]|\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(m => ({ target: m[1] ?? m[2], snippet: line.trim().slice(0, 240), line: index + 1 })));
}
