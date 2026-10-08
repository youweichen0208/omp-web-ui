import { useEffect, useMemo, useRef, useState } from "react";
import { FiList, FiSearch, FiChevronsDown, FiX, FiChevronDown, FiChevronRight, FiExternalLink } from "react-icons/fi";
import { changedWords, foldDiff, parseUnifiedDiff, type ChangedFile } from "../changes";
import { useChanges, type ChangesScope } from "../changes-context";
import type { ClientMessage, ServerMessage, ScmBranchEntry } from "../types";
import { useT } from "../i18n";
import { ChangeCounts } from "./ChangeSummaryCard";

let diffRequestId = -1000000;
export function ChangesPanel({ cwd, data, send, notRepo, branch, branches, defaultBase, dirty, ready }: { cwd: string; data: ServerMessage | null; send: (message: ClientMessage) => boolean; notRepo: boolean; branch: string; defaultBase: string; branches: ScmBranchEntry[]; dirty: number; ready: boolean }) {
	const changes = useChanges()!, t = useT();
	const [result, setResult] = useState<{ key: string; files: ChangedFile[]; error?: string; base?: string }>();
	const [search, setSearch] = useState(false), [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	const [expandedGaps, setExpandedGaps] = useState<Set<string>>(new Set());
	const request = useRef(0), body = useRef<HTMLDivElement>(null), searchInput = useRef<HTMLInputElement>(null);
	const scope = notRepo ? "turn" : changes.scope;
	const key = `${cwd}\0${scope}\0${changes.base}`;
	useEffect(() => {
		if (!changes.open || scope === "turn" || !ready) return;
		const refresh = () => { const id = --diffRequestId; if (send({ type: "scm_diff", reqId: id, scope, base: changes.base || undefined })) request.current = id; };
		refresh(); const timer = setInterval(refresh, 30000);
		return () => { clearInterval(timer); request.current = 0; };
	}, [changes.open, scope, changes.base, cwd, dirty, ready, send]);
	useEffect(() => {
		if (data?.type !== "scm_data" || data.kind !== "diff" || data.reqId !== request.current || data.cwd !== cwd) return;
		setResult({ key, files: data.ok ? parseUnifiedDiff(data.text ?? "") : [], error: data.error, base: data.base });
	}, [data, key, cwd]);
	const files = scope === "turn" ? changes.files : result?.key === key ? result.files : [];
	const loading = scope !== "turn" && result?.key !== key;
	const filtered = useMemo(() => query.trim() ? files.filter(file => file.path.toLowerCase().includes(query.toLowerCase()) || file.lines.some(line => line.text.toLowerCase().includes(query.toLowerCase()))) : files, [files, query]);
	const isCollapsed = (file: ChangedFile) => collapsed[file.path] ?? file.lines.filter(line => line.marker !== " ").length > 400;
	const focusFile = (path: string) => {
		changes.set({ selected: path }); setCollapsed(previous => ({ ...previous, [path]: false }));
		requestAnimationFrame(() => Array.from(body.current?.querySelectorAll<HTMLElement>("[data-change-file]") ?? []).find(element => element.dataset.changeFile === path)?.scrollIntoView({ block: "start" }));
	};
	useEffect(() => {
		if (!changes.open) return;
		setQuery("");
		if (changes.selected) focusFile(changes.selected);
		else if (changes.focusRequest > 0) { setCollapsed(Object.fromEntries(files.map(file => [file.path, false]))); if (files[0]) focusFile(files[0].path); }
		// Explicit summary-card navigation, not scroll selection.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [changes.focusRequest, changes.open]);
	useEffect(() => { if (search) searchInput.current?.focus(); }, [search]);
	if (!changes.open) return null;
	return <aside className="changes-panel" aria-label={t("changesTitle")} tabIndex={0} onKeyDown={event => {
		const target = event.target as HTMLElement;
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); event.stopPropagation(); setSearch(true); }
		else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (search) { setSearch(false); setQuery(""); event.currentTarget.focus(); } else document.querySelector<HTMLTextAreaElement>(".inputbox textarea")?.focus(); }
		else if (!target.closest("input,textarea,select") && !event.metaKey && !event.ctrlKey && ["j", "k"].includes(event.key.toLowerCase())) {
			event.preventDefault(); const rows = Array.from(body.current?.querySelectorAll<HTMLElement>("[data-change-hunk]") ?? []);
			const top = body.current?.getBoundingClientRect().top ?? 0;
			const candidates = event.key.toLowerCase() === "j" ? rows : rows.slice().reverse();
			const next = candidates.find(row => event.key.toLowerCase() === "j" ? row.getBoundingClientRect().top > top + 45 : row.getBoundingClientRect().top < top + 35);
			next?.scrollIntoView({ block: "start" });
		}
	}}>
		<header className="changes-toolbar">
			<button title={t("changesList")} aria-label={t("changesList")} aria-pressed={changes.list} onClick={() => changes.set({ list: !changes.list })}><FiList /></button>
			{!notRepo && <label className="changes-branch"><select aria-label={t("changesBase")} value={changes.base || result?.base || defaultBase || ""} onChange={event => changes.set({ base: event.target.value })}><option value="">{t("changesBase")}</option>{[...new Set([...branches.map(item => item.name), ...(result?.base ? [result.base] : [])])].map(name => <option key={name}>{name}</option>)}</select><span>→</span><code title={branch}>{branch}</code></label>}
			{!notRepo && <div className="changes-scopes">{(["turn", "branch", "work"] as ChangesScope[]).map(value => <button key={value} aria-pressed={scope === value} onClick={() => { changes.set({ scope: value }); setCollapsed({}); setExpandedGaps(new Set()); }}>{t(value === "turn" ? "changesTurn" : value === "branch" ? "changesBranch" : "changesWork")}</button>)}</div>}
			<button title={t("changesSearch")} aria-label={t("changesSearch")} onClick={() => setSearch(!search)}><FiSearch /></button>
			<button title={t("changesExpand")} aria-label={t("changesExpand")} onClick={() => { const close = files.some(file => !isCollapsed(file)); setCollapsed(Object.fromEntries(files.map(file => [file.path, close]))); }}><FiChevronsDown /></button>
			<button title={`${t("close")} (⌘D)`} aria-label={t("close")} onClick={() => changes.set({ open: false })}><FiX /></button>
		</header>
		{search && <div className="changes-search"><FiSearch /><input ref={searchInput} value={query} placeholder={t("changesSearch")} aria-label={t("changesSearch")} onChange={event => setQuery(event.target.value)} /><span>{filtered.length} / {files.length}</span></div>}
		<div className="changes-content">
			{changes.list && <nav className="changes-files" aria-label={t("changesList")}><header>{t("changesFiles", { n: files.length })}<ChangeCounts files={files} /></header>{filtered.map(file => <button key={file.path} className={changes.selected === file.path ? "selected" : ""} onClick={() => focusFile(file.path)}><code>{file.path.split("/").at(-1)}</code><span><span className="change-directory">{file.path.split("/").slice(0, -1).join("/") || "."}</span><ChangeCounts files={[file]} /></span></button>)}</nav>}
			<div className="changes-diffs" ref={body} onScroll={() => {
				const top = body.current!.getBoundingClientRect().top;
				const elements = Array.from(body.current!.querySelectorAll<HTMLElement>("[data-change-file]"));
				const selected = elements.find(element => element.getBoundingClientRect().bottom > top + 40)?.dataset.changeFile;
				if (selected && selected !== changes.selected) changes.set({ selected });
			}}>
				{loading ? <p className="changes-empty">{t("changesLoading")}</p> : result?.key === key && result.error && scope !== "turn" ? <p className="changes-empty" role="alert">{result.error}</p> : !filtered.length && <p className="changes-empty">{t("changesEmpty")}</p>}
				{filtered.map(file => <DiffFile key={file.path} file={file} selected={changes.selected === file.path} collapsed={isCollapsed(file)} toggle={() => { changes.set({ selected: file.path }); setCollapsed(previous => ({ ...previous, [file.path]: !isCollapsed(file) })); }} gaps={expandedGaps} expandGap={id => setExpandedGaps(previous => new Set([...previous, id]))} query={query} />)}
			</div>
		</div>
	</aside>;
}

