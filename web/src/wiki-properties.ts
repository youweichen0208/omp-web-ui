import { unified } from "unified";
import remarkParse from "remark-parse";

/** Only a consecutive opening group of key/value paragraphs is document metadata. */
export function wikiProperties(source: string) {
	const front = source.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/)?.[0].length ?? 0;
	const nodes = unified().use(remarkParse).parse(source).children.filter(node => (node.position?.start.offset ?? 0) >= front);
	if (nodes[0]?.type === "heading" && nodes[0].depth === 1) nodes.shift();
	const rows: { key: string; value: string }[] = [];
	const ranges: { start: number; end: number }[] = [];
	for (const node of nodes) {
		if (node.type !== "paragraph") break;
		const start = node.position!.start.offset!, end = node.position!.end.offset!;
		const lines = source.slice(start, end).split(/\r?\n/).map(line => line.replace(/(?:\\| {2,})$/, "").trim());
		const matches = lines.map(line => /^(?:\*\*)?([\p{L}\p{N}_ -]{1,40})(?:\*\*)?[：:]\s*(.+)$/u.exec(line));
		if (matches.some(match => !match)) break;
		for (const match of matches) rows.push({ key: match![1].trim(), value: match![2] });
		ranges.push({ start, end });
	}
	return rows.length >= 2 ? { rows, ranges } : { rows: [], ranges: [] };
}
