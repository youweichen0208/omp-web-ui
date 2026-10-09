import { wikiProperties } from "../wiki-properties";
import ReactMarkdown from "react-markdown";
import { useExtensionEditor } from "../extension-editor";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { FiPlus, FiCalendar, FiArrowUp, FiBookOpen, FiChevronDown, FiChevronRight, FiCode, FiFile, FiMenu, FiRefreshCw, FiSearch, FiX, FiClock, FiCornerUpLeft, FiCornerUpRight, FiLink, FiSquare } from "react-icons/fi";
import { useI18n, useT } from "../i18n";
import type { WikiState, WikiDirectory, WikiDocument, WikiDocumentContent, WikiDocumentReferences, WikiRevision, WikiChange, WikiSearchResult, UiMessage, ClientMessage, UiModelInfo, ToolStatus } from "../types";
import { wikiRequest, wikiMedia } from "../wiki-api";
import { wikiMetadata, resolveWikiLink, wikiPrompt } from "../wiki-document";
import { CreateFileForm } from "./CreateFileForm";
import { WikiChatPanel } from "./WikiChatPanel";
import { wikiSectionIndex, wikiHeadingTexts, wikiHasEmptySections } from "../wiki-chat";
import { RichMarkdownEditor } from "./RichMarkdownEditor";
import { CodeFileEditor } from "./CodeFileEditor";
import { desktopAPI, registerWindowSave } from "../desktop";
import { getClientId } from "../use-chat";
import { WikiIndexIndicator } from "./WikiReading";
import { useWikiAutosave } from "../use-wiki-autosave";
import { randomUuid } from "../uuid";

