/** Shared, deterministic Wiki indexing rules (no filesystem access). */
export function wikiMetadata(text: string): { tags: string[]; title?: string; body: string } {
	const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	const body = front ? text.slice(front[0].length) : text;
	const tags = new Set<string>();
	const yaml = front?.[1] ?? "";
	const field = /^tags?:[ \t]*(.*)$/m.exec(yaml);
	if (field?.[1].trim()) for (const item of field[1].replace(/[\[\]'"#]/g, "").split(/[,\s]+/)) if (item) tags.add(item);
	if (field && !field[1].trim()) {
		const rest = yaml.slice(field.index + field[0].length);
		for (const line of rest.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const item = /^\s+-\s+["']?#?([^"'\s]+)["']?\s*$/.exec(line);
			if (!item) break;
			tags.add(item[1]);
		}
	}
	for (const match of withoutCode(body).matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(match[1]);
	return { tags: [...tags].slice(0, 100), title: /^#\s+(.+)$/m.exec(body)?.[1], body };
}
export function withoutCode(text: string): string {
	return text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, m => m.replace(/[^\n]/g, " ")).replace(/`[^`\n]*`/g, m => " ".repeat(m.length));
}
export function resolveWikiLink(source: string, target: string, paths: string[]): string | undefined {
	let raw: string;
	try { raw = decodeURIComponent(target.split("|")[0].split("#")[0]).replaceAll("\\", "/"); } catch { return; }
	if (!raw || /^(?:[a-z]+:|\/)/i.test(raw)) return;
	const normalize = (v: string) => {
		const out: string[] = [];
		for (const p of v.split("/")) { if (p === "..") { if (!out.length) return ""; out.pop(); } else if (p && p !== ".") out.push(p); }
		return out.join("/");
	};
	const parent = source.includes("/") ? source.slice(0, source.lastIndexOf("/") + 1) : "";
	for (const candidate of [normalize(parent + raw), normalize(raw)]) {
		for (const p of [candidate, candidate + ".md", candidate + ".txt"]) if (paths.includes(p)) return p;
	}
	const matches = paths.filter(p => p.split("/").at(-1)?.replace(/\.(md|txt)$/i, "") === raw.replace(/\.(md|txt)$/i, ""));
	return matches.length === 1 ? matches[0] : undefined;
}
export function wikiReferences(text: string): { target: string; snippet: string; line: number }[] {
	return withoutCode(text.replace(/`([^`\n]+\.[A-Za-z0-9]+)`/g, (_all, path: string) => `[[${path}]]`)).split(/\r?\n/).flatMap((line, index) => [...line.matchAll(/\[\[([^\]]+)\]\]|\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(m => ({ target: m[1] ?? m[2], snippet: line.trim().slice(0, 240), line: index + 1 })));
}
