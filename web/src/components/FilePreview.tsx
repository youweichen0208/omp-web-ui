import { UiIcon } from "./UiIcon";
import type { CurrentFileContext, ReadCurrentFile, SaveCurrentFile } from "../current-file";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject } from "react";
import {
	FiCheck,
	FiSave,
	FiMoreHorizontal,
	FiZoomIn,
	FiZoomOut,
} from "react-icons/fi";
import type { ClientMessage, FileContent, ServerMessage } from "../types";
import { SqlitePreview } from "./SqlitePreview";
import { CodeFileEditor } from "./CodeFileEditor";
import { RichMarkdownEditor } from "./RichMarkdownEditor";
import { Markdown } from "./Markdown";
import { highlightLines, langFromPath } from "../hljs-lite";
import { useT } from "../i18n";
import { getClientId } from "../use-chat";
import { randomUuid } from "../uuid";
import { markdownImageUrl } from "../markdown-image";
import { downloadFile } from "../download";
import { withToken } from "../auth-token";
import { CODE_THEME_EVENT, getCodeTheme } from "../code-appearance";
import { fileDiffMarkers } from "../file-diff-markers";

/** Cap rendered lines so a pathological file can't freeze the panel. */
const MAX_PREVIEW_LINES = 5000;
let filePreviewScmRequestId = -5000;

export interface PreviewFile {
	path: string;
	name: string;
	cwd: string;
}

export type FileNavigationGuard = (action: () => void) => void;

interface FilePreviewProps {
	contextReader?: MutableRefObject<ReadCurrentFile | null>;
	/** 发送即保存：提交携带当前文件的消息前，把未保存草稿落盘。 */
	contextSaver?: MutableRefObject<SaveCurrentFile | null>;
	onContextChange?: (context: CurrentFileContext | null) => void;
	result: Extract<ServerMessage, { type: "file_result" }> | null;
	guard: MutableRefObject<FileNavigationGuard | null>;
	disabled: boolean;
	connected: boolean;
	file: PreviewFile;
	/** Latest server content, matched by workspace, path and request id. */
	content: FileContent | null;
	send: (msg: ClientMessage) => boolean;
	/** Add the selected line range as a "lines" attachment to the chat input. */
	onAddLines: (path: string, name: string, start: number, end: number) => void;
	/** Attach the whole file (inline content / path reference) like the row buttons. */
	onAttach: (path: string, name: string, mode: "inline" | "reference") => void;
	onClose: () => void;
	fileChanged?: { path: string } | null;
	scmData?: Extract<ServerMessage, { type: "scm_data" }> | null;
	scmDirty?: number;
}

/** 1-based inclusive line range. */
interface Range {
	start: number;
	end: number;
}

