export { wikiMetadata, resolveWikiLink } from "../../server/wiki-links.js";
import type { WikiEntry } from "../../server/protocol.js";

/** Turn Wiki links into safe Markdown URLs outside fenced and inline code. */
export function renderWikiLinks(body: string): string {
	let fenced = "";
	return body.split("\n").map(line => {
		const fence = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) { if (!fenced) fenced = fence[1]; else if (fence[1][0] === fenced[0] && fence[1].length >= fenced.length) fenced = ""; return line; }
		if (fenced) return line;
		return line.split(/(`+[^`]*`+)/g).map(part => part.startsWith("`") ? part : part.replace(/\[\[([^\]]+)\]\]/g, (_m, target: string) => {
			const label = target.split("|")[1] || target.split("|")[0];
			return `[${label.replace(/[\[\]]/g, "")}](#wiki=${encodeURIComponent(target.split("|")[0])})`;
		})).join("");
	}).join("\n");
}
export function wikiPrompt(input: string, current: string, selected: string, refs: string[], tag: string, entries: WikiEntry[], whole: boolean, allowCode: boolean, labels: { scope: string; selection: string; documentsOnly: string; skip: string }): string {
	const paths = [...new Set([...(current && !tag ? [current] : []), ...refs, ...entries.filter(e => tag && e.tags.includes(tag)).map(e => e.path)])];
	return `${input.trim()}\n\n${labels.scope}: ${whole ? "." : paths.map(p => JSON.stringify(p)).join(", ")}\n${allowCode ? "" : labels.documentsOnly + "\n"}${labels.skip}${selected ? `\n\n${labels.selection} (${JSON.stringify(current)}):\n${selected}` : ""}`;
}
