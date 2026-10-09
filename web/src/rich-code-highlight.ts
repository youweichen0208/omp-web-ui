import { richCodeText } from "./rich-code-text";
import { highlightLine, highlightWikiCode } from "./hljs-lite";

type Paint = { add: (range: Range) => void; delete: (range: Range) => void; size: number; priority: number };
const groups = ["plain", "keyword", "string", "number", "title", "comment"] as const;
type Group = typeof groups[number];
const category = (classes: DOMTokenList): Group | undefined => {
	if (["hljs-keyword", "hljs-type", "hljs-literal", "hljs-selector-tag"].some(name => classes.contains(name))) return "keyword";
	if (["hljs-string", "hljs-regexp", "hljs-addition"].some(name => classes.contains(name))) return "string";
	if (["hljs-number", "hljs-attr", "hljs-symbol", "hljs-bullet"].some(name => classes.contains(name))) return "number";
	if (["hljs-title", "hljs-built_in", "hljs-section"].some(name => classes.contains(name))) return "title";
	if (["hljs-comment", "hljs-quote", "hljs-meta", "hljs-deletion"].some(name => classes.contains(name))) return "comment";
};

/** Paint mutable code using ranges, leaving native selection, IME and undo DOM untouched. */
export function createRichCodeHighlighter(wiki = false) {
	const registry = (CSS as unknown as { highlights?: Map<string, Paint> }).highlights;
	const Constructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => Paint }).Highlight;
	const blocks = new Map<HTMLElement, { group: Group; range: Range }[]>();
	const baselines = new Map<HTMLElement, { html: string; language: string; nodes: Text[] }>();
	const clear = (code: HTMLElement) => {
		for (const { group, range } of blocks.get(code) ?? []) {
			const name = `rich-code-${group}`, paint = registry?.get(name);
			paint?.delete(range);
			if (paint?.size === 0) registry?.delete(name);
		}
		blocks.delete(code);
		baselines.delete(code);
	};
	const observed = new Set<HTMLElement>(), visible = new Set<HTMLElement>();
	const observer = wiki && typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(entries => {
		for (const entry of entries) {
			const code = entry.target as HTMLElement;
			if (entry.isIntersecting) { visible.add(code); api.update(code); }
			else visible.delete(code);
		}
	}, { rootMargin: "400px" }) : null;
	const api = {
		observe(code: HTMLElement) {
			if (!observer) { api.update(code); return; }
			for (const block of observed) if (!block.isConnected) { observer.unobserve(block); observed.delete(block); visible.delete(block); clear(block); }
			if (!observed.has(code)) { observed.add(code); observer.observe(code); }
			else if (visible.has(code)) api.update(code);
		},
		update(code: HTMLElement) {
			if (!registry || !Constructor) return;
			for (const block of blocks.keys()) if (!block.isConnected) clear(block);
			const language = code.className.match(/language-([^\s]+)/)?.[1] ?? "";
			const html = code.innerHTML, baseline = baselines.get(code);
			if (baseline?.html === html && baseline.language === language && baseline.nodes.every(node => code.contains(node))) return;
			clear(code);
			const text = richCodeText(code);
			if (!text) return;
			const template = document.createElement("template");
			template.innerHTML = (wiki ? highlightWikiCode : highlightLine)(text, language === "toml" ? "ini" : language);
			const nodes: { node: Text; start: number; end: number }[] = [];
			const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
			let node: Node | null, offset = 0;
			while ((node = walker.nextNode())) {
				if (node.nodeName === "BR") { offset++; continue; }
				if (node.nodeType !== Node.TEXT_NODE) continue;
				nodes.push({ node: node as Text, start: offset, end: offset + (node.textContent?.length ?? 0) });
				offset += node.textContent?.length ?? 0;
			}
			const ranges: { group: Group; range: Range }[] = [];
			const add = (group: Group, start: number, end: number) => {
				if (start === end) return;
				// Token offsets are ordered, but nested syntax groups can overlap.
				// Binary lookup keeps each range bounded without copying the node array.
				let low = 0, high = nodes.length;
				while (low < high) { const mid = (low + high) >>> 1; if (nodes[mid].end <= start) low = mid + 1; else high = mid; }
				const first = nodes[low];
				low = 0; high = nodes.length;
				while (low < high) { const mid = (low + high) >>> 1; if (nodes[mid].start < end) low = mid + 1; else high = mid; }
				const last = nodes[low - 1];
				if (!first || !last) return;
				const range = document.createRange();
				range.setStart(first.node, Math.max(0, start - first.start));
				range.setEnd(last.node, Math.min(last.node.length, end - last.start));
				const name = `rich-code-${group}`;
				let paint = registry.get(name);
				if (!paint) { paint = new Constructor(); paint.priority = group === "plain" ? 0 : 1; registry.set(name, paint); }
				paint.add(range); ranges.push({ group, range });
			};
			add("plain", 0, nodes.at(-1)?.end ?? 0);
			let at = 0;
			const visit = (node: Node, inherited?: Group) => {
				if (node.nodeType === Node.TEXT_NODE) {
					const end = at + (node.textContent?.length ?? 0);
					if (inherited) add(inherited, at, end);
					at = end; return;
				}
				const group = node instanceof Element ? category(node.classList) ?? inherited : inherited;
				node.childNodes.forEach(child => visit(child, group));
			};
			visit(template.content);
			blocks.set(code, ranges);
			baselines.set(code, { html, language, nodes: nodes.map(item => item.node) });
		},
		dispose() { observer?.disconnect(); observed.clear(); visible.clear(); for (const code of blocks.keys()) clear(code); },
	};
	return api;
}
