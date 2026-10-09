import { WikiTableIcon, WikiQuoteIcon } from "./WikiIcons";
import { WikiToolbar, WikiInsertPopover, type WikiInsertPopup } from "./WikiToolbar";
import { TableSizePicker } from "./TableSizePicker";
import { CodeLanguagePicker } from "./CodeLanguagePicker";
import { MermaidDiagram } from "./MermaidDiagram";
import { createPortal } from "react-dom";
import { WikiReadingDialog } from "./WikiReading";
import { TEXT_HIGHLIGHT_COLORS } from "../remark-text-highlight";
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FiCalendar, FiBold, FiItalic, FiRotateCcw, FiRotateCw, FiSquare, FiType, FiCode, FiList, FiCheckSquare, FiMinus, FiLink, FiImage } from "react-icons/fi";
import { markdownImageUrl } from "../markdown-image";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import { richCodeText } from "../rich-code-text";
import { highlightLine } from "../hljs-lite";
import { createRichCodeHighlighter } from "../rich-code-highlight";
import { useT } from "../i18n";
import { mountRichDocument, prepareRichDocument, readRichDocument } from "../rich-markdown";
import type { RichDocument } from "../rich-markdown";

const CODE_LANGUAGES = ["javascript", "typescript", "python", "bash", "json", "yaml", "html", "css", "sql", "go", "rust", "java", "c", "cpp", "csharp", "ruby", "php", "swift", "kotlin", "markdown", "xml", "toml", "diff", "mermaid"];

