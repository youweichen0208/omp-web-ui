import { unified } from "unified";
import remarkParse from "remark-parse";

/** `Key: value`, `**Key**: value` or `**Key:** value`; full-width colons too. */
const PROPERTY = /^(?:\*\*([\p{L}\p{N}_ -]{1,40})[：:]\*\*|(?:\*\*)?([\p{L}\p{N}_ -]{1,40})(?:\*\*)?[：:])\s*(.+)$/u;
const propertyLine = (line: string) => line.replace(/(?:\\| {2,})$/, "").trim();

/** Parse metadata plus a small boundary witness. A body line is enough to
 * invalidate a continued property paragraph; parsing all of its inline
 * Markdown (potentially megabytes) on every keystroke is unnecessary. */
function openingRegion(source: string, from: number): string {
	let heading = false, content = false;
	const lines = /[^\n]*(?:\n|$)/g;
	lines.lastIndex = from;
	for (let match = lines.exec(source); match && match[0]; match = lines.exec(source)) {
		const line = propertyLine(match[0]);
		if (!line) continue;
		if (!content && !heading && /^# /.test(line)) { heading = true; continue; }
		content = true;
		if (!PROPERTY.test(line)) {
			const end = match.index + match[0].length;
			// Setext underlines change the preceding paragraph's block type.
			const underline = source.slice(end).match(/^ {0,3}(?:=+|-+)[ \t]*(?:\r?\n|$)/)?.[0] ?? "";
			const witness = match[0].replace(/^[ \t]{4,}/, "    ");
			return source.slice(0, match.index) + witness.slice(0, 256).trimEnd() + "\n" + underline;
		}
	}
	return source;
}

/** Only a consecutive opening group of key/value paragraphs is document metadata.
 * Runs on every keystroke, so only the opening region is parsed. */
export function wikiProperties(source: string) {
	const front = source.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/)?.[0].length ?? 0;
	const region = openingRegion(source, front);
	const nodes = unified().use(remarkParse).parse(region).children.filter(node => (node.position?.start.offset ?? 0) >= front);
	if (nodes[0]?.type === "heading" && nodes[0].depth === 1) nodes.shift();
	const rows: { key: string; value: string }[] = [];
	const ranges: { start: number; end: number }[] = [];
	for (const node of nodes) {
		if (node.type !== "paragraph") break;
		const start = node.position!.start.offset!, end = node.position!.end.offset!;
		const matches = source.slice(start, end).split(/\r?\n/).map(line => PROPERTY.exec(propertyLine(line)));
		if (matches.some(match => !match)) break;
		for (const match of matches) rows.push({ key: (match![1] ?? match![2]).trim(), value: match![3] });
		ranges.push({ start, end });
	}
	return rows.length >= 2 ? { rows, ranges } : { rows: [], ranges: [] };
}