function DiffFile({ file, selected, collapsed, toggle, gaps, expandGap, query }: { file: ChangedFile; selected: boolean; collapsed: boolean; toggle: () => void; gaps: Set<string>; expandGap: (id: string) => void; query: string }) {
	const t = useT();
	const changes = useChanges();
	const changesClose = () => changes?.set({ open: false });
	const [recent, setRecent] = useState(!!file.toolIds?.length);
	useEffect(() => { const timer = setTimeout(() => setRecent(false), 3000); return () => clearTimeout(timer); }, []);
	const signature = file.toolIds?.join(",") ?? "";
	const previous = useRef(signature);
	useEffect(() => { if (previous.current === signature) return; previous.current = signature; setRecent(true); const timer = setTimeout(() => setRecent(false), 3000); return () => clearTimeout(timer); }, [signature]);
	const peers = useMemo(() => {
		const pairs = new Map<number, string>();
		for (let index = 0; index < file.lines.length;) {
			if (file.lines[index].marker !== "-") { index++; continue; }
			const start = index; while (file.lines[index]?.marker === "-") index++;
			const added = index; while (file.lines[index]?.marker === "+") index++;
			for (let n = 0; n < Math.min(added - start, index - added); n++) { pairs.set(start + n, file.lines[added + n].text); pairs.set(added + n, file.lines[start + n].text); }
		}
		return pairs;
	}, [file.lines]);
	const renderLine = (index: number) => {
		const line = file.lines[index];
		const kind = line.marker === "+" ? "add" : line.marker === "-" ? "del" : "context";
		const peer = peers.get(index);
		const parts = peer === undefined ? [{ text: line.text, changed: false }] : changedWords(line.text, peer);
		return <div key={index} className={`changes-line ${kind}${query && line.text.toLowerCase().includes(query.toLowerCase()) ? " search-match" : ""}`} data-change-hunk={line.marker !== " " && (index === 0 || file.lines[index - 1].marker === " ") ? "" : undefined}><span className="changes-line-number">{line.newLine ?? line.oldLine}</span><span className="changes-line-sign">{line.marker}</span><code className={/^#{1,6} /.test(line.text) ? "markdown-heading" : ""}>{parts.map((part, n) => part.changed ? <mark key={n}>{part.text}</mark> : part.text)}</code></div>;
	};
	const firstChanged = file.lines.find(line => line.marker !== " ");
	return <section className={`changes-file ${selected ? "selected" : ""}`} data-change-file={file.path}>
		<header className="changes-file-head"><button aria-expanded={!collapsed} onClick={toggle}>{collapsed ? <FiChevronRight /> : <FiChevronDown />}<code title={file.path}>{file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path.split("/").at(-1)}</code><span className="change-directory">{file.path.split("/").slice(0, -1).join("/")}</span><ChangeCounts files={[file]} />{recent && <span className="changes-recent" title={t("changesRecent")}>●</span>}</button><button className="changes-open-file" title={t("changeOpen")} onClick={() => { changesClose(); window.dispatchEvent(new CustomEvent("pi-harness:open-tool-file", { detail: { path: file.path, line: firstChanged?.newLine ?? firstChanged?.oldLine ?? 1 } })); }}>{t("changeOpen")} <FiExternalLink /></button></header>
		{collapsed && file.lines.filter(line => line.marker !== " ").length > 400 && <button className="changes-gap" onClick={toggle}>{t("changesLarge")}</button>}
		{!collapsed && (file.binary ? <p className="changes-empty">{t("changesBinary")}</p> : <div className="changes-file-lines">
			{!file.lines.length && <p className="changes-meta">{t("changesUnavailable")}</p>}
			{file.unlocated && <p className="changes-meta">{t("changesUnlocated")}</p>}
			{foldDiff(file.lines).map(row => row.kind === "line" ? renderLine(row.index) : gaps.has(`${file.path}:${row.start}`) || query ? Array.from({ length: row.end - row.start }, (_, n) => renderLine(row.start + n)) : <button key={`gap:${row.start}`} className="changes-gap" onClick={() => expandGap(`${file.path}:${row.start}`)}>{t(row.end === file.lines.length ? "changesTrailing" : "changesUnchanged", { n: row.end - row.start })}</button>)}
			{file.truncated && <p className="changes-meta">{t("changesTruncated")}</p>}
		</div>)}
	</section>;
}