export const RichMarkdownEditor = memo(function RichMarkdownEditor({ value, readOnly, onChange, file, wiki }: {
	file: { cwd: string; path: string };
	wiki?: { paths: string[]; ask: (text: string) => void; followLink: (href: string) => void; resolveCode: (value: string) => string | undefined; added: Set<string>; toolbarHost?: HTMLElement | null; focused?: boolean; onWidth?: () => void };
	value: string;
	readOnly: boolean;
	onChange: (value: string) => void;
}) {
	const t = useT();
	const [insertPopup, setInsertPopup] = useState<WikiInsertPopup | null>(null);
	const savedRange = useRef<Range | null>(null);
	const [diagrams, setDiagrams] = useState<{ host: HTMLElement; code: string }[]>([]);
	const didFocus = useRef(false);
	const [uploading, setUploading] = useState(false);
	const [imageError, setImageError] = useState("");
	const upload = useRef<AbortController | null>(null);
	const readOnlyRef = useRef(readOnly);
	readOnlyRef.current = readOnly;
	useEffect(() => () => { upload.current?.abort(); }, []);

	const root = useRef<HTMLDivElement>(null);
	const codeHighlighter = useRef<ReturnType<typeof createRichCodeHighlighter> | null>(null);
	useEffect(() => () => { codeHighlighter.current?.dispose(); codeHighlighter.current = null; }, []);
	const paintCode = (code: HTMLElement, lazy = false) => {
		codeHighlighter.current ??= createRichCodeHighlighter(!!wiki);
		if (lazy) codeHighlighter.current.observe(code);
		else codeHighlighter.current.update(code);
	};
	const selectedCode = () => {
		const selection = window.getSelection(), node = selection?.anchorNode;
		const element = node instanceof Element ? node : node?.parentElement;
		const code = element?.closest<HTMLElement>("pre > code");
		return code && root.current?.contains(code) && selection?.focusNode && code.contains(selection.focusNode) ? code : null;
	};
	const [floating, setFloating] = useState<{ x: number; y: number } | null>(null);
	const [linkInput, setLinkInput] = useState<string | null>(null);
	const linkRange = useRef<Range | null>(null), imageRange = useRef<Range | null>(null);
	const imageInput = useRef<HTMLInputElement>(null);
	const popup = useRef<HTMLDivElement>(null), floatingToolbar = useRef<HTMLDivElement>(null);
	const [canHighlight, setCanHighlight] = useState(false);
	const highlightSelection = () => {
		const selection = window.getSelection();
		if (!selection?.rangeCount || selection.isCollapsed || !root.current?.contains(selection.anchorNode) || !root.current.contains(selection.focusNode)) return null;
		const range = selection.getRangeAt(0);
		if ([...root.current.querySelectorAll("pre, code, [contenteditable=false]")].some(node => range.intersectsNode(node))) return null;
		return range;
	};
	useEffect(() => {
		const changed = () => {
			const selection = window.getSelection();
			if (selection?.rangeCount && root.current?.contains(selection.anchorNode) && root.current.contains(selection.focusNode)) savedRange.current = selection.getRangeAt(0).cloneRange();
			root.current?.querySelectorAll("[data-wiki-placeholder]").forEach(el => el.removeAttribute("data-wiki-placeholder"));
			const anchor = selection?.anchorNode;
			const paragraph = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest("p, div");
			if (wiki && paragraph && paragraph !== root.current && root.current?.contains(paragraph) && !paragraph.textContent?.trim() && !paragraph.querySelector("img, code")) paragraph.setAttribute("data-wiki-placeholder", t("wikiEmptyParagraph"));
			const range = highlightSelection(); setCanHighlight(!!range);
			if (!range) { setFloating(null); return; }
			const rect = range.getBoundingClientRect();
			if (rect.bottom < 0 || rect.top > window.innerHeight) { setFloating(null); return; }
			setFloating({ x: Math.max(8, Math.min(rect.left + rect.width / 2 - 160, window.innerWidth - 328)), y: rect.top >= 50 ? rect.top - 46 : Math.min(rect.bottom + 8, window.innerHeight - 46) });
		};
		document.addEventListener("selectionchange", changed);
		window.addEventListener("scroll", changed, true);
		window.addEventListener("resize", changed);
		return () => { document.removeEventListener("selectionchange", changed); window.removeEventListener("scroll", changed, true); window.removeEventListener("resize", changed); };
	}, []);
	useLayoutEffect(() => {
		const toolbar = floatingToolbar.current, range = highlightSelection();
		if (!toolbar || !range) return;
		const rect = range.getBoundingClientRect();
		toolbar.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - toolbar.offsetWidth / 2, window.innerWidth - toolbar.offsetWidth - 8))}px`;
		toolbar.style.top = `${Math.max(8, rect.top >= toolbar.offsetHeight + 8 ? rect.top - toolbar.offsetHeight - 8 : Math.min(rect.bottom + 8, window.innerHeight - toolbar.offsetHeight - 8))}px`;
	}, [floating]);
	const documentState = useRef<RichDocument | null>(null);
	const [menu, setMenu] = useState<{ query: string; x: number; y: number } | null>(null);
	const [active, setActive] = useState(0);
	const [tableCell, setTableCell] = useState<HTMLTableCellElement | null>(null);
	const slashRange = useRef<Range | null>(null);
	const closeMenu = () => { slashRange.current = null; setMenu(null); };
	const emitted = useRef<string | null>(null);
	useLayoutEffect(() => {
		if (!root.current || value === emitted.current) return;
		closeMenu();
		setTableCell(null);
		const prepared = prepareRichDocument(value, !!wiki);
		mountRichDocument(root.current, prepared, t("richSourceBlock"));
		if (wiki) {
			root.current.querySelectorAll<HTMLElement>("pre:has(> code)").forEach(pre => pre.classList.add("codeblock"));
			root.current.querySelectorAll<HTMLElement>("h2").forEach((heading, index) => { heading.id = `wiki-heading-${index}`; });
			root.current.querySelectorAll<HTMLElement>("p").forEach(p => { if ([...wiki.added].some(line => line.trim() && p.textContent?.includes(line))) p.classList.add("wiki-added"); });
			root.current.querySelectorAll<HTMLElement>("code").forEach(code => {
				if (code.closest("pre") || !wiki.resolveCode(code.textContent ?? "")) return;
				const link = document.createElement("a"); link.href = `#wiki=${encodeURIComponent(code.textContent ?? "")}`;
				link.textContent = code.textContent; code.replaceChildren(link);
			});
			// Decoration belongs to the render baseline, not to a user's edit.
			root.current.querySelectorAll<HTMLElement>("[data-rich-block]").forEach(block => { prepared.blocks[Number(block.dataset.richBlock)].html = block.innerHTML; });
		}
		documentState.current = prepared;
		emitted.current = value;
	}, [value, t]);
	useLayoutEffect(() => {
		if (!wiki || !root.current) return;
		root.current.querySelectorAll<HTMLElement>("p").forEach(p => p.classList.toggle("wiki-added", [...wiki.added].some(line => line.trim() && p.textContent?.includes(line))));
	}, [wiki?.added, value]);
	useLayoutEffect(() => {
		if (readOnly) closeMenu();
		root.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => { input.disabled = readOnly; });
	}, [readOnly, value]);
	useLayoutEffect(() => {
		root.current?.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
			const pre = code.parentElement!;
			if (wiki) pre.classList.add("codeblock");
			let control = pre.querySelector<HTMLSelectElement>("select[data-code-language]");
			if (!control) {
				const chrome = document.createElement("span");
				chrome.dataset.richUi = "";
				chrome.contentEditable = "false";
				chrome.className = "fp-code-language";
				control = document.createElement("select");
				control.dataset.codeLanguage = "";
				chrome.append(control);
				if (wiki) {
					const copy = document.createElement("button"); copy.type = "button"; copy.textContent = t("copy");
					copy.onmousedown = event => event.preventDefault();
					copy.onclick = () => { void navigator.clipboard.writeText(richCodeText(code)); };
					chrome.append(copy);
				}
				pre.prepend(chrome);
			}
			const detected = code.className.match(/language-([^\s]+)/)?.[1] ?? "";
			const language = detected === "plaintext" ? "" : detected;
			control.replaceChildren();
			for (const lang of ["", ...new Set([...CODE_LANGUAGES, ...(language ? [language] : [])])]) {
				control.add(new Option(lang || t(wiki ? "wikiCodeAutomatic" : "richPlainText"), lang));
			}
			control.value = language;
			control.disabled = readOnly;
			control.setAttribute("aria-label", t("richCodeLanguage"));
			paintCode(code, true);
		});
	}, [value, readOnly, t]);
	useLayoutEffect(() => {
		root.current?.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
			const source = img.dataset.richImageSrc ?? img.getAttribute("src") ?? "";
			if (!source || /^(?:[a-z]+:|\/\/|#)/i.test(source)) return;
			img.dataset.richImageSrc = source;
			img.src = markdownImageUrl(source, file);
		});
	}, [value, file.cwd, file.path]);
	useEffect(() => {
		if (!wiki || readOnly || didFocus.current || !root.current) return;
		didFocus.current = true;
		root.current.focus({ preventScroll: true });
		const range = document.createRange(); range.selectNodeContents(root.current); range.collapse(false);
		window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); savedRange.current = range.cloneRange();
	}, [readOnly]);
	useLayoutEffect(() => {
		if (!wiki || !root.current) return;
		const next: { host: HTMLElement; code: string }[] = [];
		root.current.querySelectorAll<HTMLElement>('pre > code.language-mermaid').forEach(code => {
			const pre = code.parentElement!;
			let host = pre.querySelector<HTMLElement>('.wiki-mermaid-preview');
			if (!host) { host = document.createElement('div'); host.dataset.richUi = ''; host.contentEditable = 'false'; host.className = 'wiki-mermaid-preview'; pre.prepend(host); }
			next.push({ host, code: richCodeText(code) });
		});
		root.current.querySelectorAll<HTMLElement>('.wiki-mermaid-preview').forEach(host => { if (!next.some(item => item.host === host)) host.remove(); });
		setDiagrams(next);
	}, [value]);
	const selectedCell = () => {
		const node = window.getSelection()?.anchorNode;
		const element = node instanceof Element ? node : node?.parentElement;
		const cell = element?.closest<HTMLTableCellElement>("th, td") ?? null;
		return cell && root.current?.contains(cell) ? cell : null;
	};
	const focusCell = (cell: HTMLTableCellElement) => {
		root.current?.focus();
		const range = document.createRange();
		range.selectNodeContents(cell); range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges(); selection?.addRange(range);
		setTableCell(cell);
	};
	const editTable = (action: "row" | "column" | "removeRow" | "removeColumn", target = tableCell) => {
		if (readOnly || !target || !root.current?.contains(target)) return;
		const table = target.closest("table")!;
		const row = target.parentElement as HTMLTableRowElement;
		const column = target.cellIndex;
		let next = target;
		if (action === "row") {
			const added = document.createElement("tr");
			for (const header of Array.from(table.rows[0].cells)) {
				const cell = added.insertCell();
				cell.style.textAlign = header.style.textAlign;
				cell.append(document.createElement("br"));
			}
			if (row.parentElement?.tagName === "THEAD") (table.tBodies[0] ?? table.createTBody()).prepend(added);
			else row.after(added);
			next = added.cells[0];
		} else if (action === "column") {
			for (const current of Array.from(table.rows)) {
				const cell = document.createElement(current.cells[0].tagName === "TH" ? "th" : "td");
				cell.style.textAlign = current.cells[column].style.textAlign;
				if (cell.tagName === "TH") cell.textContent = t("richColumn");
				else cell.append(document.createElement("br"));
				current.cells[column].after(cell);
				if (current === row) next = cell;
			}
		} else if (action === "removeRow") {
			if (row.rowIndex === 0 || table.rows.length <= 2) return;
			next = table.rows[row.rowIndex - 1].cells[column];
			row.remove();
		} else {
			if (row.cells.length <= 1) return;
			next = row.cells[column > 0 ? column - 1 : 1];
			for (const current of Array.from(table.rows)) current.deleteCell(column);
		}
		focusCell(next);
		update();
	};
	const pasteImage = async (image: File) => {
		if (readOnlyRef.current || upload.current || !root.current) return;
		const selection = window.getSelection();
		if (!selection?.rangeCount || !root.current.contains(selection.anchorNode)) return;
		const range = selection.getRangeAt(0).cloneRange();
		const controller = new AbortController();
		upload.current = controller;
		setUploading(true);
		setImageError("");
		try {
			if (image.size > 5 * 1024 * 1024) throw new Error(t("richImageTooLarge"));
			const data = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result).split(",")[1]);
				reader.onerror = () => reject(new Error(t("richImageFailed")));
				reader.readAsDataURL(image);
			});
			if (controller.signal.aborted) return;
			const response = await fetch(withToken("/api/markdown-image"), {
				method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
				body: JSON.stringify({ clientId: getClientId(), cwd: file.cwd, path: file.path, data }),
			});
			if (!response.ok) throw new Error(t("richImageFailed"));
			const result = await response.json();
			if (typeof result.path !== "string") throw new Error(t("richImageFailed"));
			if (controller.signal.aborted) return;
			if (readOnlyRef.current || !root.current?.contains(range.startContainer)) throw new Error(t("richImageFailed"));
			root.current.focus();
			selection.removeAllRanges();
			selection.addRange(range);
			const img = document.createElement("img");
			img.setAttribute("src", result.path);
			img.setAttribute("alt", image.name || "screenshot");
			document.execCommand("insertHTML", false, img.outerHTML);
			update();
		} catch (error) {
			if (!controller.signal.aborted) setImageError((error as Error).message);
		} finally {
			if (!controller.signal.aborted) setUploading(false);
			if (upload.current === controller) upload.current = null;
		}
	};
	const changeLanguage = (control: HTMLSelectElement) => {
		const pre = control.closest("pre");
		const code = pre?.querySelector("code");
		if (readOnly || !pre || !code || !root.current?.contains(pre)) return;
		const language = control.value;
		// Language metadata is separate from native text editing. Do not replace the
		// pre element: Chromium can inherit its old CODE wrapper during insertHTML.
		code.className = `hljs language-${language || "plaintext"}`;
		code.innerHTML = highlightLine(richCodeText(code), language === "toml" ? "ini" : language);
		if (!code.textContent) code.append(document.createElement("br"));
		root.current.focus();
		const range = document.createRange();
		range.selectNodeContents(code);
		range.collapse(false);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		update();
	};
	const update = () => {
		if (readOnly || !root.current || !documentState.current) return;
		const next = readRichDocument(root.current, documentState.current);
		emitted.current = next;
		onChange(next);
	};
	const command = (name: string, argument?: string) => {
		if (readOnly || !root.current) return;
		const selection = window.getSelection();
		if (!selection?.anchorNode || !root.current.contains(selection.anchorNode)) root.current.focus();
		document.execCommand(name, false, argument);
		update();
	};
	const allItems = [
		...((wiki ? [1, 2, 3] : [1, 2, 3, 4, 5, 6]) as (1 | 2 | 3 | 4 | 5 | 6)[]).map(level => ({ label: "richHeading", keywords: `heading header title h${level} bt${level} biaoti${level} 标题${level}`, alias: `bt${level}`, action: "formatBlock", argument: `h${level}` } as const)),
		{ label: "richParagraph", alias: "zw", keywords: "paragraph text zw zhengwen 正文", action: "formatBlock", argument: "p" },
		{ label: "richCodeBlock", alias: "dmk", keywords: "code fence dmk daimakuai 代码 代码块", action: "insertHTML", argument: "<pre><code data-slash-insert><br></code></pre><p><br></p>" },
		{ label: "richHighlightBlock", alias: "glk", keywords: "highlight note callout glk gaoliangkuai ts tishi 高亮 提示", action: "insertHTML", argument: '<blockquote class="rich-highlight" data-rich-highlight="note"><p data-slash-insert><br></p></blockquote><p><br></p>' },
		{ label: "richTable", alias: "bg", keywords: "table bg biaoge 表格", action: "insertHTML", argument: `<table><thead><tr><th data-slash-insert>${t("richColumn")} 1</th><th>${t("richColumn")} 2</th></tr></thead><tbody><tr><td>…</td><td>…</td></tr></tbody></table><p><br></p>` },
		{ label: "richList", alias: "lb", keywords: "bullet list lb liebiao wxlb wuxuliebiao 列表 无序列表", action: "insertUnorderedList" },
		{ label: "richOrderedList", alias: "bh", keywords: "number ordered bh bianhao yxlb youxuliebiao 编号 有序列表", action: "insertOrderedList" },
		{ label: "richTaskList", alias: "rw", keywords: "task todo checkbox rw rwlb renwu renwuliebiao 任务", action: "insertHTML", argument: '<ul><li><input type="checkbox"><span data-slash-insert> </span></li></ul><p><br></p>' },
		{ label: "richQuote", alias: "yy", keywords: "quote yy yinyong 引用", action: "formatBlock", argument: "blockquote" },
		{ label: "richDivider", alias: "fgx", keywords: "divider horizontal rule fgx fengexian 分隔线", action: "insertHTML", argument: "<hr><p><br></p>" },
			{ label: "richImage", alias: "tp", keywords: "image photo upload tp tupian 图片", action: "image" },
		{ label: "richWikiLink", alias: "sl", keywords: "wiki link document sl shuanglian 链接 双链 文档", action: "wikiLink" },
			{ label: "wikiMentionDate", alias: "date", keywords: "date mention riqi 日期", action: "insertText", argument: new Date().toLocaleDateString("sv-SE") },
	] as const;
	const wikiOrder = ["zw", "bt2", "bt3", "lb", "bg", "tp", "rw", "yy", "dmk", "sl", "date"];
	const items = wiki ? allItems.filter(item => wikiOrder.includes(item.alias)).sort((a, b) => wikiOrder.indexOf(a.alias) - wikiOrder.indexOf(b.alias)) : allItems.filter(item => item.alias !== "date");
	const icons = { wikiMentionDate: <FiCalendar />, richImage: <FiImage />, richWikiLink: <FiLink />, richHighlightBlock: <FiSquare />, richHeading: <FiType />, richParagraph: <FiType />, richCodeBlock: <FiCode />, richTable: <WikiTableIcon />, richList: <FiList />, richOrderedList: <FiList />, richTaskList: <FiCheckSquare />, richQuote: <WikiQuoteIcon />, richDivider: <FiMinus /> };
	const itemLabel = (item: typeof items[number]) => item.label === "richHeading" ? `${t(item.label)} ${"argument" in item ? item.argument.slice(1) : ""}` : t(item.label);
	const isBlock = (item: typeof items[number]) => item.action === "insertHTML";
	const hints: Record<string, string> = { date: "@", zw: "", bt1: "#", bt2: "##", bt3: "###", lb: "-", bh: "1.", rw: "[]", yy: ">", dmk: "```", glk: ":::", bg: "3 × 3", fgx: "---", tp: "![]", sl: "[[" };
	const help: Record<string, Parameters<typeof t>[0]> = { date: "wikiInsertDate", zw: "wikiInsertParagraph", bt1: "wikiInsertH1", bt2: "wikiInsertH2", bt3: "wikiInsertH3", lb: "wikiInsertList", bh: "wikiInsertOrdered", rw: "wikiInsertTask", yy: "wikiInsertQuote", dmk: "wikiInsertCode", glk: "wikiInsertCallout", bg: "wikiInsertTable", fgx: "wikiInsertDivider", tp: "wikiInsertImage", sl: "wikiInsertLink" };
	const matches = items.filter(item => wiki || !["image", "wikiLink"].includes(item.action)).filter((item) => `${itemLabel(item)} ${item.keywords}`.toLowerCase().includes(menu?.query.toLowerCase() ?? "")).sort((a, b) => wiki ? wikiOrder.indexOf(a.alias) - wikiOrder.indexOf(b.alias) : Number(isBlock(a)) - Number(isBlock(b)));
	const prepareInsert = () => {
		const selection = window.getSelection();
		if (selection?.rangeCount && root.current?.contains(selection.anchorNode)) savedRange.current = selection.getRangeAt(0).cloneRange();
	};
	const restoreInsert = () => {
		if (!root.current || readOnly) return false;
		root.current.focus({ preventScroll: true });
		const range = savedRange.current && root.current.contains(savedRange.current.startContainer) ? savedRange.current : document.createRange();
		if (!savedRange.current || !root.current.contains(range.startContainer)) { range.selectNodeContents(root.current); range.collapse(false); }
		const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); return true;
	};
	const insertToolbar = (id: string, dimensions?: { columns: number; rows: number }, language?: string, popupAnchor?: Pick<DOMRect, "left" | "bottom">) => {
		if (!restoreInsert()) return;
		const anchor = window.getSelection()?.anchorNode;
		const originalBlock = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest("p,h1,h2,h3,h4,h5,h6");
		const blockParent = originalBlock?.parentElement;
		const emptyBlock = !originalBlock?.textContent?.trim();
		let formattedTag: string | undefined;
		if ((id === "bg" && !dimensions) || (id === "dmk" && language === undefined)) {
			const rect = popupAnchor ?? savedRange.current?.getBoundingClientRect();
			setInsertPopup({ kind: id === "bg" ? "table" : "code", x: insertPopup?.x ?? rect?.left ?? 16, y: insertPopup?.y ?? (rect?.bottom ?? 80) + 6 }); return;
		}
		setInsertPopup(null);
		if (id === "bg" && dimensions) {
			command("insertHTML", `<table><thead><tr>${Array.from({ length: dimensions.columns }, (_, i) => `<th ${i === 0 ? 'data-slash-insert' : ''}>${t("richColumn")} ${i + 1}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: dimensions.rows - 1 }, () => `<tr>${'<td><br></td>'.repeat(dimensions.columns)}</tr>`).join('')}</tbody></table><p><br></p>`);
		} else if (id === "dmk") command("insertHTML", `<pre><code data-slash-insert class="language-${language || 'plaintext'}">${language === 'mermaid' ? 'flowchart LR\n  A --> B' : '<br>'}</code></pre><p><br></p>`);
		else {
			const item = items.find(item => item.alias === id); if (!item) return;
			if (item.action === "image") { imageRange.current = window.getSelection()?.getRangeAt(0).cloneRange() ?? null; imageInput.current?.click(); return; }
			if (item.action === "wikiLink") { command("insertText", "[["); const range = window.getSelection()?.getRangeAt(0).cloneRange(); if (range && range.startOffset >= 2) range.setStart(range.startContainer, range.startOffset - 2); linkRange.current = range ?? null; setLinkInput("[["); return; }
			if (item.action === "formatBlock") formattedTag = item.argument;
			command(item.action, "argument" in item ? item.argument : undefined);
		}
		const target = root.current?.querySelector("[data-slash-insert]") ?? (emptyBlock && formattedTag ? blockParent?.querySelector(formattedTag) : null);
		if (target) { target.removeAttribute("data-slash-insert"); const range = document.createRange(); range.selectNodeContents(target); range.collapse(true); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); update(); }
		prepareInsert();
	};
	const inspectSlash = () => {
		if (readOnly) return closeMenu();
		const selection = window.getSelection();
		if (!selection?.isCollapsed || !selection.anchorNode || !root.current?.contains(selection.anchorNode)) return closeMenu();
		const node = selection.anchorNode;
		if (node.nodeType !== Node.TEXT_NODE || node.parentElement?.closest("pre, code, a, li, [contenteditable=false]")) return closeMenu();
		const before = node.textContent?.slice(0, selection.anchorOffset) ?? "";
		const match = (wiki ? /\/([\p{L}\p{N}]{0,32})$/u : /\/([^\s/]{0,32})$/).exec(before);
		if (!match) return closeMenu();
		const range = selection.getRangeAt(0).cloneRange();
		range.setStart(node, selection.anchorOffset - match[1].length - 1);
		// Check the entire logical block, not only this text node: bold/link
		// spans split a paragraph into several nodes but do not start a new one.
		const block = node.parentElement?.closest("p, h1, h2, h3, h4, h5, h6, li, td, th, div");
		if (!block || !root.current.contains(block)) return closeMenu();
		const prefix = document.createRange();
		prefix.selectNodeContents(block);
		prefix.setEnd(range.startContainer, range.startOffset);
		const preceding = prefix.cloneContents();
		if ((wiki ? !!preceding.textContent && !/\s$/.test(preceding.textContent) : !!preceding.textContent) || preceding.querySelector("br, img, input, hr, video, audio")) return closeMenu();
		slashRange.current = range;
		const rect = range.getBoundingClientRect();
		setMenu({ query: match[1], x: Math.max(8, Math.min(rect.left, window.innerWidth - (wiki ? 308 : 328))), y: rect.bottom + 6 });
		setActive(0);
	};
	useEffect(() => {
		if (!menu) return;
		const close = (event: Event) => { if (!(event.target instanceof Element && event.target.closest(".fp-slash-menu"))) closeMenu(); };
		window.addEventListener("scroll", close, true); window.addEventListener("resize", close);
		return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
	}, [!!menu]);
	useLayoutEffect(() => {
		if (!menu || !popup.current || !slashRange.current) return;
		const rect = slashRange.current.getBoundingClientRect(), height = popup.current.offsetHeight;
		popup.current.style.top = `${Math.max(8, rect.bottom + 6 + height <= window.innerHeight - 8 ? rect.bottom + 6 : rect.top - height - 6)}px`;
	}, [menu]);
	useLayoutEffect(() => {
		const option = document.getElementById(`fp-slash-option-${active}`);
		const popup = wiki ? option?.parentElement : option?.closest<HTMLElement>(".fp-slash-menu");
		if (option && popup) {
			if (option.offsetTop < popup.scrollTop) popup.scrollTop = option.offsetTop;
			else if (option.offsetTop + option.offsetHeight > popup.scrollTop + popup.clientHeight) popup.scrollTop = option.offsetTop + option.offsetHeight - popup.clientHeight;
		}
	}, [active, menu?.query]);
	const insert = (index: number) => {
		const range = slashRange.current;
		const item = matches[index];
		if (readOnly || !item || !range || !root.current?.contains(range.startContainer)) return closeMenu();
		const blockParent = range.startContainer.parentElement?.closest("p, h1, h2, h3, h4, h5, h6, td, th")?.parentElement;
		root.current.focus();
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		// Deleting the slash text can leave an empty block whose caret rect is all zeros.
		const popupAnchor = range.getBoundingClientRect();
		closeMenu();
		document.execCommand("delete");
		if (wiki) { prepareInsert(); insertToolbar(item.alias, undefined, undefined, popupAnchor); return; }
		if (item.action === "image") { imageRange.current = selection?.getRangeAt(0).cloneRange() ?? null; imageInput.current?.click(); update(); return; }
		if (item.action === "wikiLink") { linkRange.current = selection?.getRangeAt(0).cloneRange() ?? null; setLinkInput("[["); update(); return; }
		if (wiki && item.alias === "bg") command("insertHTML", `<table><thead><tr>${[1, 2, 3].map(n => `<th ${n === 1 ? "data-slash-insert" : ""}>${t("richColumn")} ${n}</th>`).join("")}</tr></thead><tbody>${[1, 2].map(() => "<tr><td>…</td><td>…</td><td>…</td></tr>").join("")}</tbody></table><p><br></p>`);
		else command(item.action, "argument" in item ? item.argument : undefined);
		// Chromium can leave an empty formatted heading's caret in the preceding block.
		const target = root.current.querySelector("[data-slash-insert]") ?? (item.action === "formatBlock" ? blockParent?.querySelector(item.argument) : null);
		if (target) {
			target.removeAttribute("data-slash-insert");
			const caret = document.createRange();
			caret.selectNodeContents(target);
			caret.collapse(true);
			selection?.removeAllRanges();
			selection?.addRange(caret);
			update();
		}
	};
	const toggleHighlight = (color: typeof TEXT_HIGHLIGHT_COLORS[number]) => {
		const range = highlightSelection();
		if (!range || !root.current) return;
		const walker = document.createTreeWalker(root.current, NodeFilter.SHOW_TEXT);
		const colors: string[] = [];
		let node: Node | null;
		while ((node = walker.nextNode())) {
			if (!node.textContent || !range.intersectsNode(node)) continue;
			if (range.endContainer === node && range.endOffset === 0 || range.startContainer === node && range.startOffset === node.textContent.length) continue;
			let element = node.parentElement, background = "";
			while (element && element !== root.current) {
				if (element.style.backgroundColor && element.style.backgroundColor !== "transparent") { background = element.style.backgroundColor; break; }
				element = element.parentElement;
			}
			colors.push(background);
		}
		command("hiliteColor", colors.length && colors.every(value => value === color.rgb || value === color.hex) ? "transparent" : color.hex);
	};
	const insertLink = (address: string, internal = false) => {
		const range = linkRange.current;
		if (readOnly || !range || !root.current?.contains(range.startContainer)) return;
		if (!internal && !/^(https?:\/\/|mailto:|#|\.?\.?\/)/i.test(address)) { setImageError(t("wikiInvalidLink")); return; }
		const a = document.createElement("a"); a.setAttribute("href", internal ? `#wiki=${encodeURIComponent(address)}` : address);
		a.textContent = range.toString() && range.toString() !== "[[" ? range.toString() : address;
		root.current.focus(); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
		command("insertHTML", a.outerHTML); setLinkInput(null);
	};
	const markdownShortcut = () => {
		if (!wiki || readOnly) return false;
		const selection = window.getSelection(), node = selection?.anchorNode;
		if (!selection?.isCollapsed || !node || !root.current?.contains(node) || node.parentElement?.closest("pre, code, a, [contenteditable=false]")) return false;
		const block = node.parentElement?.closest("p, div");
		if (!block || block === root.current) return false;
		const range = selection.getRangeAt(0).cloneRange(); range.setStart(block, 0);
		const text = range.toString(), heading = /^(#{1,6})$/.exec(text);
		const item = allItems.find(item => item.alias === ({ "-": "lb", "*": "lb", "1.": "bh", "[]": "rw", "[ ]": "rw", ">": "yy", "```": "dmk", "---": "fgx", ":::": "glk" } as Record<string, string>)[text]);
		if (!heading && !item) return false;
		selection.removeAllRanges(); selection.addRange(range); document.execCommand("delete");
		if (heading) {
			const parent = block.parentElement, tag = `h${heading[1].length}`;
			command("formatBlock", tag);
			const headingNode = parent?.querySelector(tag);
			if (headingNode && !headingNode.textContent) { range.selectNodeContents(headingNode); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
		}
		else if (item) command(item.action, "argument" in item ? item.argument : undefined);
		const target = root.current.querySelector("[data-slash-insert]");
		if (target) { target.removeAttribute("data-slash-insert"); range.selectNodeContents(target); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
		closeMenu(); update(); return true;
	};
	const formatTools = [
		{ label: t("richUndo"), icon: <FiRotateCcw />, action: "undo" },
		{ label: t("richRedo"), icon: <FiRotateCw />, action: "redo" },
		{ label: t("richParagraph"), icon: <FiType />, action: "formatBlock", argument: "p", separator: true },
		{ label: `${t("richHeading")} 1`, icon: <span>H₁</span>, action: "formatBlock", argument: "h1" },
		{ label: `${t("richHeading")} 2`, icon: <span>H₂</span>, action: "formatBlock", argument: "h2" },
		{ label: t("richBold"), icon: <FiBold />, action: "bold", separator: true },
		{ label: t("richItalic"), icon: <FiItalic />, action: "italic" },
		{ label: t("richList"), icon: <FiList />, action: "insertUnorderedList", separator: true },
		{ label: t("richOrderedList"), icon: <span>1.</span>, action: "insertOrderedList" },
	];
	return <div className="fp-rich-editor" onScrollCapture={(event) => { if (!(event.target as HTMLElement).closest(".fp-slash-menu")) { if (menu) inspectSlash(); } }}>
		{wiki?.toolbarHost && createPortal(<WikiToolbar readOnly={readOnly} focused={!!wiki.focused} onWidth={wiki.onWidth ?? (() => {})} items={items.map(item => ({ id: item.alias, label: itemLabel(item), hint: hints[item.alias] ?? "", help: t(help[item.alias]), icon: icons[item.label] }))} popup={insertPopup} onPrepare={prepareInsert} onSelect={id => insertToolbar(id)} onPopup={setInsertPopup} />, wiki.toolbarHost)}
		{diagrams.map(({ host, code }, index) => createPortal(<MermaidDiagram code={code} />, host, String(index)))}
		{insertPopup && !readOnly && <WikiInsertPopover popup={insertPopup} onClose={() => { setInsertPopup(null); restoreInsert(); }}>
			{insertPopup.kind === "table" ? <TableSizePicker onInsert={(columns, rows) => insertToolbar("bg", { columns, rows })} /> : <CodeLanguagePicker onInsert={language => insertToolbar("dmk", undefined, language)} />}
		</WikiInsertPopover>}
		{!wiki && <div className="fp-rich-toolbar" role="toolbar" aria-label={t("richFormatToolbar")}>
			{formatTools.map((tool) => <Fragment key={tool.label}>
				{tool.separator && <span className="fp-rich-toolbar-separator" aria-hidden="true" />}
				<button type="button" title={tool.label} aria-label={tool.label} disabled={readOnly}
					onMouseDown={(event) => event.preventDefault()} onClick={() => command(tool.action, tool.argument)}>{tool.icon}</button>
			</Fragment>)}
			<span className="fp-rich-toolbar-separator" aria-hidden="true" />
			<span className="fp-highlight-label">{t("richTextHighlight")}</span>
			{TEXT_HIGHLIGHT_COLORS.map(color => <button key={color.name} type="button" className={`fp-highlight-swatch fp-highlight-${color.name}`}
				title={t(`richHighlight_${color.name}`)} aria-label={t(`richHighlight_${color.name}`)} disabled={readOnly || !canHighlight}
				onMouseDown={event => event.preventDefault()} onClick={() => { if (highlightSelection()) command("hiliteColor", color.hex); }}><span /></button>)}
			<button type="button" title={t("richHighlightClear")} aria-label={t("richHighlightClear")} disabled={readOnly || !canHighlight}
				onMouseDown={event => event.preventDefault()} onClick={() => { if (highlightSelection()) command("hiliteColor", "transparent"); }}><FiMinus /></button>
		</div>}
		{tableCell?.isConnected && !readOnly && <div className="fp-table-tools" role="toolbar" aria-label={t("richTableTools")}>
			<button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => editTable("row")}>{t("richAddRow")}</button>
			<button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => editTable("column")}>{t("richAddColumn")}</button>
			<button type="button" disabled={(tableCell.parentElement as HTMLTableRowElement).rowIndex === 0 || tableCell.closest("table")!.rows.length <= 2}
				onMouseDown={(event) => event.preventDefault()} onClick={() => editTable("removeRow")}>{t("richRemoveRow")}</button>
			<button type="button" disabled={(tableCell.parentElement as HTMLTableRowElement).cells.length <= 1}
				onMouseDown={(event) => event.preventDefault()} onClick={() => editTable("removeColumn")}>{t("richRemoveColumn")}</button>
		</div>}
		{uploading && <div className="fp-notice" role="status">{t("richImageUploading")}</div>}
		{imageError && <div className="fp-notice" role="alert">{imageError}</div>}
		{wiki && floating && linkInput === null && createPortal(<div ref={floatingToolbar} className="wiki-format-popover" role="toolbar" aria-label={t("richFormatToolbar")} style={{ left: floating.x, top: floating.y }} onMouseDown={e => e.preventDefault()}>
			{[{ label: t("richBold"), action: "bold", icon: <FiBold /> }, { label: t("richItalic"), action: "italic", icon: <FiItalic /> }, { label: `${t("richHeading")} 2`, action: "formatBlock", argument: "h2", icon: <FiType /> }, { label: `${t("richHeading")} 3`, action: "formatBlock", argument: "h3", icon: <FiType /> }].map(tool => <button key={tool.label} aria-label={tool.label} title={tool.label} disabled={readOnly} onClick={() => command(tool.action, tool.argument)}>{tool.icon}</button>)}
			<button aria-label={t("wikiAddLink")} title={t("wikiAddLink")} disabled={readOnly} onClick={() => { linkRange.current = highlightSelection()?.cloneRange() ?? null; setLinkInput(""); }}><FiLink /></button><i />
			{TEXT_HIGHLIGHT_COLORS.slice(0, 2).map(color => <button className={`fp-highlight-swatch fp-highlight-${color.name}`} key={color.name} aria-label={t(`richHighlight_${color.name}`)} title={t(`richHighlight_${color.name}`)} disabled={readOnly} onClick={() => toggleHighlight(color)}><span /></button>)}<i />
			<button className="wiki-ask-selection" onClick={() => { wiki.ask(window.getSelection()?.toString() ?? ""); setFloating(null); }}>{t("wikiAskPi")}</button>
		</div>, document.body)}
		<input ref={imageInput} type="file" accept="image/*" hidden onChange={event => { const image = event.target.files?.[0], range = imageRange.current; if (image && range && root.current?.contains(range.startContainer)) { root.current.focus(); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); void pasteImage(image); } event.target.value = ""; }} />
		{linkInput !== null && <WikiReadingDialog title={t("wikiAddLink")} onClose={() => setLinkInput(null)}><form className="wiki-link-form" onSubmit={event => { event.preventDefault(); insertLink(linkInput); }}><input aria-label={t("wikiLinkAddress")} placeholder={t("wikiLinkAddress")} value={linkInput} onChange={e => setLinkInput(e.target.value)} /><button type="submit" disabled={!linkInput.trim() || linkInput.startsWith("[[")}>{t("wikiInsertLinkAction")}</button></form>{linkInput.startsWith("[[") && <div className="wiki-link-results">{wiki?.paths.filter(path => /\.(md|markdown|mdown)$/i.test(path) && path.toLowerCase().includes(linkInput.slice(2).toLowerCase())).slice(0, 30).map(path => <button key={path} onClick={() => insertLink(path, true)}>{path}</button>)}</div>}</WikiReadingDialog>}
		{menu && !readOnly && createPortal(<div ref={popup} className={`fp-slash-menu ${wiki ? "wiki-slash-menu" : ""}`} style={{ left: menu.x, top: menu.y }}>
			<div className="fp-slash-options" role="listbox" aria-label={t("richInsertMenu")}>
			{matches.length ? matches.map((item, index) => <Fragment key={item.alias}>
				{!wiki && (index === 0 || isBlock(item) !== isBlock(matches[index - 1])) && <div className="fp-slash-group" role="presentation">{t(isBlock(item) ? "richBlocksGroup" : "richTextGroup")}</div>}
				<button type="button" role="option" aria-label={itemLabel(item)} aria-selected={index === active} id={`fp-slash-option-${index}`} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => insert(index)}>
					<span className="fp-slash-icon" aria-hidden="true">{icons[item.label]}</span><span className="fp-slash-label">{itemLabel(item)}{wiki && <small>{t(help[item.alias])}</small>}</span><kbd aria-hidden="true">{wiki ? hints[item.alias] : `/${item.alias}`}</kbd>
				</button></Fragment>) : <span className="wiki-slash-empty">{t(wiki ? "wikiNoInsertResults" : "richNoElements")}</span>}
			</div>{wiki && <footer>{t("wikiInsertKeys")}</footer>}
		</div>, document.body)}
		<div className="fp-markdown msg-text">
			<div className="fp-markdown-zoom">
				<div ref={root} className="md fp-rich-document" role="textbox" aria-label={t("richEditMarkdown")} aria-multiline="true"
					contentEditable={!readOnly} suppressContentEditableWarning spellCheck={false}
					aria-expanded={!!menu} aria-autocomplete="list" aria-activedescendant={menu && matches.length ? `fp-slash-option-${active}` : undefined}
					onBlur={closeMenu}
					onCompositionStart={closeMenu}
					onCompositionEnd={() => { const code = selectedCode(); if (code) paintCode(code); update(); inspectSlash(); }}
					onKeyUp={() => setTableCell(selectedCell())}
					onKeyDown={(event) => {
						if (event.key === " " && !event.nativeEvent.isComposing && markdownShortcut()) { event.preventDefault(); return; }
						if (event.key === "Enter" && !readOnly && !event.nativeEvent.isComposing) {
							const code = selectedCode();
							if (code) { event.preventDefault(); command("insertLineBreak"); return; }
						}
						if (event.key === "Tab" && !readOnly && !event.nativeEvent.isComposing) {
							const cell = selectedCell();
							if (cell) {
								const cells = Array.from(cell.closest("table")!.querySelectorAll<HTMLTableCellElement>("th, td"));
								const index = cells.indexOf(cell);
								if (!event.shiftKey || index > 0) {
									event.preventDefault();
									if (!event.shiftKey && index === cells.length - 1) editTable("row", cell);
									else focusCell(cells[index + (event.shiftKey ? -1 : 1)]);
									return;
								}
							}
						}
						if (!menu || event.nativeEvent.isComposing) return;
						if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); }
						else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							setActive((index) => matches.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length : 0);
						} else if (event.key === "Enter" && matches.length) { event.preventDefault(); insert(active); }
						else if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") closeMenu();
					}}
					onInput={(event) => {
						if (event.target instanceof HTMLSelectElement && event.target.hasAttribute("data-code-language")) {
							changeLanguage(event.target);
							return;
						}
						const input = event.target as HTMLInputElement;
						if (input.type === "checkbox") input.toggleAttribute("checked", input.checked);
						update();
						if (!(event.nativeEvent as InputEvent).isComposing) {
							inspectSlash();
							const selection = window.getSelection(), node = selection?.anchorNode;
							if (wiki && selection?.isCollapsed && node?.nodeType === Node.TEXT_NODE && !node.parentElement?.closest("pre, code, a") && node.textContent?.slice(0, selection.anchorOffset).endsWith("[[")) {
								const range = selection.getRangeAt(0).cloneRange(); range.setStart(node, selection.anchorOffset - 2); linkRange.current = range; setLinkInput("[[");
							}
						}
					}}
					onClick={(event) => { setTableCell(selectedCell()); closeMenu(); const link = (event.target as HTMLElement).closest("a"); if (link) { event.preventDefault(); const href = link.getAttribute("href"); if (wiki && href) { if (/^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener,noreferrer"); else wiki.followLink(href); } } }}
					onChange={(event) => {
						const input = event.target as HTMLInputElement;
						if (input.type === "checkbox") { input.toggleAttribute("checked", input.checked); update(); }
					}}
					onPaste={(event) => {
						event.preventDefault();
						const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"));
						if (image) { void pasteImage(image); return; }
						if (!readOnly) command("insertText", event.clipboardData.getData("text/plain"));
					}}
					onDrop={(event) => { event.preventDefault(); event.stopPropagation(); }}
				/>
			</div>
		</div>
	</div>;
});