export const FilePreviewContent = memo(function FilePreviewContent({
	result, guard, disabled, connected, contextReader, contextSaver, onContextChange,
	file,
	content,
	send,
	onAddLines,
	onAttach,
	onClose,
	fileChanged,
	scmData,
	scmDirty,
}: FilePreviewProps) {
	const t = useT();
	const [loaded, setLoaded] = useState<FileContent | null>(null);
	// Live mirror of `loaded` (kept in sync at every setLoaded site): read at
	// submit time from callbacks that run BEFORE React commits the new state —
	// e.g. save-on-send's `next()` fires inside the write-result effect, while
	// the reader closure still holds the previous render's `loaded`.
	const loadedRef = useRef<FileContent | null>(null);
	const [loading, setLoading] = useState(false);
	const [sel, setSel] = useState<Range | null>(null);
	const [dragging, setDragging] = useState(false);
	const [added, setAdded] = useState(false);
	// Editable files retain their visual formatting while accepting input.
	const [editing, setEditing] = useState(true);
	const [draft, updateDraft] = useState("");
	const draftRef = useRef("");
	const setDraft = (value: string) => { draftRef.current = value; updateDraft(value); };
	// Identity of this open instance — the current-file chip + snapshot read
	// key off it, so a reopen gets a fresh id and the chip follows along.
	const openId = useRef(randomUuid());
	// Markdown preview renders the current draft.
	const [markdownPreview, setMarkdownPreview] = useState(true);
	const [diffMode, setDiffMode] = useState<"git" | "external" | null>(null);
	const [gitChanged, setGitChanged] = useState(false);
	const [gitDiff, setGitDiff] = useState("");
	const [gitUntracked, setGitUntracked] = useState(false);
	const [diffLoading, setDiffLoading] = useState(false);
	const [externalChanged, setExternalChanged] = useState(false);
	const [remoteText, setRemoteText] = useState<string | null>(null);
	const [savedAt, setSavedAt] = useState(() => new Date());
	const [selectionAnchor, setSelectionAnchor] = useState<{ x: number; y: number } | null>(null);
	// Code lines scroll horizontally unless the user enables wrapping.
	const [wrap, setWrap] = useState(false);
	const [codeTheme, setCodeThemeState] = useState(getCodeTheme);
	useEffect(() => {
		const sync = () => setCodeThemeState(getCodeTheme());
		window.addEventListener(CODE_THEME_EVENT, sync);
		return () => window.removeEventListener(CODE_THEME_EVENT, sync);
	}, []);
	// Zoom scales code/editor/hex and the rendered Markdown.
	const [zoom, setZoom] = useState(100);
	const anchorRef = useRef(0);
	const draggingRef = useRef(false);
	const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const readId = useRef("");
	const compareReadId = useRef("");
	const statusReqId = useRef(0);
	const diffReqId = useRef(0);
	const pending = useRef<{ id: string; text: string; next?: () => void } | null>(null);
	const [status, setStatus] = useState<"saved" | "saving" | "failed">("saved");
	const [error, setError] = useState("");
	const [conflict, setConflict] = useState(false);
	const [leave, setLeave] = useState<{ action: () => void } | null>(null);
	const dirty = loaded !== null && draft !== loaded.text;

	const requestContent = () => {
		if (disabled) return;
		readId.current = randomUuid();
		setLoading(true);
		setError("");
		if (!send({ type: "read_file", path: file.path, cwd: file.cwd, requestId: readId.current })) {
			setLoading(false);
			setError(t("fileOffline"));
		}
	};
	useEffect(() => { requestContent(); }, [file.path, file.cwd]);

	useEffect(() => {
		if (content?.requestId !== readId.current || content?.cwd !== file.cwd || content?.path !== file.path) return;
		readId.current = "";
		loadedRef.current = content;
		setLoaded(content);
		setSel(null);
		setDraft(content.text);
		setEditing(content.kind === "text" && !content.binary && !content.truncated);
		setMarkdownPreview(true);
		setLoading(false);
		setConflict(false);
		setStatus("saved");
		setSavedAt(new Date());
		setExternalChanged(false);
		setRemoteText(null);
		setDiffMode(null);
	}, [content, file.path, file.cwd]);

	useEffect(() => {
		if (!content || content.requestId !== compareReadId.current || content.path !== file.path || content.cwd !== file.cwd) return;
		compareReadId.current = "";
		if (loaded && content.version !== loaded.version) {
			if (dirty) {
				setRemoteText(content.text);
				setExternalChanged(true);
			} else {
				// 改动回流（干净分支）：编辑器无未保存修改时自动重载为磁盘新版。
				loadedRef.current = content;
				setLoaded(content);
				setDraft(content.text);
			}
		}
	}, [content, loaded, dirty, file.path, file.cwd]);
	useEffect(() => {
		// 磁盘变化时对比读取：草稿干净则自动重载（改动回流），有未保存修改
		// 则走外部修改横幅，保留用户草稿由其二选一。
		if (!fileChanged || !loaded || pending.current || disabled) return;
		compareReadId.current = randomUuid();
		send({ type: "read_file", path: file.path, cwd: file.cwd, requestId: compareReadId.current });
	}, [fileChanged, file.path, file.cwd, loaded, dirty, disabled, send]);
	useEffect(() => {
		if (disabled || !connected) return;
		statusReqId.current = --filePreviewScmRequestId;
		send({ type: "scm_status", reqId: statusReqId.current });
	}, [file.path, file.cwd, scmDirty, fileChanged, disabled, connected, send]);
	useEffect(() => {
		if (scmData?.cwd !== file.cwd) return;
		if (scmData.kind === "status" && scmData.reqId === statusReqId.current) {
			const changed = !!scmData.ok && !!scmData.files?.some((entry) => entry.path.replaceAll("\\", "/") === file.path);
			setGitChanged(changed);
			if (!changed) { setGitDiff(""); setGitUntracked(false); }
		} else if (scmData.kind === "filediff" && scmData.reqId === diffReqId.current) {
			setDiffLoading(false);
			setGitUntracked(!!scmData.ok && !!scmData.untracked && scmData.untrackedKind === "text");
			setGitDiff(scmData.ok ? [scmData.stagedText, scmData.worktreeText, scmData.untrackedText].filter(Boolean).join("\n") : scmData.error ?? "");
		}
	}, [scmData, file.cwd, file.path]);
	useEffect(() => {
		if (!gitChanged || disabled || !connected || !loaded || loaded.kind !== "text") return;
		diffReqId.current = --filePreviewScmRequestId;
		send({ type: "scm_filediff", reqId: diffReqId.current, path: file.path });
	}, [gitChanged, scmDirty, fileChanged, loaded?.version, disabled, connected, file.path, send]);
	const diffMarkers = useMemo(() => gitUntracked
		? new Map((loaded?.text.split("\n") ?? []).map((_, index) => [index + 1, "added" as const]))
		: fileDiffMarkers(gitDiff), [gitDiff, gitUntracked, loaded?.text]);

	useEffect(() => {
		if (!result || result.cwd !== file.cwd || result.path !== file.path) return;
		if (result.operation === "read" && result.requestId === readId.current) {
			readId.current = "";
			setLoading(false);
			setError(result.error ?? t("fileSaveFailed"));
		}
		if (result.operation !== "write" || result.requestId !== pending.current?.id) return;
		const saved = pending.current;
		if (!saved) return;
		pending.current = null;
		if (result.ok) {
			const previous = loadedRef.current;
			if (previous) {
				const updated = {
					...previous,
					text: saved.text,
					version: result.version,
					size: new TextEncoder().encode(saved.text).length,
					lines: saved.text ? saved.text.split("\n").length - (saved.text.endsWith("\n") ? 1 : 0) : 0,
				};
				loadedRef.current = updated;
				setLoaded(updated);
			}
			setStatus("saved");
			setSavedAt(new Date());
			setSel(null);
			setConflict(false);
			setError("");
			saved.next?.();
		} else {
			setStatus("failed");
			setConflict(!!result.conflict);
			setError(result.error ?? t("fileSaveFailed"));
		}
	}, [result, file.cwd, file.path, t]);

	useEffect(() => {
		if (!loading) return;
		const fail = () => { readId.current = ""; setLoading(false); setError(t("fileOffline")); };
		if (!connected) { fail(); return; }
		const timer = setTimeout(fail, 15000);
		return () => clearTimeout(timer);
	}, [loading, connected, t]);

	useEffect(() => {
		if (status !== "saving") return;
		const fail = () => {
			pending.current = null;
			setStatus("failed");
			setError(t("fileOffline"));
		};
		if (!connected) { fail(); return; }
		const timer = setTimeout(fail, 15000);
		return () => clearTimeout(timer);
	}, [status, connected, t]);

	useLayoutEffect(() => {
		guard.current = (action) => {
			if (pending.current) return;
			if (dirty) setLeave({ action });
			else action();
		};
		return () => { guard.current = null; };
	}, [dirty, guard]);
	useEffect(() => {
		if (!dirty) return;
		const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", prevent);
		return () => window.removeEventListener("beforeunload", prevent);
	}, [dirty]);

	// 当前文件上下文（0.50.0 语义）：预览打开且可编辑时向 App 上报自己，
	// 并注册快照读取器 — 发送时取的是编辑器草稿（含未保存修改），不是磁盘。
	const eligible = !!loaded && loaded.kind === "text" && !loaded.binary && !loaded.truncated && !loading && !disabled;
	useLayoutEffect(() => {
		if (!contextReader) return;
		contextReader.current = (id) => eligible && loaded && id === openId.current ? {
			path: file.path, mode: "inline",
			editorSnapshot: {
				cwd: file.cwd,
				text: draftRef.current,
				dirty: draftRef.current !== loadedRef.current?.text,
				version: loadedRef.current?.version,
			},
		} : null;
		return () => { contextReader.current = null; };
	}, [contextReader, eligible, loaded, file.path, file.cwd]);
	useLayoutEffect(() => {
		onContextChange?.(eligible ? { ...file, id: openId.current, dirty } : null);
	}, [eligible, dirty, file, onContextChange]);
	useLayoutEffect(() => () => onContextChange?.(null), [onContextChange]);
	// 发送即保存：草稿干净就直接续走；脏则先落盘（乐观并发，冲突走现有
	// 冲突 UI 且不回调 next —— 发送被挡住）；保存中/离线等无法启动时返回 false。
	useLayoutEffect(() => {
		if (!contextSaver) return;
		contextSaver.current = (id, next) => {
			const current = loadedRef.current;
			if (!eligible || !current || id !== openId.current) return false;
			if (draftRef.current === current.text) {
				next();
				return true;
			}
			if (loading || disabled || pending.current) return false;
			saveEditing(false, next);
			return true;
		};
		return () => { contextSaver.current = null; };
	}, [contextSaver, eligible, loading, disabled, draft, file.path, file.cwd]);

	// End drag selection on mouseup anywhere.
	useEffect(() => {
		const up = () => {
			draggingRef.current = false;
			setDragging(false);
		};
		window.addEventListener("mouseup", up);
		return () => {
			window.removeEventListener("mouseup", up);
			if (addedTimer.current) clearTimeout(addedTimer.current);
		};
	}, []);

	const lines = useMemo(() => {
		if (!loaded) return [];
		const parts = loaded.text.split("\n");
		// Trailing newline → empty phantom line; drop it so line numbers match
		// what the server counts.
		if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
		return parts.slice(0, MAX_PREVIEW_LINES);
	}, [loaded]);

	// Syntax colors for the plain-text view. Highlighting the file in one
	// pass (rather than per line) keeps block comments and multi-line strings
	// colored across every line they span — see highlightLines(). Memoized
	// because this runs over up to MAX_PREVIEW_LINES lines and the panel
	// re-renders on every line-selection drag.
	const codeHtml = useMemo(() => {
		const lang = langFromPath(file.name);
		if (!lang || lines.length === 0) return null;
		return highlightLines(lines.join("\n"), lang);
	}, [lines, file.name]);

	const lineCount = loaded?.lines ?? 0;
	const truncatedLines = lineCount > MAX_PREVIEW_LINES;

	const selectLine = (line: number, extend: boolean) => {
		if (extend) {
			const anchor = anchorRef.current > 0 ? anchorRef.current : line;
			setSel({
				start: Math.min(anchor, line),
				end: Math.max(anchor, line),
			});
		} else {
			anchorRef.current = line;
			setSel({ start: line, end: line });
		}
	};

	const selectAll = () => {
		if (lines.length === 0) return;
		anchorRef.current = 1;
		setSel({ start: 1, end: lines.length });
	};

	const addToChat = () => {
		if (!sel) return;
		onAddLines(file.path, file.name, sel.start, sel.end);
		setAdded(true);
		if (addedTimer.current) clearTimeout(addedTimer.current);
		addedTimer.current = setTimeout(() => setAdded(false), 1400);
	};
	const requestGitDiff = () => {
		if (!gitChanged || disabled) return;
		setDiffMode("git");
		setDiffLoading(true);
		diffReqId.current = --filePreviewScmRequestId;
		if (!send({ type: "scm_filediff", reqId: diffReqId.current, path: file.path })) setDiffLoading(false);
	};
	const captureMarkdownSelection = (target: EventTarget, root: HTMLElement) => {
		if (!(target instanceof Element) || !target.closest(".fp-markdown")) return;
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || !selection.anchorNode || !root.contains(selection.anchorNode)) return;
		const sourceRange = (node: Node | null) => {
			const element = node instanceof Element ? node : node?.parentElement;
			const block = element?.closest<HTMLElement>("[data-source-start]");
			const start = Number(block?.dataset.sourceStart);
			const end = Number(block?.dataset.sourceEnd);
			return start > 0 && end >= start ? { start, end } : null;
		};
		const first = sourceRange(selection.anchorNode);
		const last = sourceRange(selection.focusNode);
		const range = first && last ? { start: Math.min(first.start, last.start), end: Math.max(first.end, last.end) } : findSelectedLineRange(draft, selection.toString());
		if (!range) return;
		setSel(range);
		const rect = selection.getRangeAt(0).getBoundingClientRect();
		const panel = root.getBoundingClientRect();
		setSelectionAnchor({ x: Math.max(12, Math.min(panel.width - 260, rect.left - panel.left)), y: Math.max(54, Math.min(panel.height - 42, rect.bottom - panel.top + 8)) });
	};

	const canEdit =
		loaded !== null && loaded.kind === "text" && !loaded.binary && !loaded.truncated;

	const toggleEditing = () => {
		if (!canEdit) return;
		setEditing((value) => !value);
		setSel(null);
	};

	const saveEditing = (force = false, next?: () => void) => {
		if (!loaded || !canEdit || loading || disabled || pending.current) return;
		const id = randomUuid();
		pending.current = { id, text: draft, next };
		setStatus("saving");
		setError("");
		if (!send({ type: "write_file", path: file.path, cwd: file.cwd, text: draft, requestId: id, expectedVersion: loaded.version, force })) {
			pending.current = null;
			setStatus("failed");
			setError(t("fileOffline"));
		}
	};

	const handleClose = () => guard.current?.(onClose);

	const setZoomLevel = (next: number) => {
		setZoom(Math.min(200, Math.max(50, next)));
	};

	const selCount = sel ? sel.end - sel.start + 1 : 0;
	const isBinary = loaded?.binary ?? false;
	const truncated = loaded?.truncated ?? false;
	// Preview category from the server ("text" while loading). Media kinds are
	// streamed over the /api/file HTTP endpoint; "none" is never previewable.
	const kind = loaded?.kind ?? "text";
	const isMarkdown = isMarkdownFile(file.name);
	const showMarkdown =
		isMarkdown && markdownPreview && kind === "text" && !isBinary;
	// /api/file resolves against the requesting client's workspace (the opened
	// project), not the server's startup cwd — pass clientId so they can differ.
	const mediaUrl = (p: string) =>
		withToken(
			`/api/file?clientId=${encodeURIComponent(getClientId())}&path=${encodeURIComponent(p)}`,
		);

	return (
		<div
			className="fp-embedded"
			data-code-theme={codeTheme}
			onKeyDown={(event) => {
				if (!event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
					event.preventDefault();
					event.stopPropagation();
					saveEditing();
				}
			}}
		>
			<div
				className={`fp ${diffMode ? "show-diff" : ""}`}
				style={{ "--fp-zoom": zoom / 100 } as CSSProperties}
				onMouseUp={(event) => captureMarkdownSelection(event.target, event.currentTarget)}
			>

				<div className="fp-title-row">
					<button className="fp-back" aria-label={t("backToFiles")} title={t("backToFiles")} onClick={handleClose} disabled={status === "saving"}>←</button>
					<span className="fp-file-path" title={`${file.cwd}/${file.path}`}><span className="fp-project-name">{file.cwd.split(/[\\/]/).filter(Boolean).at(-1)}</span><span className="fp-path-separator"> / </span>{file.path.split(/[\\/]/).join(" / ")}</span>
					{canEdit && <span className="fp-header-status" role="status">{status === "saving" ? t("fileSaving") : status === "failed" ? t("fileSaveFailed") : dirty ? t("fileUnsaved") : loaded ? t("fileSaved") : ""}{loaded && !dirty && status === "saved" && <time> · {savedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>}</span>}
					<div className="fp-header-actions">
						{isMarkdown && kind === "text" && <div className="fp-view-switch" role="group" aria-label={t("fileViewMode")}><button type="button" aria-pressed={!diffMode && markdownPreview} onClick={() => { setDiffMode(null); setMarkdownPreview(true); setEditing(true); setSel(null); }}>{t("fileViewPreview")}</button><button type="button" aria-pressed={!diffMode && !markdownPreview} disabled={!canEdit} onClick={() => { setDiffMode(null); setMarkdownPreview(false); setEditing(true); setSel(null); }}>{t("fileViewSource")}</button></div>}
						{!isMarkdown && canEdit && <div className="fp-view-switch" role="group" aria-label={t("fileEditMode")}><button type="button" aria-pressed={!editing} onClick={() => { setDiffMode(null); setEditing(false); }}>{t("fileReadOnly")}</button><button type="button" aria-pressed={editing} onClick={() => { setDiffMode(null); setEditing(true); }}>{t("fileEditShort")}</button></div>}
						{gitChanged && <button type="button" className="fp-header-action" aria-pressed={diffMode === "git"} onClick={() => diffMode === "git" ? setDiffMode(null) : requestGitDiff()}>{t("fileChangesCount", { n: 1 })}</button>}
						<button type="button" className="fp-header-action fp-reference" disabled={disabled} onClick={() => onAttach(file.path, file.name, "reference")}>@{t("fileReference")}</button>
						<details className="fp-more"><summary aria-label={t("fileMoreActions")}><FiMoreHorizontal /></summary><div className="fp-more-actions" onClick={(event) => { if (event.target instanceof Element && event.target.closest("button")) event.currentTarget.closest("details")?.removeAttribute("open"); }}>
							<button className="btn" disabled={disabled} onClick={() => { void downloadFile(file.path, file.name).then((r) => { if (!r.ok && !r.cancelled) setError(r.error); }); }}>{t("downloadFile")}</button>
							{isMarkdown && canEdit && <button className="btn" onClick={() => { setDiffMode(null); setMarkdownPreview(true); setEditing(true); }}>{t("editFile")}</button>}
							{!isMarkdown && canEdit && <button className="btn" onClick={toggleEditing}>{editing ? t("exitEditFile") : t("editFile")}</button>}
							{kind === "text" && <button className="btn" onClick={() => setWrap((value) => !value)}>{wrap ? t("disableWrap") : t("enableWrap")}</button>}
							{kind === "text" && <button className="btn" onClick={() => setZoomLevel(zoom - 10)} disabled={zoom <= 50}><FiZoomOut /> {t("zoomOut")}</button>}
							{kind === "text" && <button className="btn" onClick={() => setZoomLevel(zoom + 10)} disabled={zoom >= 200}><FiZoomIn /> {t("zoomIn")}</button>}
							{kind !== "video" && kind !== "none" && kind !== "sqlite" && <button className="btn" onClick={() => onAttach(file.path, file.name, "inline")}>{t("attachInlineTip")}</button>}
						</div></details>
						{canEdit && dirty && status !== "saving" && <button className="btn primary fp-header-save" disabled={disabled} onClick={() => saveEditing()}><FiSave /> {t("saveFile")}</button>}
					</div>
				</div>
				{externalChanged && dirty && <div className="fp-external-banner" role="alert">{t("fileExternalChanged")}<button type="button" onClick={() => guard.current?.(requestContent)}>{t("fileReload")}</button><button type="button" disabled={remoteText === null} onClick={() => setDiffMode("external")}>{t("fileCompare")}</button></div>}
				{truncated && kind === "text" && !isBinary && (
					<div className="fp-notice"><UiIcon name="warning" /> {t("previewTruncated")}</div>
				)}

				{error && <div className="fp-notice" role="alert">{error}
					<button className="btn" disabled={disabled || status === "saving"} onClick={() => guard.current?.(requestContent)}>{t("fileReload")}</button>
					{conflict && <button className="btn" disabled={disabled} onClick={() => { if (window.confirm(t("fileOverwriteConfirm"))) saveEditing(true); }}>{t("fileOverwrite")}</button>}
				</div>}
				{leave && <div className="fp-leave" role="alertdialog" aria-label={t("fileUnsaved")}>
					<p>{t("fileLeavePrompt")}</p>
					<button className="btn primary" disabled={disabled} onClick={() => { const next = leave.action; setLeave(null); saveEditing(false, next); }}>{t("fileSaveContinue")}</button>
					<button className="btn" onClick={() => { const next = leave.action; setLeave(null); next(); }}>{t("fileDiscard")}</button>
					<button className="btn" onClick={() => setLeave(null)}>{t("cancel")}</button>
				</div>}
				{loading && !loaded && <div className="fp-empty">{t("loading")}</div>}

				{!loading && kind === "none" && !isBinary && (
					<div className="fp-empty">{t("previewNotSupported")}</div>
				)}

				{!loading && kind === "sqlite" && <SqlitePreview file={file} disabled={disabled || !connected} />}

				{!loading && kind === "image" && (
					<div className="fp-media-wrap">
						<img
							className="fp-media"
							src={mediaUrl(file.path)}
							alt={file.name}
						/>
					</div>
				)}

				{!loading && kind === "video" && (
					<div className="fp-media-wrap">
						<video
							className="fp-media"
							src={mediaUrl(file.path)}
							controls
							preload="metadata"
						/>
					</div>
				)}

				{!loading && showMarkdown && loaded && (editing && canEdit ?
					<RichMarkdownEditor file={file} value={draft} readOnly={disabled || status === "saving"} onChange={setDraft} /> : (
					<div className="fp-markdown msg-text">
						<div className="fp-markdown-zoom">
						<Markdown text={canEdit ? draft : loaded.text} imageSrc={(source) => markdownImageUrl(source, file)} sourceLines />
						</div>
					</div>
				))}

				{!loading &&
					isBinary &&
					kind !== "image" &&
					kind !== "sqlite" &&
					kind !== "video" &&
					loaded && (
						<div className="fp-hex-wrap">
							<div className="fp-notice">
								{t("binaryFile")}
								{loaded.truncated && t("binaryHexTruncated")}
							</div>
							<pre className="fp-hex">{loaded.text}</pre>
						</div>
					)}

				{!loading && editing && !showMarkdown && kind === "text" && !isBinary && loaded && (
					<CodeFileEditor
						name={file.name}
						value={draft}
						readOnly={disabled || status === "saving"}
						onChange={setDraft}
						onSelectLines={(start, end) => { setSel({ start, end }); setSelectionAnchor(null); }}
						wrap={wrap}
						markers={dirty ? undefined : diffMarkers}
					/>
				)}

				{!loading &&
					!showMarkdown &&
					!editing &&
					kind === "text" &&
					!isBinary &&
					loaded &&
					lines.length === 0 && (
						<div className="fp-empty">{t("emptyFile")}</div>
					)}

				{!loading &&
					!showMarkdown &&
					!editing &&
					kind === "text" &&
					!isBinary &&
					lines.length > 0 && (
					<div
						className={`fp-code ${dragging ? "dragging" : ""} ${
							wrap ? "" : "no-wrap"
						}`}
						onMouseDown={(e) => {
							// Block native text selection so click/drag maps to line ranges.
							if (e.button === 0) e.preventDefault();
						}}
					>
						{lines.map((text, i) => {
							const n = i + 1;
							const active = sel !== null && n >= sel.start && n <= sel.end;
							return (
								<div
									key={n}
									data-line={n}
									className={`fp-line ${active ? "sel" : ""}`}
									onMouseDown={(e) => {
										if (e.button !== 0) return;
										selectLine(n, e.shiftKey);
										draggingRef.current = true;
										setDragging(true);
									}}
									onMouseEnter={() => {
										if (draggingRef.current) selectLine(n, true);
									}}
								>
									<span className={`fp-num ${dirty ? "" : diffMarkers.get(n) ?? ""}`}>{n}</span>
									{codeHtml ? (
										<span
											className="fp-code-text hljs"
											// biome-ignore lint: highlightLines only ever returns
											// hljs's own escaped/span-wrapped output, never raw input.
											dangerouslySetInnerHTML={{
												__html: codeHtml[i] || "\u200b",
											}}
										/>
									) : (
										<span className="fp-code-text">{text}</span>
									)}
								</div>
							);
						})}
						{truncatedLines && (
							<div className="fp-lines-note">
								{t("previewLinesTruncated", { n: MAX_PREVIEW_LINES })}
							</div>
						)}
					</div>
				)}
				{sel && !diffMode && <button type="button" className={`fp-quote-selection${selectionAnchor ? " at-selection" : ""}`} style={selectionAnchor ? { left: selectionAnchor.x, top: selectionAnchor.y } : undefined} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={addToChat}>{added ? <FiCheck /> : null}{added ? t("addedToChat") : t("quoteSelection", { name: file.name, start: sel.start, end: sel.end })}</button>}
				{diffMode === "git" && <div className="fp-diff-view" role="region" aria-label={t("fileViewChanges")}>{diffLoading ? <span className="fp-empty">{t("loading")}</span> : gitDiff ? <pre>{gitDiff.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : ""}>{line}{"\n"}</span>)}</pre> : <div className="fp-empty">{t("fileNoChanges")}</div>}</div>}
				{diffMode === "external" && <div className="fp-diff-view fp-external-comparison" role="region" aria-label={t("fileCompare")}><section><h3>{t("fileLocalDraft")}</h3><pre>{draft}</pre></section><section><h3>{t("fileDiskVersion")}</h3><pre>{remoteText}</pre></section></div>}

			</div>
		</div>
	);
});

/** Optional modal shell for consumers outside the sidebar. */
export function FilePreview(props: FilePreviewProps) {
	return <div className="fp-overlay"><FilePreviewContent {...props} /></div>;
}

function isMarkdownFile(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** Match a browser text selection to its source lines without guessing if the
 * rendered text differs from the Markdown source (e.g. bold markup). */
export function findSelectedLineRange(source: string, selected: string): Range | null {
	const text = selected.trim();
	if (!text) return null;
	let start = source.indexOf(text);
	let end = start + text.length;
	if (start < 0) {
		let normalized = "";
		const offsets: number[] = [];
		for (let i = 0; i < source.length; i++) {
			const char = source[i];
			if (/\s/.test(char)) {
				if (normalized.endsWith(" ")) continue;
				normalized += " ";
			} else normalized += char;
			offsets.push(i);
		}
		const needle = text.replace(/\s+/g, " ");
		const at = normalized.indexOf(needle);
		if (at < 0) return null;
		start = offsets[at];
		end = offsets[at + needle.length - 1] + 1;
	}
	return { start: source.slice(0, start).split("\n").length, end: source.slice(0, end).split("\n").length };
}
