import { memo, useCallback, useEffect, useRef, useState } from "react";
import { FiChevronRight, FiDownload, FiLink, FiMaximize2, FiMoreHorizontal, FiPlus, FiRefreshCw, FiX } from "react-icons/fi";
import type { FileEntry, FileListing, ScmFileEntry, ServerMessage, TaskProgress, UiMessage } from "../types";
import { useT } from "../i18n";
import { downloadFile } from "../download";
import { mentionedHiddenDirs } from "../conversation-files";
import { CreateFileForm } from "./CreateFileForm";
import { TaskProgressPanel } from "./TaskProgressPanel";

type AttachMode = "inline" | "reference";
interface RightPanelProps {
	active: boolean;
	files: FileListing | null;
	fileChanged: { path: string } | null;
	changed: ScmFileEntry[];
	notRepo: boolean;
	widgets: { key: string; lines: string[] }[];
	messages: UiMessage[];
	streamingMessage: UiMessage | null;
	taskProgress?: TaskProgress | null;
	isStreaming?: boolean;
	conversationId: string;
	agentSilence?: Extract<ServerMessage, { type: "agent_silence" }> | null;
	cwd: string;
	send: (msg: { type: "list_files"; path?: string }) => boolean;
	onAttach: (path: string, name: string, mode: AttachMode, isDir?: boolean) => void;
	onPreview: (path: string, name: string) => void;
	onNotice: (level: "info" | "warning" | "error", text: string) => void;
}

