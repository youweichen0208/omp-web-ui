/**
 * Lean `highlight.js` setup for spots that need to color a single line of
 * code programmatically (the edit-tool diff view) rather than through the
 * Markdown → rehype-highlight pipeline (Markdown.tsx), which only operates
 * on whole fenced blocks.
 *
 * Uses `highlight.js/lib/core` + individually-registered language modules
 * (the same approach `lowlight`'s "common" bundle takes internally) instead
 * of importing the full `highlight.js` package, which registers all ~190
 * languages and would otherwise bloat the bundle. The language set here
 * matches ToolCallBlock.tsx's EXT_LANG map exactly, so anything read/write
 * can highlight, the diff view can highlight too.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("graphql", graphql);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("less", less);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("makefile", makefile);
hljs.registerLanguage("php", php);
hljs.registerLanguage("python", python);
hljs.registerLanguage("r", r);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Highlight a single line of code, returning `.hljs-*`-tagged HTML (same
 * classes the imported github-dark.css / each theme's light hljs override
 * already style — see themes/*.css tails). Falls back to plain escaped text
 * when `lang` is null/unregistered, or if highlighting throws for any reason
 * (malformed partial line, unsupported construct) — this must never crash
 * the diff view over a single odd line.
 */
export function highlightLine(code: string, lang: string | null): string {
	if (!lang || !hljs.getLanguage(lang)) return escapeHtml(code);
	try {
		return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
	} catch {
		return escapeHtml(code);
	}
}

/** Wiki's unlabelled fences use a bounded set of common languages. */
export function highlightWikiCode(code: string, lang: string): string {
	if (lang && lang !== "plaintext") return highlightLine(code, lang);
	try { return hljs.highlightAuto(code, ["bash", "python", "typescript", "json", "yaml", "sql"]).value; }
	catch { return escapeHtml(code); }
}

/** Extension → highlight.js language alias. Lives here (next to the hljs
 *  registration list it must stay in sync with) rather than in a component,
 *  so the tool-call cards and the file-preview panel share one map. */
const EXT_LANG: Record<string, string> = {
	json: "json",
	jsonc: "json",
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "typescript",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	kts: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	sql: "sql",
	css: "css",
	scss: "scss",
	less: "less",
	html: "xml",
	htm: "xml",
	xml: "xml",
	svg: "xml",
	yml: "yaml",
	yaml: "yaml",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	toml: "ini",
	ini: "ini",
	graphql: "graphql",
	gql: "graphql",
	lua: "lua",
	r: "r",
	makefile: "makefile",
	diff: "diff",
	patch: "diff",
};

/** hljs language for a file path by extension, or null when unrecognized. */
export function langFromPath(path: string): string | null {
	const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
	return (ext && EXT_LANG[ext]) || null;
}

/**
 * Highlight a whole file and return it split into per-line HTML.
 *
 * Not simply `highlightLine()` per line: constructs that span lines — block
 * comments, template/multi-line strings — are not valid on their own, so
 * line-by-line highlighting silently fails to color them (a file whose
 * header is one big block comment would come out entirely plain). Instead
 * the file is highlighted in one pass and the resulting HTML is split on
 * newlines, closing every open `<span>` at the end of each line and
 * reopening the same stack on the next, which is what keeps a construct
 * spanning N lines colored on all N.
 *
 * hljs output is limited to `<span class="...">`, `</span>` and escaped
 * text, so the tiny scanner below is sufficient. If it ever drifts out of
 * step with the raw line count, the plain escaped text is returned instead
 * of shipping mismatched markup.
 */
export function highlightLines(code: string, lang: string | null): string[] {
	const raw = code.split("\n");
	if (!lang || !hljs.getLanguage(lang)) return raw.map(escapeHtml);

	let html: string;
	try {
		html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
	} catch {
		return raw.map(escapeHtml);
	}

	const out: string[] = [];
	const open: string[] = [];
	let cur = "";
	let i = 0;
	while (i < html.length) {
		if (html[i] === "<") {
			const end = html.indexOf(">", i);
			if (end === -1) {
				cur += html.slice(i);
				break;
			}
			const tag = html.slice(i, end + 1);
			if (tag.startsWith("</")) open.pop();
			else if (!tag.endsWith("/>")) open.push(tag);
			cur += tag;
			i = end + 1;
			continue;
		}
		const nl = html.indexOf("\n", i);
		const lt = html.indexOf("<", i);
		const stop = Math.min(
			nl === -1 ? Number.POSITIVE_INFINITY : nl,
			lt === -1 ? Number.POSITIVE_INFINITY : lt,
		);
		if (stop === Number.POSITIVE_INFINITY) {
			cur += html.slice(i);
			break;
		}
		cur += html.slice(i, stop);
		if (stop === nl) {
			out.push(cur + "</span>".repeat(open.length));
			cur = open.join("");
			i = stop + 1;
		} else {
			i = stop;
		}
	}
	out.push(cur + "</span>".repeat(open.length));

	return out.length === raw.length ? out : raw.map(escapeHtml);
}