type Guard = (next: () => void) => void;
const EMPTY: WikiState = { entries: [], tags: [], revisions: [], running: false, limited: false };
export function WikiWorkbench({ cwd, conversationId, messages, streaming, live, model, contextPercent, toolStatuses, active, ready, send, guard, fileRequest, openDocument, thinkingWrap, connected, silenceNotified, sessionError, writingBlocked, onContentRequested, recovery }: {
	recovery?: import("../types").UiRecovery;
	sessionError: string; writingBlocked: boolean; onContentRequested: (token: string) => void;
	cwd: string; conversationId: string; messages: UiMessage[]; streaming: boolean; active: boolean; ready: boolean;
	fileRequest: {path:string;token:string} | null;
	openDocument: (path: string) => Promise<void>; thinkingWrap: boolean; connected: boolean; silenceNotified: boolean;
	live: UiMessage | null; model: UiModelInfo | null; contextPercent: number | null; toolStatuses: Map<string, ToolStatus>;
	send: (message: ClientMessage) => boolean; guard: MutableRefObject<Guard | null>;
}) {
	const t = useT(), { locale } = useI18n();
	const [state, setState] = useState<WikiState>(EMPTY);
	const [directories, setDirectories] = useState<Record<string, WikiDirectory>>({});
	const [fullChanges, setFullChanges] = useState<Record<string, WikiChange>>({});
	const [path, setPath] = useState(() => fileRequest?.path ?? localStorage.getItem(`pi-wiki-file:${cwd}`) ?? "");
	const [referencesReady, setReferencesReady] = useState(false);
	const [backlinkLimit, setBacklinkLimit] = useState(100);
	const [doc, setDoc] = useState<WikiDocument | null>(null), [draft, setDraft] = useState("");
	const [source, setSource] = useState(false), [loading, setLoading] = useState(false), [restoring, setRestoring] = useState(false);
	const [error, setError] = useState(""), [nav, setNav] = useState<(() => void) | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [showHidden, setShowHidden] = useState(() => localStorage.getItem(`pi-wiki-hidden:${cwd}`) === "true");
	const [chatOpen, setChatOpen] = useState(true);
	const [focused, setFocused] = useState(false);
	const [editorToolbarHost, setEditorToolbarHost] = useState<HTMLDivElement | null>(null);
	useEffect(() => setFocused(false), [path]);
	const toggleChat = (open: boolean) => { setChatOpen(open); setScopeOpen(false); if (open) { setDrawer(null); setFocused(false); } };
	const [composerOpen, setComposerOpen] = useState(false), [scopeOpen, setScopeOpen] = useState(false);
	const [statusHost, setStatusHost] = useState<HTMLElement | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null), composerRef = useRef<HTMLDivElement>(null);
	const [composerHeight, setComposerHeight] = useState(0);
	const expandComposer = () => { setComposerOpen(true); };
	useEffect(() => { if (composerOpen || chatOpen) inputRef.current?.focus(); }, [composerOpen, chatOpen]);
	useEffect(() => { const root = composerRef.current; if (!root) return; const observer = new ResizeObserver(() => setComposerHeight(root.getBoundingClientRect().height)); observer.observe(root); return () => observer.disconnect(); }, [chatOpen]);
	const [creating, setCreating] = useState(false);
	useEffect(() => setCreating(false), [active, conversationId]);
	const [sidebar, setSidebar] = useState(false);
	const [drawer, setDrawer] = useState<"recent" | string | null>(null);
	const [search, setSearch] = useState(false), [query, setQuery] = useState(""), [results, setResults] = useState<WikiSearchResult[]>([]);
	const [searching, setSearching] = useState(false), [searchLimited, setSearchLimited] = useState(false), [cursor, setCursor] = useState(0);
	const [mentionCursor, setMentionCursor] = useState(0);
	const [input, setInput] = useState(""), [refs, setRefs] = useState<string[]>([]), [selection, setSelection] = useState("");
	useExtensionEditor(conversationId, active && ready, setInput);
	const [selectionMenu, setSelectionMenu] = useState<{ text: string; x: number; y: number } | null>(null);
	const [whole, setWhole] = useState(false), [allowCode, setAllowCode] = useState(false), [sending, setSending] = useState(false);
	const [previewPrompt, setPreviewPrompt] = useState(false);
	const [viewed, setViewed] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem(`pi-wiki-viewed:${cwd}`) ?? "{}"); } catch { return {}; } });
	const [now, setNow] = useState(Date.now()), [host, setHost] = useState<HTMLElement | null>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null), article = useRef<HTMLElement>(null);
	const fileRequestRef = useRef(fileRequest);
	fileRequestRef.current = fileRequest;
	const alive = useRef(true), docSequence = useRef(0), stateSequence = useRef(0), referenceSequence = useRef(0);
	const checkedEntries = useRef(state.entries);
	const revisionRef = useRef(state.revisions), loadedPiRevision = useRef<string | undefined>(undefined);
	revisionRef.current = state.revisions;
	const docRef = useRef(doc), dirty = !!doc?.editable && doc.text !== undefined && draft !== doc.text;
	docRef.current = doc;
	const editorBusy = sending || restoring || loading || state.running || writingBlocked || (!!doc && doc.entry.path !== path);
	const busy = editorBusy || !ready;
	const [viewChange, setViewChange] = useState<WikiChange | null>(null);
	const changedPaths = new Set(state.revisions.filter(r => r.author === "pi").flatMap(r => r.changes.filter(c => !c.undone && (viewed[c.path] ?? 0) < r.at).map(c => c.path)));
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
	const hiddenRoots = useMemo(() => new Set(entries.filter(e => e.kind === "directory" && !e.path.includes("/") && e.name.startsWith(".")).map(e => e.path)), [entries]);
	const visibleEntries = useMemo(() => entries.filter(e => (showHidden || !hiddenRoots.has(e.path.split("/")[0])) && e.path.split("/").slice(0, -1).every((_, i, parts) => expanded.has(parts.slice(0, i + 1).join("/")))), [entries, expanded, showHidden, hiddenRoots]);
	const [treeScroll, setTreeScroll] = useState(0);
	const rowStart = Math.max(0, Math.floor(treeScroll / 30) - 10), rowEnd = rowStart + 70;
	const mention = /(?:^|\s)(@)([^\s]*)$/.exec(input);
	const suggestions = mention ? paths.filter(v => v.toLocaleLowerCase().includes(mention[2].toLocaleLowerCase())).slice(0, 8) : [];
	const chooseMention = (value: string) => {
		if (!mention) return;
		setRefs(r => [...new Set([...r, value])]);
		setInput(input.slice(0, mention.index).trimEnd() + " "); setMentionCursor(0); inputRef.current?.focus();
	};
	const quickQuestions = useMemo(() => doc?.entry.kind === "document" && doc.text !== undefined ? [t("wikiQuickSummary"), t("wikiQuickLinks"), ...(wikiHasEmptySections(draft) ? [t("wikiQuickSections")] : [])] : [], [doc?.entry.kind, doc?.text, draft, t]);
	const promptText = wikiPrompt(input, path, selection, refs, "", entries, whole, allowCode, { scope: t("wikiScope"), selection: t("wikiSelected"), documentsOnly: t("wikiDocumentsOnlyPrompt"), skip: t("wikiSkipPrompt") });

	useEffect(() => { alive.current = true; return () => { alive.current = false; docSequence.current++; stateSequence.current++; }; }, []);
	useEffect(() => { setHost(document.getElementById("wiki-toolbar-slot")); setStatusHost(document.getElementById("wiki-status-slot")); }, [active]);
	const loadDirectory = useCallback(async (target: string, offset = 0) => {
		try {
			const result = await wikiRequest<WikiDirectory>(cwd, "directory", { path: target, offset });
			if (alive.current) setDirectories(prev => ({ ...prev, [target]: { ...result, entries: offset ? [...(prev[target]?.entries ?? []), ...result.entries] : result.entries } }));
		} catch (e) { if (alive.current) setError((e as Error).message); }
	}, [cwd]);
	useEffect(() => {
		if (!fileRequest) return;
		if (docRef.current?.entry.path === fileRequest.path) onContentRequested(fileRequest.token);
		setFocused(false); setChatOpen(true); setDrawer(null); setPath(fileRequest.path); setSource(false); setSearch(false); setSidebar(false); setSelection(""); setSelectionMenu(null);
	}, [fileRequest, onContentRequested, doc?.entry.path]);
	useEffect(() => { if (active) void loadDirectory(""); }, [active, loadDirectory]);
	useEffect(() => { if (active && path && !fileRequest) void openDocument(path); }, [active, path, fileRequest, openDocument]);
	const refresh = useCallback(async (fresh = false) => {
		const seq = ++stateSequence.current;
		try { const result = await wikiRequest<WikiState>(cwd, fresh ? "refresh" : "state"); if (alive.current && seq === stateSequence.current) setState(result); }
		catch (e) { if (alive.current && seq === stateSequence.current) setError((e as Error).message); }
	}, [cwd]);
	const autosave = useWikiAutosave(cwd, doc, draft, loading || restoring || state.running || writingBlocked || doc?.entry.path !== path, setDoc, () => void refresh(true));
	const { save, saving } = autosave;
	useEffect(() => registerWindowSave(async () => { const ok = await save(); if (!ok) toggleChat(false); return ok; }), [save]);
	useEffect(() => {
		if (!active) return;
		void refresh();
		const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, streaming || state.running ? 1000 : 30000);
		return () => clearInterval(timer);
	}, [active, streaming, state.running, refresh]);
	useEffect(() => { if (!path) return; setExpanded(prev => { const next = new Set(prev), parts = path.split("/"); for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/")); return next; }); }, [path]);
	useEffect(() => { if (path || !state.entries.length) return; const initial = state.entries.find(e => /^(readme|index)\.md$/i.test(e.path)) ?? state.entries.find(e => e.kind === "document"); if (initial) setPath(initial.path); }, [state.entries, path]);
	const loadReferences = useCallback(async (target: string, documentSequence: number) => {
		const sequence = ++referenceSequence.current;
		try {
			const references = await wikiRequest<WikiDocumentReferences>(cwd, "document-references", { path: target });
			if (!alive.current || documentSequence !== docSequence.current || sequence !== referenceSequence.current) return;
			setDoc(current => current?.entry.path === target ? { ...current, ...references } : current);
			setReferencesReady(true);
		} catch (e) { if (alive.current && documentSequence === docSequence.current && sequence === referenceSequence.current) setError((e as Error).message); }
	}, [cwd]);
	const load = useCallback(async (target: string, markViewed = false) => {
		const seq = ++docSequence.current;
		setLoading(true); setReferencesReady(false); setBacklinkLimit(100); setError("");
		try {
			// Issue the foreground read before allowing SDK initialization to start.
			const content = wikiRequest<WikiDocumentContent>(cwd, "document-content", { path: target });
			const request = fileRequestRef.current;
			if (request?.path === target) onContentRequested(request.token);
			const result = await content;
			if (!alive.current || seq !== docSequence.current) return;
			loadedPiRevision.current = revisionRef.current.find(r => r.author === "pi" && r.changes.some(c => c.path === target))?.id;
			setDoc({ ...result, backlinks: [] }); setDraft(result.text ?? ""); setSelection(""); setSelectionMenu(null);
			void loadReferences(target, seq);
			localStorage.setItem(`pi-wiki-file:${cwd}`, target);
			if (markViewed) setViewed(v => { const next = { ...v, [target]: Date.now() }; localStorage.setItem(`pi-wiki-viewed:${cwd}`, JSON.stringify(next)); return next; });
		} catch (e) { if (alive.current && seq === docSequence.current) { setDoc(null); setError((e as Error).message); } }
		finally { if (alive.current && seq === docSequence.current) setLoading(false); }
	}, [cwd, onContentRequested, loadReferences]);
	useEffect(() => { if (path && active && docRef.current?.entry.path !== path) void load(path, true); return () => { docSequence.current++; }; }, [path, active, load]);
	useEffect(() => {
		if (active && docRef.current?.entry.path === path && state.entries.length) void loadReferences(path, docSequence.current);
	}, [state.entries, active, path, loadReferences]);
	useEffect(() => {
		if (!doc || dirty || saving || loading || streaming || state.running || !active || checkedEntries.current === state.entries) return;
		checkedEntries.current = state.entries;
		const entry = state.entries.find(e => e.path === path);
		const piRevision = state.revisions.find(r => r.author === "pi" && r.changes.some(c => c.path === path));
		if (!entry || entry.modified === doc.entry.modified) { loadedPiRevision.current = piRevision?.id; return; }
		if (!doc.editable || piRevision?.id !== loadedPiRevision.current) { void load(path); return; }
		const before = doc, sequence = docSequence.current;
		void wikiRequest<WikiDocumentContent>(cwd, "document-content", { path }).then(latest => {
			if (!alive.current || sequence !== docSequence.current || docRef.current?.version !== before.version) return;
			if (latest.version !== before.version) autosave.noteExternalChange();
			else setDoc(current => current ? { ...current, entry: latest.entry } : current);
		}).catch(e => { if (alive.current && sequence === docSequence.current) setError(e.message); });
	}, [state.entries, doc, dirty, saving, loading, active, path, load, cwd, state.revisions, state.running, streaming, autosave.noteExternalChange]);
	const navigationSequence = useRef(0);
	const navigate = useCallback<Guard>((next) => { const sequence = ++navigationSequence.current; if (dirty || saving) { void save().then(ok => { if (!alive.current || sequence !== navigationSequence.current) return; if (ok) next(); else setNav(() => next); }); } else next(); }, [dirty, saving, save]);
	useEffect(() => { guard.current = dirty || saving ? navigate : null; return () => { guard.current = null; }; }, [guard, navigate, dirty, saving]);
	useEffect(() => { const leave = (e: BeforeUnloadEvent) => { if (dirty) { void save(); e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave); }, [dirty, save]);
	const open = (target: string) => navigate(() => {
		if (target !== path) { void openDocument(target); return; }
		toggleChat(true);
		setPath(target); setSource(false); setSearch(false); setSidebar(false); setSelectionMenu(null);
		setExpanded(prev => { const next = new Set(prev), parts = target.split("/"); for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/")); return next; });
		if (target === path) void load(target, true);
	});

	useEffect(() => {
		if (!active) return;
		const key = (e: KeyboardEvent) => {
			if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing && !(e.target instanceof HTMLElement && e.target.closest("input,textarea,select,[contenteditable=true],[role=dialog]"))) { e.preventDefault(); expandComposer(); }
			if (e.key === "Tab" && (search || nav)) {
				const dialog = [...document.querySelectorAll<HTMLElement>(".wiki-modal-backdrop [role=dialog]")].at(-1);
				const items = [...(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled), input, textarea, select, [tabindex='0']") ?? [])];
				if (items.length && e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)?.focus(); }
				else if (items.length && !e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus(); }
			}
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j" && !e.isComposing && !search && !nav) { e.preventDefault(); toggleChat(!chatOpen); }
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearch(s => !s); }
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!editorBusy) void save(); }
			if (e.key === "Escape") { if (!search && !nav && !drawer && !selectionMenu && !scopeOpen) toggleChat(false); setComposerOpen(false); setScopeOpen(false); setPreviewPrompt(false); setNav(null); setSearch(false); setSelectionMenu(null); setDrawer(null); setSidebar(false); }
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
		setRestoring(true); setError("");
		try { const result = await wikiRequest<WikiState>(cwd, "restore", { id: revision.id, undo, path: file }); if (alive.current) { setState(result); if (path) await load(path); } }
		catch (e) { if (alive.current) setError((e as Error).message); }
		finally { if (alive.current) setRestoring(false); }
	};
	const submit = async (resend?: string) => {
		if (!(resend ?? input).trim() || busy || (!path && !whole && !refs.length)) return;
		setSending(true); setError("");
		try {
			if (dirty && !(await save())) return;
			await wikiRequest(cwd, "prompt", { text: resend ?? promptText, requestId: randomUuid(), conversationId });
			if (alive.current) { if (!resend) { setInput(""); setSelection(""); setRefs([]); } setPreviewPrompt(false); setScopeOpen(false); setComposerOpen(false); toggleChat(true); void refresh(); }
		} catch (e) { if (alive.current) setError((e as Error).message); }
		finally { if (alive.current) setSending(false); }
	};
	const attachResult = (result: WikiSearchResult) => { setRefs(r => [...new Set([...r, result.path])]); setSearch(false); expandComposer(); inputRef.current?.focus(); };
	const selectText = () => {
		const selected = window.getSelection();
		if (!selected || selected.isCollapsed || !article.current?.contains(selected.anchorNode) || !article.current?.contains(selected.focusNode)) { setSelectionMenu(null); return; }
		const text = selected.toString().trim().slice(0, 12000), rect = selected.getRangeAt(0).getBoundingClientRect();
		if (text) setSelectionMenu({ text, x: Math.max(8, Math.min(rect.left, window.innerWidth - 300)), y: Math.min(rect.bottom + 8, window.innerHeight - 50) });
	};
	const selectionAction = (action: "ask" | "rewrite" | "explain" | "link") => {
		if (!selectionMenu) return;
		setSelection(selectionMenu.text); setSelectionMenu(null); toggleChat(true);
		if (action !== "ask") setInput(t(action === "rewrite" ? "wikiRewritePrompt" : action === "explain" ? "wikiExplainPrompt" : "wikiLinkPrompt"));
		expandComposer(); inputRef.current?.focus();
	};
	const followLink = (href: string) => {
		let reference = href;
		try { if (href.startsWith("#wiki=")) reference = decodeURIComponent(href.slice(6)); } catch { return; }
		const target = resolveWikiLink(path, reference, paths);
		if (target) open(target); else setError(t("wikiMissingLink", { path: reference }));
	};
	const properties = useMemo(() => wikiProperties(draft).rows, [draft]);
	const metadata = useMemo(() => wikiMetadata(draft), [draft]), body = metadata.readingBody;
	const modified = new Date(doc?.entry.modified ?? 0), today = new Date(now);
	const updatedLabel = modified.toDateString() === today.toDateString()
		? t("wikiUpdatedToday", { time: modified.toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) })
		: t("wikiUpdatedDate", { date: modified.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", { month: "long", day: "numeric", ...(modified.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}) }) });
	const backlinkCount = new Set(doc?.backlinks.map(link => link.path)).size;
	const added = useMemo(() => viewChange && viewChange.path === path && !viewChange.undone ? new Set((viewChange.after ?? "").split("\n").filter(line => !(viewChange.before ?? "").split("\n").includes(line))) : new Set<string>(), [viewChange, path]);
	const showChange = async (revision: WikiRevision) => {
		const sequence = docSequence.current;
		const change = revision.changes.find(c => c.path === path) ?? revision.changes[0];
		if (!change) return;
		try {
			const full = await wikiRequest<WikiChange>(cwd, "change", { id: revision.id, path: change.path });
			if (!alive.current || sequence !== docSequence.current) return;
			setViewChange(full); if (change.path !== path) open(change.path);
			else requestAnimationFrame(() => article.current?.querySelector(".wiki-added")?.scrollIntoView({ block: "center", behavior: "smooth" }));
		} catch (e) { setError((e as Error).message); }
	};
	const headingTexts = useMemo(() => wikiHeadingTexts(body), [body]);
	const sectionHeading = (section: number) => {
		const headings = [...(article.current?.querySelectorAll<HTMLElement>(".wiki-prose h2") ?? [])];
		return headings[wikiSectionIndex(headings.map(h => h.textContent ?? ""), section)];
	};
	const jump = (section: number) => {
		const heading = sectionHeading(section);
		if (!heading) return;
		if (window.matchMedia("(max-width: 1099px)").matches) toggleChat(false);
		heading.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
		heading.animate([{ backgroundColor: "transparent" }, { backgroundColor: getComputedStyle(heading).getPropertyValue("--accent-soft").trim(), offset: .15 }, { backgroundColor: "transparent" }], { duration: 1500 });
	};
	const errorBanner = (error || sessionError) && <div className="wiki-error" role="alert"><span>{error || sessionError}</span>{sessionError && <button onClick={() => void openDocument(path)}>{t("wikiRetrySession")}</button>}<button onClick={() => setError("")} aria-label={t("close")}><FiX /></button>{doc && <button onClick={() => navigate(() => void load(path))}>{t("wikiReload")}</button>}</div>;

	const composer = <div ref={composerRef} className={`wiki-composer-area ${composerOpen || chatOpen ? "expanded" : "compact"}`}>
				{!chatOpen && !composerOpen && <div className="wiki-composer-pill">
					<button className="wiki-expand-composer" onClick={expandComposer} aria-label={t("wikiExpandComposer")}><span className="wiki-pill-file">{path.split("/").at(-1) || t("wikiMode")}</span><span>{input.trim() || t("wikiCompactPlaceholder")}</span><kbd>/</kbd></button>
					{streaming ? <button className="wiki-pill-send stop" aria-label={t("wikiStop")} onClick={() => send({ type: "abort" })}><FiSquare /></button> : <button className="wiki-pill-send" aria-label={t("wikiSend")} disabled><FiArrowUp /></button>}
				</div>}
				<div className={`wiki-composer${input.trim() ? " has-draft" : ""}`} hidden={!composerOpen && !chatOpen}>
					{(selection || refs.length > 0) && <div className="wiki-context-chips">{selection && <button className="wiki-quoted-selection" onClick={() => setSelection("")} title={t("wikiSelected")}><b>{t("wikiSelected")}</b><span>{selection}</span><FiX /></button>}{refs.map(ref => <button key={ref} onClick={() => setRefs(r => r.filter(p => p !== ref))}>@{ref}<FiX /></button>)}</div>}
					{suggestions.length > 0 && <div className="wiki-mentions">{suggestions.map(value => <button key={value} className={suggestions[mentionCursor] === value ? "selected" : ""} onClick={() => chooseMention(value)}>{mention![1]}{value}</button>)}</div>}
					<textarea ref={inputRef} aria-label={t("wikiAsk")} placeholder={doc?.entry.kind === "code" ? t("wikiAskCode", { file: doc.entry.name }) : t("wikiAskPlaceholder")} value={input} onChange={e => { setInput(e.target.value); setMentionCursor(0); }} onKeyDown={e => { if (suggestions.length && !e.nativeEvent.isComposing) { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setMentionCursor(i => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length); return; } if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseMention(suggestions[mentionCursor] ?? suggestions[0]); return; } } if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} />
					<div className="wiki-composer-controls">
						<div className="wiki-scope-control"><button aria-label={t("wikiScope")} aria-expanded={scopeOpen} onClick={() => setScopeOpen(v => !v)}>{whole ? t("wikiWholeScope") : refs.length ? t("wikiReferencedScope") : doc?.entry.name || t("wikiCurrentScope")} <FiChevronDown /></button>
							{scopeOpen && <div className="wiki-scope-menu"><button aria-pressed={!whole} onClick={() => { setWhole(false); setScopeOpen(false); }}>{t("wikiCurrentScope")}</button><button aria-pressed={whole} onClick={() => { setWhole(true); setScopeOpen(false); }}>{t("wikiWholeScope")}</button><button onClick={() => { setPreviewPrompt(v => !v); setScopeOpen(false); }}>{t("wikiPromptPreview")}</button></div>}
						</div>
						<button aria-pressed={allowCode} onClick={() => setAllowCode(v => !v)}>{t(allowCode ? "wikiMayEditCode" : "wikiDocumentsOnly")}</button>
						<span className="wiki-mention-hints"><button onClick={() => { setInput(v => v + " @"); inputRef.current?.focus(); }}>{t("wikiReferenceHint")}</button></span>
						{!chatOpen && <button className="wiki-collapse-composer" onClick={() => { setComposerOpen(false); setScopeOpen(false); }}>{t("wikiCollapseComposer")}</button>}
						{streaming ? <button className="wiki-send stopping" aria-label={t("wikiStop")} onClick={() => send({ type: "abort" })}><FiSquare /></button> : <button className="wiki-send" aria-label={t(!ready ? "wikiSessionPreparing" : sending ? "sending" : "wikiSend")} title={t(!ready ? "wikiSessionPreparing" : sending ? "sending" : "wikiSend")} disabled={busy || !input.trim() || (!path && !whole && !refs.length)} onClick={() => void submit()}>{(!ready || sending) && <span>{t(!ready ? "wikiSessionPreparing" : "sending")}</span>}<FiArrowUp /></button>}</div>
					{previewPrompt && <pre className="wiki-prompt-preview">{promptText}</pre>}
				</div>
			</div>;
	const saveStatus = doc?.editable && <button className={`wiki-save-status ${autosave.failure ? "failed" : saving || dirty ? "saving" : "saved"}`} onClick={() => void save()} title={autosave.failure || undefined} disabled={!autosave.failure || autosave.conflict} aria-live="polite"><i />{t(autosave.failure ? "wikiSaveFailedRetry" : saving || dirty ? "wikiSaving" : "wikiSaved")}</button>;
	const sourceButton = <button disabled={!doc?.editable || loading || doc.entry.path !== path} aria-pressed={source} onClick={() => setSource(s => !s)}><FiCode />{t(source ? "wikiPreview" : "wikiSource")}</button>;
	const toolbar = <>
		<div className="wiki-breadcrumb" title={`${cwd}/${path}`}><span className="wiki-path-parent">{path.includes("/") && <><span className="wiki-path-segment">{path.split("/").slice(0, -2).map(part => `${part} / `).join("")}</span><span className="wiki-path-tail">{path.split("/").at(-2)} / </span></>}</span><b>{path.split("/").at(-1) || t("wikiMode")}</b>{saveStatus}</div>
		<div className="wiki-toolbar-actions">
			<button onClick={() => { setFocused(false); toggleChat(false); setDrawer(drawer === "recent" ? null : "recent"); }} className={drawer === "recent" ? "active" : ""}><FiClock />{t("wikiRecent")}</button>
			<button className={`wiki-chat-toggle ${chatOpen ? "active" : ""}`} aria-label={t("wikiChatPanel")} aria-expanded={chatOpen} onClick={() => toggleChat(!chatOpen)}><span>π</span>{t("wikiChatTitle")}<kbd>{navigator.platform.includes("Mac") ? "⌘J" : "Ctrl+J"}</kbd></button>
		</div>
	</>;
	return <section className={`wiki-workbench ${focused ? "is-focused" : ""} ${drawer ? "with-drawer" : ""} ${chatOpen ? "with-chat" : ""}`} aria-label={t("wikiMode")}>
		{active && host && createPortal(toolbar, host)}
		{active && statusHost && state.index && createPortal(<WikiIndexIndicator status={state.index} />, statusHost)}
		<aside className={`wiki-sidebar ${sidebar ? "open" : ""}`}>
			<button className="wiki-search-trigger" onClick={() => setSearch(true)}><FiSearch /><span>{t("wikiSearchAll")}</span><kbd>⌘K</kbd></button>
			<div className="wiki-tree-label"><span>{t("wikiFiles")}</span><button aria-label={t("newWorkspaceFile")} title={t("newWorkspaceFile")} disabled={writingBlocked || !connected || state.running} onClick={() => setCreating(value => !value)}><FiPlus /></button><button aria-label={t("wikiRefresh")} onClick={() => void refresh(true)}><FiRefreshCw /></button></div>
			{creating && <CreateFileForm key={`${cwd}:${conversationId}`} cwd={cwd} conversationId={conversationId} initialPath={path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : ""} disabled={writingBlocked || !connected || state.running} onCancel={() => setCreating(false)} onCreated={target => { setCreating(false); void refresh(true); open(target); }} />}
			<div className="wiki-tree" role="tree" aria-label={t("wikiFiles")} onScroll={e => setTreeScroll(e.currentTarget.scrollTop)}>
				{hiddenRoots.size > 0 && <button className="wiki-tree-row wiki-hidden-folders" role="treeitem" aria-expanded={showHidden} onClick={() => { const value = !showHidden; setShowHidden(value); localStorage.setItem(`pi-wiki-hidden:${cwd}`, String(value)); setTreeScroll(0); }}>
					{showHidden ? <FiChevronDown /> : <FiChevronRight />}<span>{t("wikiHiddenFolders", { count: hiddenRoots.size })}</span>
				</button>}
				<div style={{ height: rowStart * 30 }} />
				{visibleEntries.slice(rowStart, rowEnd).map(entry => <button key={entry.path} role="treeitem" aria-selected={entry.path === path} aria-expanded={entry.kind === "directory" ? expanded.has(entry.path) : undefined} className={`wiki-tree-row ${entry.path === path ? "selected" : ""}`} style={{ paddingLeft: 12 + (entry.path.split("/").length - 1) * 16 }} title={entry.path} onClick={() => entry.kind === "directory" ? setExpanded(prev => { const next = new Set(prev); if (next.has(entry.path)) next.delete(entry.path); else { next.add(entry.path); void loadDirectory(entry.path); } return next; }) : open(entry.path)}>
					{entry.kind === "directory" ? expanded.has(entry.path) ? <FiChevronDown /> : <FiChevronRight /> : <i className="wiki-tree-spacer" />}<span>{entry.name}</span>{changedPaths.has(entry.path) && <i className="wiki-unread" aria-label={t("wikiUnread")} />}
				</button>)}<div style={{ height: Math.max(0, visibleEntries.length - rowEnd) * 30 }} />
				{Object.values(directories).filter(d => d.nextOffset !== undefined && (state.limited || entries.some(e => e.symlink && d.path.startsWith(e.path))) && (!d.path || expanded.has(d.path))).map(d => <button className="wiki-load-more" key={d.path} onClick={() => void loadDirectory(d.path, d.nextOffset)}>{t("wikiLoadMore")} · {d.path || "/"}</button>)}
				{!visibleEntries.length && <p className="wiki-muted">{t("wikiNoFiles")}</p>}
			</div>
		</aside>
		{sidebar && <button className="wiki-sidebar-scrim" aria-label={t("close")} onClick={() => setSidebar(false)} />}
		<div className="wiki-main">
			<div className="wiki-document-toolbar">
				<div className="wiki-mobile-tools"><button aria-label={t("wikiFiles")} onClick={() => { setFocused(false); setSidebar(s => !s); }}><FiMenu /></button><button aria-label={t("wikiSearchAll")} onClick={() => setSearch(true)}><FiSearch /></button></div>
				<div className="wiki-editor-toolbar-slot" ref={setEditorToolbarHost} />
				{doc?.entry.kind === "code" && <div className="wiki-toolbar-actions">{sourceButton}</div>}
			</div>
			{!chatOpen && errorBanner}
			{autosave.conflict && <div className="wiki-conflict" role="alert"><span>{t("wikiExternalChanged")}</span><button disabled={editorBusy} onClick={() => void load(path)}>{t("wikiReload")}</button><button disabled={editorBusy || saving} onClick={() => void autosave.keepMine()}>{t("wikiKeepMine")}</button></div>}

			<div className="wiki-scroll" ref={scrollRef} style={{ paddingBottom: chatOpen ? 0 : Math.max(0, composerHeight - 120) }} onScroll={() => setSelectionMenu(null)}>
				{loading ? <div className="wiki-empty">{t("loading")}</div> : doc ? <article className={`wiki-document ${source || doc.entry.kind === "code" ? "is-source" : ""}`} ref={article} onMouseUp={source ? selectText : undefined} onKeyUp={source ? selectText : undefined}>
					<header className="wiki-document-heading"><h1>{metadata.title || doc.entry.name.replace(/\.(md|txt)$/i, "")}</h1><div className="wiki-document-meta"><span className="wiki-meta-chip"><FiCalendar />{updatedLabel}</span>{doc.text !== undefined && <span className="wiki-meta-chip"><FiClock />{t("wikiReadingTime", { minutes: metadata.minutes })}</span>}{metadata.tags.map(tag => <span className="wiki-meta-chip wiki-meta-tag" key={tag}>#{tag}</span>)}{(!referencesReady || backlinkCount > 0) && <button onClick={() => article.current?.querySelector(".wiki-backlinks")?.scrollIntoView({ behavior: "smooth" })}>{referencesReady ? t("wikiCitations", { count: backlinkCount }) : t("wikiReferencesLoading")}</button>}</div>{doc?.entry.kind === "document" && properties.length > 0 && <details className="wiki-properties" open><summary>{t("wikiProperties")}</summary><dl>{properties.map((property, index) => <div key={index}><dt>{property.key}</dt><dd><ReactMarkdown>{property.value}</ReactMarkdown></dd></div>)}</dl></details>}</header>
					{doc.text !== undefined ? (source || doc.entry.kind === "code" ? <><div className="wiki-code-hint">{doc.entry.kind === "code" && !source ? t("wikiCodeReadOnly") : t("wikiEditingSource")}</div><CodeFileEditor value={draft} name={path} readOnly={editorBusy || !doc.editable || (!source && doc.entry.kind === "code")} wrap={false} onChange={setDraft} onSelectLines={(start, end) => setSelection(draft.split("\n").slice(start - 1, end).join("\n"))} /></> : <div className="wiki-prose md"><RichMarkdownEditor key={`${cwd}:${path}`} file={{ cwd, path }} value={draft} readOnly={editorBusy || !doc.editable} onChange={setDraft} wiki={{ toolbarHost: editorToolbarHost, focused, onWidth: () => { setFocused(!focused); toggleChat(false); setComposerOpen(false); setDrawer(null); setSidebar(false); }, paths, ask: text => { setSelection(text.slice(0, 12000)); toggleChat(true); expandComposer(); inputRef.current?.focus(); }, followLink, resolveCode: value => resolveWikiLink(path, value, paths), added }} /></div>) : doc.entry.kind === "image" ? <img className="wiki-image" src={wikiMedia(cwd, path)} alt={doc.entry.name} /> : doc.entry.kind === "pdf" ? <iframe className="wiki-pdf" title={doc.entry.name} src={wikiMedia(cwd, path)} /> : <div className="wiki-empty"><FiFile /><p>{doc.entry.name} · {Math.ceil(doc.entry.size / 1024)} KB</p>{desktopAPI?.openWikiFile ? <button onClick={() => void desktopAPI!.openWikiFile!({ clientId: getClientId(), cwd, path }).catch(e => setError(e.message))}>{t("wikiOpenDefault")}</button> : <a href={wikiMedia(cwd, path, true)} download>{t("wikiDownloadOpen")}</a>}</div>}
					{(!referencesReady || doc.backlinks.length > 0) && <section className="wiki-backlinks"><h2><FiLink />{t("wikiBacklinks")} <span>{referencesReady ? doc.backlinks.length : t("loading")}</span></h2>{doc.backlinks.slice(0, backlinkLimit).map((link, index) => <button key={`${link.path}:${index}`} onClick={() => open(link.path)}><strong>{link.path}</strong><span>{link.snippet}</span></button>)}{doc.backlinks.length > backlinkLimit && <button onClick={() => setBacklinkLimit(n => n + 100)}>{t("wikiLoadMore")}</button>}{!referencesReady && <p>{t("wikiReferencesLoading")}</p>}{referencesReady && !doc.backlinks.length && <p>{t("wikiNoBacklinks")}</p>}</section>}
				</article> : <div className="wiki-empty"><FiBookOpen /><h1>{t("wikiWelcome")}</h1><p>{t("wikiWelcomeHint")}</p><button onClick={() => setSearch(true)}>{t("wikiSearchAll")}</button></div>}
			</div>
			{!chatOpen && composer}
		</div>
		{chatOpen && <><button className="wiki-chat-scrim" aria-label={t("wikiCloseChat")} onClick={() => toggleChat(false)} /><WikiChatPanel onStop={() => send({ type: "abort" })} recovery={recovery} conversationId={conversationId} thinkingWrap={thinkingWrap} connected={connected} silenceNotified={silenceNotified} messages={messages} live={live} streaming={streaming} toolStatuses={toolStatuses} model={model ?? undefined} contextPercent={contextPercent} disabled={busy} onNew={() => navigate(() => void openDocument(path))} onClose={() => toggleChat(false)} canJump={n => !source && wikiSectionIndex(headingTexts, n) >= 0} jump={jump} composer={composer} quickQuestions={quickQuestions} onQuickQuestion={question => void submit(wikiPrompt(question, path, "", [], "", [], false, false, { scope: t("wikiScope"), selection: t("wikiSelected"), documentsOnly: t("wikiDocumentsOnlyPrompt"), skip: t("wikiSkipPrompt") }))} revisions={state.revisions} onViewChange={revision => void showChange(revision)} onUndo={revision => void restore(revision, !revision.changes.every(c => c.undone))} onResend={text => void submit(text)} error={errorBanner} /></>}
		{drawer && <aside className="wiki-changes"><header><div><h2>{t(drawer === "recent" ? "wikiRecent" : "wikiRelatedChanges")}</h2><span>{cwd.split(/[\\/]/).at(-1)}</span></div><button aria-label={t("close")} onClick={() => setDrawer(null)}><FiX /></button></header><div className="wiki-changes-scroll">{state.revisions.filter(r => drawer === "recent" || r.id === drawer).map((revision, index, list) => <div key={revision.id} className="wiki-revision">{(index === 0 || new Date(list[index - 1].at).toDateString() !== new Date(revision.at).toDateString()) && <time>{new Date(revision.at).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US")}</time>}<div className="wiki-revision-title"><span className={`wiki-avatar ${revision.author}`}>{revision.author === "pi" ? <img src="/icon/1a-mark.svg" alt="pi" /> : t("wikiMe")}</span><div><strong>{revision.title.split("\n")[0]}</strong><small>{new Date(revision.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {t("wikiFileCount", { count: revision.changes.length })}</small></div></div><div className="wiki-revision-actions"><button disabled={busy || revision.changes.every(c => c.undone)} onClick={() => void restore(revision, true)}><FiCornerUpLeft />{t("wikiUndoAll")}</button><button disabled={busy || revision.changes.every(c => !c.undone)} onClick={() => void restore(revision, false)}><FiCornerUpRight />{t("wikiRedoAll")}</button></div>{revision.changes.map(summary => { const change = { ...summary, ...(fullChanges[`${revision.id}:${summary.path}`] ?? {}), undone: summary.undone }; return <div className={`wiki-file-change ${change.undone ? "undone" : ""}`} key={change.path}><div><button title={change.path} onClick={() => open(change.path)}>{change.path}</button><button disabled={busy} onClick={() => void restore(revision, !change.undone, change.path)}>{t(change.undone ? "wikiRedo" : "wikiUndo")}</button></div><small><em>+{change.additions}</em> <b>−{change.deletions}</b></small><details onToggle={e => { if (e.currentTarget.open && change.truncated) void wikiRequest<WikiChange>(cwd, "change", { id: revision.id, path: change.path }).then(result => { if (alive.current) setFullChanges(previous => ({ ...previous, [`${revision.id}:${change.path}`]: result })); }).catch(e => setError(e.message)); }}><summary>{t("wikiViewDiff")}</summary>{change.binary ? <p>{t("wikiBinaryChange")}</p> : <><pre className="wiki-diff-before">{change.before ?? t("wikiNewFile")}</pre><pre className="wiki-diff-after">{change.after ?? t("wikiDeletedFile")}</pre></>}</details></div>; })}{revision.skipped.length > 0 && <p className="wiki-skipped">{t("wikiUntracked")}: {revision.skipped.join(", ")}</p>}</div>)}{!state.revisions.length && <p className="wiki-muted">{t("wikiNoChanges")}</p>}</div></aside>}
		{selectionMenu && createPortal(<div className="wiki-selection-menu" style={{ left: selectionMenu.x, top: selectionMenu.y }} onMouseDown={e => e.preventDefault()}>{(["ask", "rewrite", "explain", "link"] as const).map(action => <button key={action} onClick={() => selectionAction(action)}>{t(action === "ask" ? "wikiAskPi" : action === "rewrite" ? "wikiRewrite" : action === "explain" ? "wikiExplain" : "wikiAddLink")}</button>)}</div>, document.body)}
		{search && <div className="wiki-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSearch(false); }}><section className="wiki-search-modal" role="dialog" aria-modal="true" aria-label={t("wikiSearchAll")}><div><FiSearch /><input autoFocus aria-label={t("wikiSearchAll")} placeholder={t("wikiSearchHint")} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setCursor(i => Math.max(0, Math.min(results.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))); } if (e.key === "Enter" && results[cursor]) { e.preventDefault(); if (e.metaKey || e.ctrlKey) attachResult(results[cursor]); else open(results[cursor].path); } }} /><button aria-label={t("close")} onClick={() => setSearch(false)}><FiX /></button></div><div className="wiki-search-results">{searching && <p role="status">{t("loading")}</p>}{results.map((result, i) => <div key={`${result.path}:${result.line}:${i}`}>{(i === 0 || results[i - 1].kind !== result.kind) && <h3>{t(result.kind === "document" ? "wikiDocuments" : result.kind === "pdf" ? "wikiPdf" : result.kind === "code" ? "wikiCode" : "wikiFiles")}</h3>}<button className={cursor === i ? "selected" : ""} onMouseEnter={() => setCursor(i)} onClick={e => e.metaKey || e.ctrlKey ? attachResult(result) : open(result.path)}><strong>{result.path}{result.page ? ` · ${t("wikiPage", { page: result.page })}` : ""}</strong><span>{result.snippet}</span></button></div>)}{query && !searching && !results.length && <p>{t("wikiNoResults")}</p>}{searchLimited && <p>{t("wikiSearchLimited")}</p>}</div><footer>{t("wikiSearchKeys")}</footer></section></div>}
		{nav && <div className="wiki-modal-backdrop"><section className="wiki-confirm" role="dialog" aria-modal="true" aria-label={t("wikiUnsaved")}><h2>{t("wikiUnsaved")}</h2><p>{t("wikiUnsavedHint")}</p><div><button disabled={saving} onClick={() => setNav(null)}>{t("cancel")}</button><button disabled={saving} onClick={() => { const next = nav; setDraft(doc?.text ?? ""); setNav(null); next(); }}>{t("wikiDiscard")}</button><button disabled={busy} onClick={() => void (async () => { if (await save()) { const next = nav; setNav(null); next(); } })()}>{t("wikiSaveContinue")}</button></div></section></div>}
	</section>;
}