export const RightPanel = memo(function RightPanel({ active, files, fileChanged, changed, notRepo, widgets, messages, streamingMessage, isStreaming, taskProgress, conversationId, agentSilence, cwd, send, onAttach, onPreview, onNotice }: RightPanelProps) {
	const t = useT();
	const [creating, setCreating] = useState(false);
	useEffect(() => setCreating(false), [cwd, conversationId, active]);
	const [expandedWidget, setExpandedWidget] = useState<string | null>(null);
	const [directories, setDirectories] = useState<Record<string, FileListing>>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [onlyChanged, setOnlyChanged] = useState(false);
	const [showOtherDirectories, setShowOtherDirectories] = useState(false);
	useEffect(() => setShowOtherDirectories(false), [cwd, taskProgress?.id]);
	const compactTree = taskProgress?.status === "running" && !notRepo && changed.length > 0 && !showOtherDirectories;
	const [showHidden, setShowHidden] = useState(true);
	const [controlsOpen, setControlsOpen] = useState(false);
	const controlsRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!controlsOpen) return;
		const closeOutside = (event: PointerEvent) => { if (!controlsRef.current?.contains(event.target as Node)) setControlsOpen(false); };
		const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setControlsOpen(false); };
		document.addEventListener("pointerdown", closeOutside, true);
		document.addEventListener("keydown", closeEscape);
		return () => { document.removeEventListener("pointerdown", closeOutside, true); document.removeEventListener("keydown", closeEscape); };
	}, [controlsOpen]);
	const allMessages = streamingMessage ? [...messages, streamingMessage] : messages;
	const hiddenMentioned = mentionedHiddenDirs(allMessages);
	const owner = useRef(cwd);
	const seenFiles = useRef<FileListing | null>(null);
	const queue = useRef<string[]>([]);
	const pending = useRef<string | null>(null);
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	const pump = useCallback(() => {
		if (!active || pending.current !== null) return;
		const path = queue.current.shift();
		if (path === undefined) return;
		pending.current = path;
		if (!send({ type: "list_files", path: path || undefined })) pending.current = null;
	}, [active, send]);
	const request = useCallback((path: string) => {
		if (pending.current !== path && !queue.current.includes(path)) queue.current.push(path);
		pump();
	}, [pump]);
	useEffect(() => {
		if (owner.current !== cwd) {
			owner.current = cwd;
			seenFiles.current = files;
			queue.current = [];
			pending.current = null;
			setDirectories({});
			setExpanded(new Set());
			setOnlyChanged(false);
		}
		if (!active || !cwd) return;
		request("");
		const timer = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			// Retry a response lost during a disconnect, then refresh visible nodes.
			pending.current = null;
			request("");
			for (const path of expandedRef.current) request(path);
		}, 10000);
		return () => clearInterval(timer);
	}, [active, cwd, request]);
	useEffect(() => {
		if (!files || files === seenFiles.current || owner.current !== cwd) return;
		seenFiles.current = files;
		setDirectories((previous) => ({ ...previous, [files.path]: files }));
		if (pending.current === files.path) pending.current = null;
		pump();
	}, [files, cwd, pump]);
	useEffect(() => {
		if (active && fileChanged) request(fileChanged.path);
	}, [active, fileChanged, request]);
	useEffect(() => { if (notRepo || !changed.length) setOnlyChanged(false); }, [notRepo, changed]);
	const refreshFiles = () => {
		pending.current = null;
		request("");
		for (const path of expandedRef.current) request(path);
	};
	const toggle = (path: string) => {
		setExpanded((previous) => {
			const next = new Set(previous);
			if (next.has(path)) next.delete(path); else next.add(path);
			return next;
		});
		if (!expanded.has(path)) request(path);
	};
	const directoryEntries = (path: string): { entry: FileEntry; virtual: boolean }[] => {
		const entries = (directories[path]?.entries ?? []).map((entry) => ({ entry, virtual: false }));
		const known = new Set(entries.map(({ entry }) => entry.name));
		for (const change of changed) {
			if (change.x !== "D" && change.y !== "D") continue;
			const relative = path ? change.path.startsWith(`${path}/`) ? change.path.slice(path.length + 1) : "" : change.path;
			if (!relative) continue;
			const name = relative.split("/")[0];
			if (known.has(name)) continue;
			known.add(name);
			entries.push({ entry: { name, path: path ? `${path}/${name}` : name, type: relative.includes("/") ? "dir" : "file" }, virtual: true });
		}
		return entries.sort((a, b) => a.entry.type === b.entry.type ? a.entry.name.localeCompare(b.entry.name) : a.entry.type === "dir" ? -1 : 1);
	};
	const renderEntry = (entry: FileEntry, depth: number, virtual: boolean) => {
		const dir = entry.type === "dir";
		const open = expanded.has(entry.path);
		const count = changed.filter((change) => change.path === entry.path || (dir && change.path.startsWith(`${entry.path}/`))).length;
		const change = !dir ? changed.find((item) => item.path === entry.path) : undefined;
		const changeKind = change ? change.x === "D" || change.y === "D" ? "D" : change.x === "A" || change.y === "A" || change.x === "?" ? "A" : "M" : null;
		if (compactTree && depth === 0 && dir && count === 0) return null;
		const mentioned = dir && entry.name.startsWith(".") && hiddenMentioned.has(entry.name);
		if ((!showHidden && entry.name.startsWith(".") || onlyChanged && !count) && !mentioned) return null;
		return <div key={entry.path} role="treeitem" aria-expanded={dir ? open : undefined}>
			<div className={`file-item ${dir ? "dir" : "file"}`} style={{ paddingLeft: 6 + depth * 16 }}>
				<button type="button" data-tree-node={entry.path} className={dir ? "file-dir-main" : "file-name"} title={entry.path} disabled={virtual && !dir} onClick={() => dir ? virtual ? setExpanded((previous) => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }) : toggle(entry.path) : onPreview(entry.path, entry.name)}>
					<span className={`tree-caret ${open ? "open" : ""}`}>{dir && <FiChevronRight />}</span>
					<span className={dir ? "file-name" : "file-name-text"}>{entry.name}</span>
				</button>
				{dir && count > 0 && <span className="tree-modified-count" title={t("workspaceChanges", { n: count })}>{count}</span>}
				{changeKind && <span className={`tree-change-badge ${changeKind.toLowerCase()}`} title={changeKind === "A" ? "Added" : changeKind === "D" ? "Deleted" : "Modified"}>{changeKind}</span>}
				{!dir && !virtual && <button type="button" className="file-attach download" title={t("downloadFile")} onClick={() => void downloadFile(entry.path, entry.name).then((result) => { if (!result.ok && !result.cancelled) onNotice("error", t("downloadFailed", { error: result.error })); })}><FiDownload /></button>}
				{!dir && !virtual && <button type="button" className="file-attach inline" title={t("attachInlineTip")} onClick={() => onAttach(entry.path, entry.name, "inline")}><FiPlus /></button>}
				{!virtual && <button type="button" className="file-attach ref" title={t(dir ? "linkFolderTip" : "referenceTip")} onClick={() => onAttach(entry.path, entry.name, "reference", dir)}><FiLink /></button>}
			</div>
			{dir && open && <div role="group">{directories[entry.path] || virtual ? renderDirectory(entry.path, depth + 1) : <div className="tree-loading">{t("loading")}</div>}</div>}
		</div>;
	};
	const renderDirectory = (path: string, depth: number): React.ReactNode => <>
		{directories[path]?.error ? <div className="tree-directory-error" role="status" title={directories[path].error?.message}>
			<span>{t(directories[path].error?.code === "missing" ? "directoryMissing" : directories[path].error?.code === "denied" ? "directoryDenied" : directories[path].error?.code === "not_directory" ? "directoryNotFolder" : "directoryUnavailable")}</span>
			{!path && <span>{t("directoryChooseProject")}</span>}
			<button type="button" onClick={() => request(path)}>{t("refreshWorkspaceFiles")}</button>
		</div> : directoryEntries(path).map(({ entry, virtual }) => renderEntry(entry, depth, virtual))}
		{directories[path]?.truncated && <div className="panel-empty files-truncated">{t("filesTruncated")}</div>}
	</>;
	const otherDirectories = directoryEntries("").filter(({ entry }) => entry.type === "dir" && !changed.some((change) => change.path === entry.path || change.path.startsWith(`${entry.path}/`)) && (showHidden || !entry.name.startsWith("."))).length;
	return <aside className="panel panel-right has-task-progress">
		<div className="panel-title"><span>{t("workspaceFiles")}</span>{!notRepo && changed.length > 0 && <button type="button" className="tree-filter" aria-pressed={onlyChanged} onClick={() => setOnlyChanged(value => !value)}>{t("changedCount", { n: changed.length })}</button>}<button type="button" className="tree-menu-trigger" aria-label={t("newWorkspaceFile")} title={t("newWorkspaceFile")} disabled={isStreaming || !cwd} onClick={() => setCreating(value => !value)}><FiPlus /></button><button type="button" className="tree-menu-trigger" aria-label={t("refreshWorkspaceFiles")} title={t("refreshWorkspaceFiles")} onClick={refreshFiles}><FiRefreshCw /></button><div className="tree-controls" ref={controlsRef}><button type="button" className="tree-menu-trigger" aria-label={t("more")} aria-expanded={controlsOpen} onClick={() => setControlsOpen(value => !value)}><FiMoreHorizontal /></button>{controlsOpen && <div className="tree-controls-menu"><button type="button" className="tree-hidden-toggle" role="switch" aria-checked={showHidden} onClick={() => setShowHidden(value => !value)}><span>{t("showHiddenFiles")}</span><span className="tree-switch-track" /></button></div>}</div></div>
		{creating && <CreateFileForm key={`${cwd}:${conversationId}`} cwd={cwd} conversationId={conversationId} disabled={isStreaming} onCancel={() => setCreating(false)} onCreated={path => { setCreating(false); refreshFiles(); onPreview(path, path.split("/").at(-1)!); }} />}
		<div className="panel-body" role="tree" aria-label={t("workspaceFiles")} onKeyDown={(event) => {
			const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-tree-node]");
			if (!button) return;
			const path = button.dataset.treeNode!;
			const isDirectory = button.classList.contains("file-dir-main");
			if (event.key === "ArrowRight" && isDirectory && !expanded.has(path)) { event.preventDefault(); toggle(path); }
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				if (isDirectory && expanded.has(path)) toggle(path);
				else {
					const parent = path.slice(0, path.lastIndexOf("/"));
					Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-tree-node]")).find((node) => node.dataset.treeNode === parent)?.focus();
				}
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-tree-node]"));
				nodes[nodes.indexOf(button) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
			}
		}}>
			{onlyChanged && changed.length === 0 ? <div className="panel-empty">{t("noChangedFiles")}</div> : directories[""] ? renderDirectory("", 0) : <div className="panel-empty">{t("loading")}</div>}
			{compactTree && !onlyChanged && otherDirectories > 0 && <button type="button" className="tree-other-directories" onClick={() => setShowOtherDirectories(true)}>{t("otherDirectories", { n: otherDirectories })}</button>}
		</div>
		<div className="panel-lower"><TaskProgressPanel key={conversationId} task={taskProgress} streaming={isStreaming} live={streamingMessage} silence={agentSilence ?? null} cwd={cwd} messages={messages} onPreview={onPreview} /></div>
			{widgets.filter((w) => w.lines.length > 0).length > 0 && (
				<div className="panel-widgets">
					{widgets
						.filter((w) => w.lines.length > 0)
						.map((w) => (
							<div key={w.key} className="widget">
								<button
									type="button"
									className="widget-title widget-title-btn"
									title={t("widgetExpand")}
									onClick={() => setExpandedWidget(w.key)}
								>
									<span>{w.key}</span>
									<FiMaximize2 />
								</button>
								<pre className="widget-lines">{w.lines.join("\n")}</pre>
							</div>
						))}
				</div>
			)}
			{expandedWidget &&
				(() => {
					const w = widgets.find((x) => x.key === expandedWidget);
					if (!w) return null;
					return (
						<div className="modal-backdrop" onClick={() => setExpandedWidget(null)}>
							<div className="widget-expand" onClick={(e) => e.stopPropagation()}>
								<div className="widget-expand-head">
									<span className="widget-expand-title">{w.key}</span>
									<button
										type="button"
										className="btn"
										title={t("close")}
										onClick={() => setExpandedWidget(null)}
									>
										<FiX />
									</button>
								</div>
								<pre className="widget-expand-lines">{w.lines.join("\n")}</pre>
							</div>
						</div>
					);
				})()}
	</aside>;
});
