import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { FiArrowUp, FiBookOpen, FiChevronDown, FiChevronRight, FiCode, FiFile, FiMenu, FiRefreshCw, FiSearch, FiX, FiClock, FiCornerUpLeft, FiCornerUpRight, FiLink, FiSquare } from "react-icons/fi";
import { useI18n, useT } from "../i18n";
import type { WikiState, WikiDirectory, WikiDocument, WikiRevision, WikiChange, WikiSearchResult, UiMessage, ClientMessage } from "../types";
import { wikiRequest, wikiMedia } from "../wiki-api";
import { wikiMetadata, renderWikiLinks, resolveWikiLink, wikiPrompt } from "../wiki-document";
import { remarkPlugins, rehypePlugins, Markdown, PreWithCopy } from "./Markdown";
import { CodeFileEditor } from "./CodeFileEditor";
import { desktopAPI } from "../desktop";
import { getClientId } from "../use-chat";
import { randomUuid } from "../uuid";

type Guard = (next: () => void) => void;
const EMPTY: WikiState = { entries: [], tags: [], revisions: [], running: false, limited: false };
export function WikiWorkbench({ cwd, conversationId, messages, streaming, active, ready, send, guard }: {
	cwd: string; conversationId: string; messages: UiMessage[]; streaming: boolean; active: boolean; ready: boolean;
	send: (message: ClientMessage) => boolean; guard: MutableRefObject<Guard | null>;
}) {
	const t = useT(), { locale } = useI18n();
	const [state, setState] = useState<WikiState>(EMPTY);
	const [directories, setDirectories] = useState<Record<string, WikiDirectory>>({});
	const [fullChanges, setFullChanges] = useState<Record<string, WikiChange>>({});
	const [path, setPath] = useState(() => localStorage.getItem(`pi-wiki-file:${cwd}`) ?? "");
	const [doc, setDoc] = useState<WikiDocument | null>(null), [draft, setDraft] = useState("");
	const [source, setSource] = useState(false), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
	const [error, setError] = useState(""), [nav, setNav] = useState<(() => void) | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [tag, setTag] = useState(""), [sidebar, setSidebar] = useState(false);
	const [drawer, setDrawer] = useState<"recent" | string | null>(null);
	const [search, setSearch] = useState(false), [query, setQuery] = useState(""), [results, setResults] = useState<WikiSearchResult[]>([]);
	const [searching, setSearching] = useState(false), [searchLimited, setSearchLimited] = useState(false), [cursor, setCursor] = useState(0);
	const [mentionCursor, setMentionCursor] = useState(0);
	const [input, setInput] = useState(""), [refs, setRefs] = useState<string[]>([]), [selection, setSelection] = useState("");
	const [selectionMenu, setSelectionMenu] = useState<{ text: string; x: number; y: number } | null>(null);
	const [whole, setWhole] = useState(false), [allowCode, setAllowCode] = useState(false), [sending, setSending] = useState(false);
	const [previewPrompt, setPreviewPrompt] = useState(false), [answerOpen, setAnswerOpen] = useState(true);
	const [viewed, setViewed] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem(`pi-wiki-viewed:${cwd}`) ?? "{}"); } catch { return {}; } });
	const [now, setNow] = useState(Date.now()), [host, setHost] = useState<HTMLElement | null>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null), article = useRef<HTMLElement>(null);
	const alive = useRef(true), docSequence = useRef(0), stateSequence = useRef(0);
	const docRef = useRef(doc), dirty = !!doc?.editable && doc.text !== undefined && draft !== doc.text;
	docRef.current = doc;
	const busy = sending || saving || loading || state.running || streaming || !ready || (!!doc && doc.entry.path !== path);
	const latest = state.revisions.find(r => r.author === "pi");
	const changedPaths = new Set(state.revisions.filter(r => r.author === "pi").flatMap(r => r.changes.filter(c => !c.undone && (viewed[c.path] ?? 0) < r.at).map(c => c.path)));
	const answer = [...messages].reverse().find(m => m.role === "assistant" && m.content.some(c => c.type === "text"));
	const answerText = answer?.content.filter(c => c.type === "text").map(c => c.type === "text" ? c.text : "").join("\n") ?? "";
	const entries = useMemo(() => {
		const merged = new Map(state.entries.map(e => [e.path, e]));
		for (const directory of Object.values(directories)) {
			const unindexed = !state.entries.length || state.limited || state.entries.some(e => e.symlink && directory.path.startsWith(e.path));
			for (const entry of directory.entries) if (!merged.has(entry.path) && unindexed) merged.set(entry.path, entry);
		}
		// Sort by path segments with folders before files at each level.
		return [...merged.values()].sort((a, b) => {
			const aa = a.path.split("/"), bb = b.path.split("/");
			for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
				if (aa[i] === bb[i]) continue;
				const ad = i < aa.length - 1 || a.kind === "directory", bd = i < bb.length - 1 || b.kind === "directory";
				return Number(bd) - Number(ad) || aa[i].localeCompare(bb[i]);
			}
			return aa.length - bb.length;
		});
	}, [state.entries, state.limited, directories]);
	const paths = useMemo(() => entries.filter(e => e.kind !== "directory").map(e => e.path), [entries]);
	const visibleEntries = useMemo(() => entries.filter(e => tag ? e.kind !== "directory" && e.tags.includes(tag) : e.path.split("/").slice(0, -1).every((_, i, parts) => expanded.has(parts.slice(0, i + 1).join("/")))), [entries, expanded, tag]);
	const [treeScroll, setTreeScroll] = useState(0);
	const rowStart = Math.max(0, Math.floor(treeScroll / 30) - 10), rowEnd = rowStart + 70;
	const mention = /(?:^|\s)([@#])([^\s]*)$/.exec(input);
	const suggestions = mention ? (mention[1] === "@" ? paths : state.tags.map(v => v.name)).filter(v => v.toLocaleLowerCase().includes(mention[2].toLocaleLowerCase())).slice(0, 8) : [];
	const chooseMention = (value: string) => {
		if (!mention) return;
		if (mention[1] === "@") setRefs(r => [...new Set([...r, value])]); else setTag(value);
		setInput(input.slice(0, mention.index).trimEnd() + " "); setMentionCursor(0); inputRef.current?.focus();
	};
	const promptText = wikiPrompt(input, path, selection, refs, tag, entries, whole, allowCode, { scope: t("wikiScope"), selection: t("wikiSelected"), documentsOnly: t("wikiDocumentsOnlyPrompt"), skip: t("wikiSkipPrompt") });

	useEffect(() => { alive.current = true; return () => { alive.current = false; docSequence.current++; stateSequence.current++; }; }, []);
	useEffect(() => { setHost(document.getElementById("wiki-toolbar-slot")); }, [active]);
	const loadDirectory = useCallback(async (target: string, offset = 0) => {
		try {
			const result = await wikiRequest<WikiDirectory>(cwd, "directory", { path: target, offset });
			if (alive.current) setDirectories(prev => ({ ...prev, [target]: { ...result, entries: offset ? [...(prev[target]?.entries ?? []), ...result.entries] : result.entries } }));
		} catch (e) { if (alive.current) setError((e as Error).message); }
	}, [cwd]);
	useEffect(() => { if (active && ready) void loadDirectory(""); }, [active, ready, loadDirectory]);
	const refresh = useCallback(async (fresh = false) => {
		const seq = ++stateSequence.current;
		try { const result = await wikiRequest<WikiState>(cwd, fresh ? "refresh" : "state"); if (alive.current && seq === stateSequence.current) setState(result); }
		catch (e) { if (alive.current && seq === stateSequence.current) setError((e as Error).message); }
	}, [cwd]);
	useEffect(() => { if (!active || !ready) return; void refresh(true); const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 4000); return () => clearInterval(timer); }, [active, ready, refresh]);
	useEffect(() => { if (!path) return; setExpanded(prev => { const next = new Set(prev), parts = path.split("/"); for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/")); return next; }); }, [path]);
	useEffect(() => { if (path || !state.entries.length) return; const initial = state.entries.find(e => /^(readme|index)\.md$/i.test(e.path)) ?? state.entries.find(e => e.kind === "document"); if (initial) setPath(initial.path); }, [state.entries, path]);
	const load = useCallback(async (target: string, markViewed = false) => {
		const seq = ++docSequence.current;
		setLoading(true); setError("");
		try {
			const result = await wikiRequest<WikiDocument>(cwd, "document", { path: target });
			if (!alive.current || seq !== docSequence.current) return;
			setDoc(result); setDraft(result.text ?? ""); setSelection(""); setSelectionMenu(null);
			localStorage.setItem(`pi-wiki-file:${cwd}`, target);
			if (markViewed) setViewed(v => { const next = { ...v, [target]: Date.now() }; localStorage.setItem(`pi-wiki-viewed:${cwd}`, JSON.stringify(next)); return next; });
		} catch (e) { if (alive.current && seq === docSequence.current) { setDoc(null); setError((e as Error).message); } }
		finally { if (alive.current && seq === docSequence.current) setLoading(false); }
	}, [cwd]);
	useEffect(() => { if (path && active && ready && docRef.current?.entry.path !== path) void load(path, true); }, [path, active, ready, load]);
	useEffect(() => {
		if (!doc || dirty || saving || loading || !active) return;
		const entry = state.entries.find(e => e.path === path);
		if (entry && entry.modified !== doc.entry.modified) void load(path);
	}, [state.entries, doc, dirty, saving, loading, active, path, load]);
	const navigate = useCallback<Guard>((next) => { if (dirty || saving) setNav(() => next); else next(); }, [dirty, saving]);
	useEffect(() => { guard.current = dirty || saving ? navigate : null; return () => { guard.current = null; }; }, [guard, navigate, dirty, saving]);
	useEffect(() => { const leave = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave); }, [dirty]);
	const open = (target: string) => navigate(() => {
		setPath(target); setSource(false); setSearch(false); setSidebar(false); setSelectionMenu(null);
		setExpanded(prev => { const next = new Set(prev), parts = target.split("/"); for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/")); return next; });
		if (target === path) void load(target, true);
	});
	const save = async (): Promise<boolean> => {
		if (!doc || doc.entry.path !== path) return false;
		if (!dirty) return true;
		setSaving(true); setError("");
		try { const result = await wikiRequest<WikiDocument>(cwd, "write", { path, text: draft, version: doc.version }); if (alive.current) { setDoc(result); setDraft(result.text ?? ""); void refresh(true); } return true; }
		catch (e) { if (alive.current) setError((e as Error).message); return false; }
		finally { if (alive.current) setSaving(false); }
	};
	useEffect(() => {
		if (!active) return;
		const key = (e: KeyboardEvent) => {
			if (e.key === "Tab" && (search || nav)) {
				const dialog = [...document.querySelectorAll<HTMLElement>(".wiki-modal-backdrop [role=dialog]")].at(-1);
				const items = [...(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled), input, textarea, select, [tabindex='0']") ?? [])];
				if (items.length && e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)?.focus(); }
				else if (items.length && !e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus(); }
			}
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearch(s => !s); }
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!busy) void save(); }
			if (e.key === "Escape") { setNav(null); setSearch(false); setSelectionMenu(null); setDrawer(null); setSidebar(false); }
		};
		window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
	});
	useEffect(() => {
		if (!search || !query.trim()) { setResults([]); setSearching(false); return; }
		const controller = new AbortController(); setSearching(true); setResults([]); setSearchLimited(false); setCursor(0);
		const timer = setTimeout(() => {
			void wikiRequest<{ results: WikiSearchResult[]; limited: boolean }>(cwd, "search", { query }, controller.signal).then(result => { if (!controller.signal.aborted) { setResults(result.results.sort((a, b) => ["document", "code", "pdf", "image", "other"].indexOf(a.kind) - ["document", "code", "pdf", "image", "other"].indexOf(b.kind))); setSearchLimited(result.limited); } }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setSearching(false); });
		}, 250);
		return () => { clearTimeout(timer); controller.abort(); };
	}, [cwd, query, search]);
	useEffect(() => { if (search) document.querySelector(".wiki-search-results button.selected")?.scrollIntoView({ block: "nearest" }); }, [search, cursor]);
	const restore = async (revision: WikiRevision, undo: boolean, file?: string) => {
		if (dirty) { setError(t("wikiSaveFirst")); return; }
		setSaving(true); setError("");
		try { const result = await wikiRequest<WikiState>(cwd, "restore", { id: revision.id, undo, path: file }); if (alive.current) { setState(result); if (path) await load(path); } }
		catch (e) { if (alive.current) setError((e as Error).message); }
		finally { if (alive.current) setSaving(false); }
	};
	const submit = async () => {
		if (!input.trim() || busy || (!path && !whole && !refs.length && !tag)) return;
		if (dirty && !(await save())) return;
		setSending(true); setError("");
		try {
			await wikiRequest(cwd, "prompt", { text: promptText, requestId: randomUuid(), conversationId });
			if (alive.current) { setInput(""); setSelection(""); setRefs([]); setPreviewPrompt(false); setAnswerOpen(true); await refresh(); }
		} catch (e) { if (alive.current) setError((e as Error).message); }
		finally { if (alive.current) setSending(false); }
	};
	const attachResult = (result: WikiSearchResult) => { setRefs(r => [...new Set([...r, result.path])]); setSearch(false); inputRef.current?.focus(); };
	const selectText = () => {
		const selected = window.getSelection();
		if (!selected || selected.isCollapsed || !article.current?.contains(selected.anchorNode) || !article.current?.contains(selected.focusNode)) { setSelectionMenu(null); return; }
		const text = selected.toString().trim().slice(0, 12000), rect = selected.getRangeAt(0).getBoundingClientRect();
		if (text) setSelectionMenu({ text, x: Math.max(8, Math.min(rect.left, window.innerWidth - 300)), y: Math.min(rect.bottom + 8, window.innerHeight - 50) });
	};
	const selectionAction = (action: "ask" | "rewrite" | "explain" | "link") => {
		if (!selectionMenu) return;
		setSelection(selectionMenu.text); setSelectionMenu(null);
		if (action !== "ask") setInput(t(action === "rewrite" ? "wikiRewritePrompt" : action === "explain" ? "wikiExplainPrompt" : "wikiLinkPrompt"));
		inputRef.current?.focus();
	};
	const followLink = (href: string) => {
		let reference = href;
		try { if (href.startsWith("#wiki=")) reference = decodeURIComponent(href.slice(6)); } catch { return; }
		const target = resolveWikiLink(path, reference, paths);
		if (target) open(target); else setError(t("wikiMissingLink", { path: reference }));
	};
	const metadata = wikiMetadata(draft), body = metadata.body.replace(/^#\s+[^\n]+\n?/, "");
	const changed = latest?.changes.find(c => c.path === path && !c.undone && !c.binary);
	const added = changed && latest && now - latest.at < 300000 && (viewed[path] ?? 0) <= latest.at ? new Set((changed.after ?? "").split("\n").filter(line => !(changed.before ?? "").split("\n").includes(line))) : new Set<string>();
	const toolbar = <><div className="wiki-breadcrumb"><span title={cwd}>{cwd.split(/[\\/]/).filter(Boolean).at(-1)}</span>{path.split("/").filter(Boolean).map((p, i) => <span key={i}><i>/</i><b>{p}</b></span>)}</div><div className="wiki-toolbar-actions"><button onClick={() => setDrawer(drawer === "recent" ? null : "recent")} className={drawer === "recent" ? "active" : ""}><FiClock />{t("wikiRecent")}</button><button disabled={!doc?.editable || loading || doc.entry.path !== path} onClick={() => setSource(s => !s)}><FiCode />{t(source ? "wikiPreview" : "wikiSource")}</button>{dirty && <button className="wiki-save" disabled={busy} onClick={() => void save()}>{t("save")}</button>}</div></>;
	return <section className={`wiki-workbench ${drawer ? "with-drawer" : ""}`} aria-label={t("wikiMode")}>
		{active && host && createPortal(toolbar, host)}
		<aside className={`wiki-sidebar ${sidebar ? "open" : ""}`}>
			<button className="wiki-search-trigger" onClick={() => setSearch(true)}><FiSearch /><span>{t("wikiSearchAll")}</span><kbd>⌘K</kbd></button>
			<div className="wiki-tree-label"><span>{tag ? `#${tag}` : t("wikiFiles")}</span>{tag ? <button onClick={() => setTag("")}>{t("wikiClear")}</button> : <button aria-label={t("wikiRefresh")} onClick={() => void refresh(true)}><FiRefreshCw /></button>}</div>
			<div className="wiki-tree" role="tree" aria-label={t("wikiFiles")} onScroll={e => setTreeScroll(e.currentTarget.scrollTop)}>
				<div style={{ height: rowStart * 30 }} />
				{visibleEntries.slice(rowStart, rowEnd).map(entry => <button key={entry.path} role="treeitem" aria-selected={entry.path === path} aria-expanded={entry.kind === "directory" ? expanded.has(entry.path) : undefined} className={`wiki-tree-row ${entry.path === path ? "selected" : ""}`} style={{ paddingLeft: 12 + (tag ? 0 : entry.path.split("/").length - 1) * 16 }} title={entry.path} onClick={() => entry.kind === "directory" ? setExpanded(prev => { const next = new Set(prev); if (next.has(entry.path)) next.delete(entry.path); else { next.add(entry.path); void loadDirectory(entry.path); } return next; }) : open(entry.path)}>
					{entry.kind === "directory" ? expanded.has(entry.path) ? <FiChevronDown /> : <FiChevronRight /> : entry.kind === "document" ? <FiFile /> : entry.kind === "code" ? <FiCode /> : <FiFile />}<span>{entry.name}</span>{changedPaths.has(entry.path) && <i className="wiki-unread" aria-label={t("wikiUnread")} />}
				</button>)}<div style={{ height: Math.max(0, visibleEntries.length - rowEnd) * 30 }} />
				{Object.values(directories).filter(d => d.nextOffset !== undefined && (state.limited || entries.some(e => e.symlink && d.path.startsWith(e.path))) && (!d.path || expanded.has(d.path))).map(d => <button className="wiki-load-more" key={d.path} onClick={() => void loadDirectory(d.path, d.nextOffset)}>{t("wikiLoadMore")} · {d.path || "/"}</button>)}
				{!visibleEntries.length && <p className="wiki-muted">{t("wikiNoFiles")}</p>}
			</div>
			<div className="wiki-tags"><span>{t("wikiTags")}</span><div>{state.tags.map(item => <button key={item.name} className={tag === item.name ? "active" : ""} onClick={() => { setTag(tag === item.name ? "" : item.name); setTreeScroll(0); }}>#{item.name} <small>{item.count}</small></button>)}{!state.tags.length && <small>{t("wikiNoTags")}</small>}</div></div>
		</aside>
		{sidebar && <button className="wiki-sidebar-scrim" aria-label={t("close")} onClick={() => setSidebar(false)} />}
		<div className="wiki-main">
			<div className="wiki-mobile-tools"><button aria-label={t("wikiFiles")} onClick={() => setSidebar(s => !s)}><FiMenu /></button><span>{doc?.entry.name || t("wikiMode")}</span><button aria-label={t("wikiSearchAll")} onClick={() => setSearch(true)}><FiSearch /></button></div>
			{error && <div className="wiki-error" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label={t("close")}><FiX /></button>{doc && <button onClick={() => navigate(() => void load(path))}>{t("wikiReload")}</button>}</div>}
			{state.limited && <div className="wiki-limit">{t("wikiLimits")}</div>}
			<div className="wiki-scroll" onScroll={() => setSelectionMenu(null)}>
				{loading ? <div className="wiki-empty">{t("loading")}</div> : doc ? <article className={`wiki-document ${source || doc.entry.kind === "code" ? "is-source" : ""}`} ref={article} onMouseUp={selectText} onKeyUp={selectText}>
					<header className="wiki-document-heading"><h1>{metadata.title || doc.entry.name.replace(/\.(md|txt)$/i, "")}</h1><div className="wiki-document-meta">{doc.entry.tags.map(value => <button key={value} onClick={() => setTag(value)}>#{value}</button>)}<span>{new Date(doc.entry.modified).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}</span><button onClick={() => article.current?.querySelector(".wiki-backlinks")?.scrollIntoView({ behavior: "smooth" })}>{t("wikiBacklinks")} {doc.backlinks.length}</button>{dirty && <strong>{t("wikiUnsaved")}</strong>}</div></header>
					{doc.text !== undefined ? (source || doc.entry.kind === "code" ? <><div className="wiki-code-hint">{doc.entry.kind === "code" && !source ? t("wikiCodeReadOnly") : t("wikiEditingSource")}</div><CodeFileEditor value={draft} name={path} readOnly={busy || !doc.editable || (!source && doc.entry.kind === "code")} wrap={false} onChange={setDraft} onSelectLines={(start, end) => setSelection(draft.split("\n").slice(start - 1, end).join("\n"))} /></> : <div className="wiki-prose md"><ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={{
						pre: ({ children }) => <PreWithCopy>{children}</PreWithCopy>,
						code: ({ children, className }) => { const value = String(children).trim(), target = !className && !value.includes("\n") ? resolveWikiLink(path, value, paths) : undefined; return <code className={className}>{target ? <a href={`#wiki=${encodeURIComponent(value)}`} onClick={e => { e.preventDefault(); open(target); }}>{children}</a> : children}</code>; },
						a: ({ href, children }) => <a href={href} onClick={e => { if (href && !/^(?:https?:|mailto:)/i.test(href)) { e.preventDefault(); followLink(href); } }} target={href?.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{children}</a>,
						img: ({ src, alt }) => <img alt={alt ?? ""} src={src && !/^(?:https?:|data:)/i.test(src) ? wikiMedia(cwd, resolveWikiLink(path, src, paths) ?? src) : src} />,
						p: ({ children, node }) => { const segment = body.split("\n").slice((node?.position?.start.line ?? 1) - 1, node?.position?.end.line).join("\n"); const isAdded = [...added].some(line => line.trim() && segment.includes(line)); return <p className={isAdded ? "wiki-added" : undefined}>{isAdded && <small>{t("wikiPiAdded")}</small>}{children}</p>; },
					}}>{renderWikiLinks(body)}</ReactMarkdown></div>) : doc.entry.kind === "image" ? <img className="wiki-image" src={wikiMedia(cwd, path)} alt={doc.entry.name} /> : doc.entry.kind === "pdf" ? <iframe className="wiki-pdf" title={doc.entry.name} src={wikiMedia(cwd, path)} /> : <div className="wiki-empty"><FiFile /><p>{doc.entry.name} · {Math.ceil(doc.entry.size / 1024)} KB</p>{desktopAPI?.openWikiFile ? <button onClick={() => void desktopAPI!.openWikiFile!({ clientId: getClientId(), cwd, path }).catch(e => setError(e.message))}>{t("wikiOpenDefault")}</button> : <a href={wikiMedia(cwd, path, true)} download>{t("wikiDownloadOpen")}</a>}</div>}
					<section className="wiki-backlinks"><h2><FiLink />{t("wikiBacklinks")} <span>{doc.backlinks.length}</span></h2>{doc.backlinks.map((link, index) => <button key={`${link.path}:${index}`} onClick={() => open(link.path)}><strong>{link.path}</strong><span>{link.snippet}</span></button>)}{!doc.backlinks.length && <p>{t("wikiNoBacklinks")}</p>}</section>
				</article> : <div className="wiki-empty"><FiBookOpen /><h1>{t("wikiWelcome")}</h1><p>{t("wikiWelcomeHint")}</p><button onClick={() => setSearch(true)}>{t("wikiSearchAll")}</button></div>}
			</div>
			<div className="wiki-composer-area">
				{latest && latest.changes.length > 0 && <div className="wiki-change-toast"><i /><button onClick={() => setDrawer(latest.id)}>{t("wikiChangedFiles", { count: latest.changes.length })}</button><button disabled={busy} onClick={() => void restore(latest, !latest.changes.every(c => c.undone))}>{latest.changes.every(c => c.undone) ? t("wikiRedo") : t("wikiUndo")}</button></div>}
				{answerText && <div className="wiki-answer"><button onClick={() => setAnswerOpen(v => !v)}><span>pi</span>{t(streaming ? "wikiWorking" : "wikiLastAnswer")}<FiChevronDown /></button>{answerOpen && <div><Markdown text={answerText} /></div>}</div>}
				<div className="wiki-composer">
					{(selection || refs.length > 0 || path) && <div className="wiki-context-chips">{path && <span title={path}><FiFile />{path.split("/").at(-1)}</span>}{selection && <button onClick={() => setSelection("")} title={selection}>{t("wikiSelected")} · {selection.slice(0, 42)}<FiX /></button>}{refs.map(ref => <button key={ref} onClick={() => setRefs(r => r.filter(p => p !== ref))}>@{ref}<FiX /></button>)}</div>}
					{suggestions.length > 0 && <div className="wiki-mentions">{suggestions.map(value => <button key={value} className={suggestions[mentionCursor] === value ? "selected" : ""} onClick={() => chooseMention(value)}>{mention![1]}{value}</button>)}</div>}
					<textarea ref={inputRef} aria-label={t("wikiAsk")} placeholder={doc?.entry.kind === "code" ? t("wikiAskCode", { file: doc.entry.name }) : t("wikiAskPlaceholder")} value={input} onChange={e => { setInput(e.target.value); setMentionCursor(0); }} onKeyDown={e => { if (suggestions.length && !e.nativeEvent.isComposing) { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setMentionCursor(i => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length); return; } if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseMention(suggestions[mentionCursor] ?? suggestions[0]); return; } } if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} />
					<div className="wiki-composer-controls"><select aria-label={t("wikiScope")} value={whole ? "workspace" : "document"} onChange={e => setWhole(e.target.value === "workspace")}><option value="document">{tag ? `#${tag}` : refs.length ? t("wikiReferencedScope") : t("wikiCurrentScope")}</option><option value="workspace">{t("wikiWholeScope")}</option></select><label><input type="checkbox" checked={allowCode} onChange={e => setAllowCode(e.target.checked)} />{t("wikiAllowCode")}</label><button onClick={() => setPreviewPrompt(v => !v)}>{t("wikiPromptPreview")}</button>{streaming ? <button className="wiki-send" aria-label={t("wikiStop")} onClick={() => send({ type: "abort" })}><FiSquare /></button> : <button className="wiki-send" aria-label={t("wikiSend")} disabled={busy || !input.trim() || (!path && !whole && !refs.length && !tag)} onClick={() => void submit()}><FiArrowUp /></button>}</div>
					{previewPrompt && <pre className="wiki-prompt-preview">{promptText}</pre>}
				</div>
			</div>
		</div>
		{drawer && <aside className="wiki-changes"><header><div><h2>{t(drawer === "recent" ? "wikiRecent" : "wikiRelatedChanges")}</h2><span>{cwd.split(/[\\/]/).at(-1)}</span></div><button aria-label={t("close")} onClick={() => setDrawer(null)}><FiX /></button></header><div className="wiki-changes-scroll">{state.revisions.filter(r => drawer === "recent" || r.id === drawer).map((revision, index, list) => <div key={revision.id} className="wiki-revision">{(index === 0 || new Date(list[index - 1].at).toDateString() !== new Date(revision.at).toDateString()) && <time>{new Date(revision.at).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US")}</time>}<div className="wiki-revision-title"><span className={`wiki-avatar ${revision.author}`}>{revision.author === "pi" ? "π" : t("wikiMe")}</span><div><strong>{revision.title.split("\n")[0]}</strong><small>{new Date(revision.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {t("wikiFileCount", { count: revision.changes.length })}</small></div></div><div className="wiki-revision-actions"><button disabled={busy || revision.changes.every(c => c.undone)} onClick={() => void restore(revision, true)}><FiCornerUpLeft />{t("wikiUndoAll")}</button><button disabled={busy || revision.changes.every(c => !c.undone)} onClick={() => void restore(revision, false)}><FiCornerUpRight />{t("wikiRedoAll")}</button></div>{revision.changes.map(summary => { const change = { ...summary, ...(fullChanges[`${revision.id}:${summary.path}`] ?? {}), undone: summary.undone }; return <div className={`wiki-file-change ${change.undone ? "undone" : ""}`} key={change.path}><div><button title={change.path} onClick={() => open(change.path)}>{change.path}</button><button disabled={busy} onClick={() => void restore(revision, !change.undone, change.path)}>{t(change.undone ? "wikiRedo" : "wikiUndo")}</button></div><small><em>+{change.additions}</em> <b>−{change.deletions}</b></small><details onToggle={e => { if (e.currentTarget.open && change.truncated) void wikiRequest<WikiChange>(cwd, "change", { id: revision.id, path: change.path }).then(result => { if (alive.current) setFullChanges(previous => ({ ...previous, [`${revision.id}:${change.path}`]: result })); }).catch(e => setError(e.message)); }}><summary>{t("wikiViewDiff")}</summary>{change.binary ? <p>{t("wikiBinaryChange")}</p> : <><pre className="wiki-diff-before">{change.before ?? t("wikiNewFile")}</pre><pre className="wiki-diff-after">{change.after ?? t("wikiDeletedFile")}</pre></>}</details></div>; })}{revision.skipped.length > 0 && <p className="wiki-skipped">{t("wikiUntracked")}: {revision.skipped.join(", ")}</p>}</div>)}{!state.revisions.length && <p className="wiki-muted">{t("wikiNoChanges")}</p>}</div></aside>}
		{selectionMenu && createPortal(<div className="wiki-selection-menu" style={{ left: selectionMenu.x, top: selectionMenu.y }} onMouseDown={e => e.preventDefault()}>{(["ask", "rewrite", "explain", "link"] as const).map(action => <button key={action} onClick={() => selectionAction(action)}>{t(action === "ask" ? "wikiAskPi" : action === "rewrite" ? "wikiRewrite" : action === "explain" ? "wikiExplain" : "wikiAddLink")}</button>)}</div>, document.body)}
		{search && <div className="wiki-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSearch(false); }}><section className="wiki-search-modal" role="dialog" aria-modal="true" aria-label={t("wikiSearchAll")}><div><FiSearch /><input autoFocus aria-label={t("wikiSearchAll")} placeholder={t("wikiSearchHint")} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setCursor(i => Math.max(0, Math.min(results.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))); } if (e.key === "Enter" && results[cursor]) { e.preventDefault(); if (e.metaKey || e.ctrlKey) attachResult(results[cursor]); else open(results[cursor].path); } }} /><button aria-label={t("close")} onClick={() => setSearch(false)}><FiX /></button></div><div className="wiki-search-results">{searching && <p role="status">{t("loading")}</p>}{results.map((result, i) => <div key={`${result.path}:${result.line}:${i}`}>{(i === 0 || results[i - 1].kind !== result.kind) && <h3>{t(result.kind === "document" ? "wikiDocuments" : result.kind === "pdf" ? "wikiPdf" : result.kind === "code" ? "wikiCode" : "wikiFiles")}</h3>}<button className={cursor === i ? "selected" : ""} onMouseEnter={() => setCursor(i)} onClick={e => e.metaKey || e.ctrlKey ? attachResult(result) : open(result.path)}><strong>{result.path}{result.page ? ` · ${t("wikiPage", { page: result.page })}` : ""}</strong><span>{result.snippet}</span></button></div>)}{query && !searching && !results.length && <p>{t("wikiNoResults")}</p>}{searchLimited && <p>{t("wikiSearchLimited")}</p>}</div><footer>{t("wikiSearchKeys")}</footer></section></div>}
		{nav && <div className="wiki-modal-backdrop"><section className="wiki-confirm" role="dialog" aria-modal="true" aria-label={t("wikiUnsaved")}><h2>{t("wikiUnsaved")}</h2><p>{t("wikiUnsavedHint")}</p><div><button disabled={saving} onClick={() => setNav(null)}>{t("cancel")}</button><button disabled={saving} onClick={() => { const next = nav; setDraft(doc?.text ?? ""); setNav(null); next(); }}>{t("wikiDiscard")}</button><button disabled={busy} onClick={() => void (async () => { if (await save()) { const next = nav; setNav(null); next(); } })()}>{t("wikiSaveContinue")}</button></div></section></div>}
	</section>;
}
