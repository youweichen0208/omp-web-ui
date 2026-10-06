import { unified } from "unified";
import remarkParse from "remark-parse";
import type { RootContent, PhrasingContent } from "mdast";

const parser = unified().use(remarkParse);
export type WikiReplyPart = { kind: "text"; text: string } | { kind: "card"; title: string; text: string; section: number | null };
const plain = (node: PhrasingContent): string => "value" in node ? node.value : "children" in node ? node.children.map(plain).join("") : "";

/** Display-only: recognize titled list items without prescribing an agent response format. */
export function wikiReplyParts(text: string): WikiReplyPart[] {
	const parts: WikiReplyPart[] = [];
	let offset = 0;
	for (const node of parser.parse(text).children as RootContent[]) {
		if (node.type !== "list" || !node.children.every(item => item.children[0]?.type === "paragraph" && item.children[0].children[0]?.type === "strong")) continue;
		const start = node.position?.start.offset, end = node.position?.end.offset;
		if (start === undefined || end === undefined) continue;
		if (start > offset) parts.push({ kind: "text", text: text.slice(offset, start) });
		for (const item of node.children) {
			const paragraph = item.children[0];
			if (paragraph.type !== "paragraph") continue;
			const titleNode = paragraph.children[0];
			if (titleNode.type !== "strong") continue;
			const title = titleNode.children.map(plain).join("");
			const body = text.slice(titleNode.position!.end.offset, item.position!.end.offset).trim().replace(/^[:：—–]\s*/, "");
			const reference = /(?:§\s*(\d+)|第\s*(\d+)\s*节|\bsection\s+(\d+)\b)/i.exec(`${title}\n${body}`);
			parts.push({ kind: "card", title, text: body, section: reference ? Number(reference[1] ?? reference[2] ?? reference[3]) : null });
		}
		offset = end;
	}
	if (offset < text.length) parts.push({ kind: "text", text: text.slice(offset) });
	return parts;
}

export function wikiSectionIndex(headings: string[], section: number): number {
	const numbered = headings.map(text => /^\s*(?:第\s*)?(\d+)\s*(?:[.、．）)]|节|\s)/.exec(text)?.[1]);
	if (numbered.some(Boolean)) return numbered.findIndex(n => Number(n) === section);
	return section >= 1 && section <= headings.length ? section - 1 : -1;
}

export function wikiHeadingTexts(text: string): string[] {
	return parser.parse(text).children.flatMap(node => node.type === "heading" && node.depth === 2 ? [node.children.map(plain).join("")] : []);
}

/** Headings in code examples do not count; a parent with subsections is not empty. */
export function wikiHasEmptySections(text: string): boolean {
	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
	const nodes = parser.parse(body).children;
	return nodes.some((node, index) => {
		const next = nodes[index + 1];
		return node.type === "heading" && (!next || (next.type === "heading" && next.depth <= node.depth));
	});
}
