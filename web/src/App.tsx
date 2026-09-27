import { WorkspacePathContext } from "./workspace-context";
import {
	lazy,
	Suspense,
	useCallback,
	useLayoutEffect,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { TopBar } from "./components/TopBar";
import { desktopAPI } from "./desktop";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { MessageList } from "./components/MessageList";
import { ChatInput } from "./components/ChatInput";
import { AgentSilenceStatus } from "./components/AgentSilenceStatus";
import type { CurrentFileContext, ReadCurrentFile, SaveCurrentFile } from "./current-file";
import { GoalBar } from "./components/GoalBar";
import { FooterBar } from "./components/FooterBar";
import { Dialog } from "./components/Dialog";
// 终端视图懒加载：xterm.js 体积大且只在切到终端时才需要，拆出主包
const TerminalPanel = lazy(() =>
	import("./components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);
const NodeWorkbench = lazy(() => import("./components/NodeWorkbench").then((m) => ({ default: m.NodeWorkbench })));
import { ScmPanel } from "./components/SCMPanel";
import { PluginView } from "./components/PluginView";
import {
	syncPluginViews,
	subscribeLoadedPluginViews,
	type LoadedPluginView,
} from "./plugin-loader";
import { PiSetupModal } from "./components/PiSetupModal";
import { ModelConfigModal } from "./components/ModelConfigModal";

import { SettingsModal } from "./components/SettingsModal";
import { BgTasksModal } from "./components/BgTasksModal";
import { GlobalSearchModal } from "./components/GlobalSearchModal";
import { FilePreviewContent, type FileNavigationGuard, type PreviewFile } from "./components/FilePreview";
import { useChat } from "./use-chat";
import type {
	ClientMessage,
	CommandDef,
	PromptAttachment,
	UiMessage,
} from "./types";
import { useT } from "./i18n";
import { FiAlertCircle, FiAlertTriangle, FiInfo, FiX } from "react-icons/fi";
import type { Notice } from "./use-chat";
import { fileToProcessedImage, isRasterImage, type ProcessedImage } from "./image-paste";
import { randomUuid } from "./uuid";
import { keepNonPreviewAttachments } from "./preview-attachments";
import {
	loadSoundSettings,
	playSound,
	saveSoundSettings,
	type SoundKind,
	type SoundSettings,
} from "./sounds";

export interface PendingAttachment {
	path: string;
	name: string;
	mode: "inline" | "reference" | "lines";
	/** Folder path link (always reference mode). */
	isDir?: boolean;
	/** 1-based inclusive line range (mode "lines" only). */
	lines?: { start: number; end: number };
	/** Raw pasted/dropped/uploaded image (no workspace path — `path` is ""). */
	imageData?: string;
	mimeType?: string;
	/** Raw uploaded file bytes (no workspace path — `path` is ""). */
	fileData?: string;
	size?: number;
	/** Stable dedupe/removal key for pasted images. */
	key?: string;
}


/** A single notice toast. Auto-dismisses after a level-dependent delay, but
 *  hovering PAUSES the timer (stays visible as long as the pointer is over it),
 *  resuming when the pointer leaves. Clicking the toast body does NOT hide it —
 *  only the × button dismisses (and the auto timer). */
function NoticeToast({
	notice,
	onDismiss,
}: {
	notice: Notice;
	onDismiss: (id: number) => void;
}) {
	const t = useT();
	const [paused, setPaused] = useState(false);
	useEffect(() => {
		if (paused || notice.level !== "info") return;
		const t = setTimeout(
			() => onDismiss(notice.id),
			3000,
		);
		return () => clearTimeout(t);
	}, [paused, notice.id, notice.level, onDismiss]);
	const Icon =
		notice.level === "error"
			? FiAlertCircle
			: notice.level === "warning"
				? FiAlertTriangle
				: FiInfo;
	return (
		<div
			className={`notice notice-${notice.level}${paused ? " paused" : ""}`}
			role="status"
			onMouseEnter={() => setPaused(true)}
			onMouseLeave={() => setPaused(false)}
		>
			<Icon className="notice-icon" />
			<span className="notice-text">{notice.text}</span>
			<button
				type="button"
				className="notice-close"
				title={t("close")}
				onClick={() => onDismiss(notice.id)}
			>
				<FiX />
			</button>
		</div>
	);
}
/** Stable empty messages array — keeps the memoized ChatInput prop comparison
 *  cheap before the first snapshot arrives. */
const EMPTY_MESSAGES: UiMessage[] = [];

// ---- 可拖拽面板宽度（桌面端；≤768px 抽屉模式固定宽度不受影响）----
const PANEL_MIN = 180;
const PANEL_MAX = 520;
const PANEL_DEFAULT = 264;
type PanelSide = "left" | "right" | "editor";
const panelWidthKey = (side: PanelSide) => `pi-web-ui:${side}-panel-width`;
function readPanelWidth(side: PanelSide): number {
	const v = Number(localStorage.getItem(panelWidthKey(side)));
	return Number.isFinite(v) && v >= PANEL_MIN && v <= PANEL_MAX ? v : side === "editor" ? 480 : side === "right" ? 272 : PANEL_DEFAULT;
}

/** 面板与主区之间的拖拽分隔条：拖动改宽度，双击复位。 */
function ResizeHandle({
	side,
	width,
	onResize,
	onReset,
}: {
	side: PanelSide;
	width: number;
	onResize: (w: number) => void;
	onReset?: () => void;
}) {
	const t = useT();
	const onPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const startX = e.clientX;
			const startW = side === "editor" ? e.currentTarget.nextElementSibling?.getBoundingClientRect().width ?? width : width;
			const maxWidth = side === "editor" ? Math.max(PANEL_MIN, startW + (e.currentTarget.previousElementSibling?.getBoundingClientRect().width ?? 0) - 180) : PANEL_MAX;
			let last = startW;
			const move = (ev: PointerEvent) => {
				// 左侧手柄向右拖变宽，右侧相反
				const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
				last = Math.min(maxWidth, Math.max(PANEL_MIN, Math.round(startW + delta)));
				onResize(last);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				document.body.classList.remove("panel-resizing");
				localStorage.setItem(panelWidthKey(side), String(last));
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			document.body.classList.add("panel-resizing");
		},
		[side, width, onResize],
	);
	return (
		<div
			className={`resize-handle resize-${side === "editor" ? "right" : side}`}
			title={t("dragToResize")}
			onPointerDown={onPointerDown}
			onDoubleClick={() => {
				if (onReset) { onReset(); return; }
				const value = side === "editor" ? 480 : side === "right" ? 272 : PANEL_DEFAULT;
				onResize(value);
				localStorage.setItem(panelWidthKey(side), String(value));
			}}
		/>
	);
}

/** 顶栏视图：内置三个 + 每个已装插件一个 `plugin:<id>`。 */
type ViewName = "chat" | "terminal" | "git" | "nodes" | `plugin:${string}`;

export function App() {
	const t = useT();
	const { chat, send: rawSend, dismissNotice, pushNotice, setPendingEcho, terminal, switching, switchError } = useChat();
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const attachmentDrafts = useRef(new Map<string, PendingAttachment[]>());
	const attachmentKey = useRef(chat.activeConversationId);
	useLayoutEffect(() => {
		if (attachmentKey.current !== chat.activeConversationId) {
			if (attachments.length) attachmentDrafts.current.set(attachmentKey.current, attachments);
			else attachmentDrafts.current.delete(attachmentKey.current);
			attachmentKey.current = chat.activeConversationId;
			setAttachments(attachmentDrafts.current.get(chat.activeConversationId) ?? []);
			attachmentDrafts.current.delete(chat.activeConversationId);
		}
	}, [chat.activeConversationId, attachments]);
	const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
	const previousPreview = useRef<PreviewFile | null>(null);
	useLayoutEffect(() => {
		const previous = previousPreview.current;
		if (previous && (previous.cwd !== previewFile?.cwd || previous.path !== previewFile?.path)) {
			setAttachments(keepNonPreviewAttachments);
			for (const [id, draft] of attachmentDrafts.current) {
				attachmentDrafts.current.set(id, keepNonPreviewAttachments(draft));
			}
		}
		previousPreview.current = previewFile;
	}, [previewFile]);
	// 当前文件（0.50.0 语义）：预览面板的严格镜像 — chip 跟随打开的文件，
	// 发送时经 contextReader 取编辑器快照（含未保存修改）。
	const contextReader = useRef<ReadCurrentFile | null>(null);
	// 发送即保存：脏草稿先经编辑器落盘，再发送携带快照的消息。
	const contextSaver = useRef<SaveCurrentFile | null>(null);
	const [currentFile, setCurrentFile] = useState<CurrentFileContext | null>(null);
	useEffect(() => {
		if (!switching && chat.state?.cwd && previewFile && previewFile.cwd !== chat.state.cwd) setPreviewFile(null);
	}, [switching, chat.state?.cwd, previewFile]);
	const fileGuard = useRef<FileNavigationGuard | null>(null);
	const send = useCallback((message: ClientMessage) => {
		const navigation = message.type === "set_cwd" || message.type === "switch_session" ||
			(message.type === "prompt" && /^\/cwd(?:\s|$)/.test(message.text));
		if (navigation && fileGuard.current) {
			setView("chat");
			setDrawer("right");
			fileGuard.current(() => { if (rawSend(message) && message.type !== "switch_session") setPreviewFile(null); });
			return false;
		}
		return rawSend(message);
	}, [rawSend]);
	/** Full-window file drag in progress (issue #19) — shows the app-wide
	 *  drop overlay; drop anywhere attaches, the input bar keeps priority via
	 *  its own stopPropagation handlers. */
	const [appDragOver, setAppDragOver] = useState(false);
	const [view, setView] = useState<ViewName>("chat");
	const visited = useRef(new Set<ViewName>(["chat"]));
	visited.current.add(view);
	// 已安装且未在设置面板禁用的插件（决定 tab 与视图加载）。
	const enabledPlugins = useMemo(
		() =>
			chat.plugins.filter(
				(p) => !chat.settings?.disabledPlugins?.includes(p.id),
			),
		[chat.plugins, chat.settings?.disabledPlugins],
	);
	// 已加载的插件视图（bundle 动态 import 完成后出现）。
	const [pluginViews, setPluginViews] = useState<LoadedPluginView[]>([]);
	useEffect(
		() => subscribeLoadedPluginViews(setPluginViews),
		[],
	);
	// 目录清单/禁用集合/epoch 变化 → 同步注册表：新增的拉取、消失的清理
	// （React 卸载对应 PluginView 时调用插件的 cleanup）、服务端 reload 后重拉。
	useEffect(() => {
		void syncPluginViews(enabledPlugins, chat.pluginsEpoch);
	}, [enabledPlugins, chat.pluginsEpoch]);
	// 左右面板可拖拽宽度（桌面端）：localStorage 持久化，双击手柄复位。
	const [leftWidth, setLeftWidth] = useState(() => readPanelWidth("left"));
	const [rightWidth, setRightWidth] = useState(() => readPanelWidth("right"));
	const resizeLeft = useCallback((w: number) => setLeftWidth(w), []);
	const [editorShare, setEditorShare] = useState(() => {
		const stored = Number(localStorage.getItem("pi-web-ui:editor-share"));
		return Number.isFinite(stored) && stored >= 0.15 && stored <= 0.85 ? stored : 0.45;
	});
	const resizeRight = useCallback((w: number) => setRightWidth(w), []);
	const resizeEditor = useCallback((w: number) => {
		const pane = document.querySelector(".view-pane.preview-open:not(.hidden)");
		const main = pane?.querySelector(".main");
		const editor = pane?.querySelector(".drawer-right");
		const available = (main?.getBoundingClientRect().width ?? 0) + (editor?.getBoundingClientRect().width ?? 0);
		if (available > 0) {
			const share = Math.min(0.85, Math.max(0.15, w / available));
			setEditorShare(share);
			localStorage.setItem("pi-web-ui:editor-share", String(share));
		}
	}, []);
	// Mobile: which side panel is open as a drawer (null = both closed).
	const [filesCollapsed, setFilesCollapsed] = useState(false);
	const [goalOpenRequest, setGoalOpenRequest] = useState(0);
	const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
	// Viewport class: ≤768px turns the side panels into sliding drawers
	// (matches the CSS breakpoint) — used to lazy-load panel data only when
	// a drawer is actually open on mobile.
	const [isMobile, setIsMobile] = useState(
		() => window.matchMedia("(max-width: 768px)").matches,
	);
	const [isNarrow, setIsNarrow] = useState(
		() => window.matchMedia("(max-width: 1100px)").matches,
	);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 1100px)");
		const onChange = (e: MediaQueryListEvent) => {
			setIsNarrow(e.matches);
			setDrawer(null);
		};
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 768px)");
		const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	const attach = useCallback((
		path: string,
		name: string,
		mode: "inline" | "reference" | "lines",
		isDir = false,
		lines?: { start: number; end: number },
	) => {
		// Dedupe on path + mode + line range so the same file can be attached
		// multiple ways (e.g. full content AND a line range) without doubling.
		const key = `${path}|${mode}|${lines ? `${lines.start}-${lines.end}` : ""}`;
		setAttachments((prev) =>
			prev.some(
				(a) =>
					`${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}` ===
					key,
			)
				? prev
				: [...prev, { path, name, mode, isDir, ...(lines ? { lines } : {}) }],
		);
	}, []);
	const openPreview = useCallback((path: string, name: string) => {
		if (switching || !chat.state?.cwd) return;
		const cwd = chat.state.cwd;
		// Reveal the editor before asking about its draft, even when search
		// was opened from Git/Terminal or a closed mobile drawer.
		setView("chat");
		setDrawer("right");
		if (previewFile?.cwd === cwd && previewFile.path === path) return;
		const open = () => setPreviewFile({ path, name, cwd });
		if (fileGuard.current) fileGuard.current(open);
		else open();
	}, [switching, chat.state?.cwd, previewFile]);
	useEffect(() => {
		const onToolFile = (event: Event) => {
			const detail = (event as CustomEvent<{ path?: string; line?: number }>).detail;
			const cwd = chat.state?.cwd?.replaceAll("\\", "/").replace(/\/$/, "");
			if (!cwd || typeof detail?.path !== "string") return;
			const path = detail.path.replaceAll("\\", "/");
			const relative = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
			if (relative.startsWith("/") || /^[A-Za-z]:\//.test(relative) || relative.split("/").includes("..")) return;
			openPreview(relative, relative.split("/").at(-1) ?? relative);
			const line = detail.line;
			if (!Number.isInteger(line) || !line || line < 1) return;
			let attempts = 0;
			const reveal = () => {
				const openedPath = document.querySelector<HTMLElement>(".fp-file-path")?.title.replaceAll("\\", "/");
				if (openedPath !== `${cwd}/${relative}`) {
					if (++attempts < 40) window.setTimeout(reveal, 100);
					return;
				}
				const row = document.querySelector<HTMLElement>(`.fp-line[data-line="${line}"], .fp-edit-line[data-line="${line}"], .fp-markdown [data-source-start="${line}"]`) ??
					Array.from(document.querySelectorAll<HTMLElement>(".fp-markdown [data-source-start][data-source-end]")).find((element) =>
						Number(element.dataset.sourceStart) <= line && Number(element.dataset.sourceEnd) >= line);
				if (row) {
					const editor = row.closest(".fp-code-editor")?.querySelector<HTMLTextAreaElement>(".fp-editor");
					if (editor) {
						const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || 22;
						editor.scrollTop = Math.max(0, (line - 1) * lineHeight - editor.clientHeight / 2);
						editor.dispatchEvent(new Event("scroll", { bubbles: true }));
					} else row.scrollIntoView({ block: "center" });
					row.classList.add("from-tool");
					window.setTimeout(() => row.classList.remove("from-tool"), 2000);
				} else if (++attempts < 40) window.setTimeout(reveal, 100);
			};
			window.setTimeout(reveal, 100);
		};
		window.addEventListener("pi-web-ui:open-tool-file", onToolFile);
		return () => window.removeEventListener("pi-web-ui:open-tool-file", onToolFile);
	}, [openPreview, chat.state?.cwd]);
	// Setup modal: one-time prompt when the pi agent config is missing.
	const [setupDismissed, setSetupDismissed] = useState(false);
	// Custom model config panel (model dropdown → 管理模型).
	const [manageModelsOpen, setManageModelsOpen] = useState(false);
	// Settings panel (system prompt / skills / extensions / presets).
	const [settingsOpen, setSettingsOpen] = useState(false);
	// Background-task panel (AI-started servers — stop individually or all).
	const [bgTasksOpen, setBgTasksOpen] = useState(false);
	// Global search panel (sessions / projects / workspace files).
	const [globalSearchOpen, setGlobalSearchOpen] = useState(false);

	// 插件视图桥：插件无 chat 上下文，通过窗口事件请求在可见终端执行命令
	// （与 SCM 面板同款：已有同名 tab 原地重跑，否则新建并自动切到终端视图）。
	useEffect(() => {
		const onPluginRunCommand = (e: Event) => {
			const detail = (e as CustomEvent<{ title?: string; command?: string }>).detail;
			const title = detail?.title || "插件命令";
			const command = detail?.command;
			if (!command || !chat.ready) return;
			const def: CommandDef = { name: title, command, cwd: "${pwd}" };
			const existing = chat.terminals.find((tm) => tm.title === title);
			if (existing) {
				terminal.restart(existing.id);
				send({
					type: "run_command",
					terminalId: existing.id,
					conversationId: existing.conversationId,
					command: def,
					cols: 80,
					rows: 24,
				});
			} else {
				const id = randomUuid();
				terminal.create({
					id,
					conversationId: chat.activeConversationId || chat.state?.conversationId || "",
					title,
					cwd: chat.state?.cwd ?? "",
					cols: 80,
					rows: 24,
					running: true,
					exitCode: null,
					command: def,
				});
			}
			setView("terminal");
		};
		window.addEventListener("pi-web-ui:plugin-run-command", onPluginRunCommand);
		return () => window.removeEventListener("pi-web-ui:plugin-run-command", onPluginRunCommand);
	}, [chat, terminal, send]);

	// Ctrl+K / Cmd+K opens global search (also reachable via the topbar button).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
			e.preventDefault();
			setGlobalSearchOpen((v) => !v);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// -- sound notifications --------------------------------------------------
	const [sound, setSound] = useState<SoundSettings>(loadSoundSettings);
	const prevStreaming = useRef<boolean | null>(null);
	const prevDialogId = useRef<number | null>(null);
	const lastErrorNotice = useRef(0);
	// Remembers a terminal-view click made before the WebSocket is ready.
	const terminalOpenRequested = useRef(false);
	// Previous terminal list — drives the uninstall-finished watcher below.
	const prevTerminalsRef = useRef(chat.terminals);

	useEffect(() => {
		saveSoundSettings(sound);
	}, [sound]);

	// Maintenance watcher: when a `pi remove …` / `pi-web-ui install|uninstall …`
	// command tab transitions running → exited, re-discover extensions/skills
	// (extensions_reload) or re-scan the UI-plugin dir (plugins_reload).
	useEffect(() => {
		const prev = prevTerminalsRef.current;
		prevTerminalsRef.current = chat.terminals;
		for (const tm of chat.terminals) {
			const cmd = tm.command?.command ?? "";
			const before = prev.find((p) => p.id === tm.id);
			if (!before?.running || tm.running) continue;
			if (cmd.startsWith("pi remove ")) {
				send({ type: "extensions_reload" });
			} else if (
				cmd.startsWith("pi-web-ui install ") ||
				cmd.startsWith("pi-web-ui uninstall ")
			) {
				send({ type: "plugins_reload" });
			}
		}
	}, [chat.terminals, send]);

	// Run start / end cues (streaming edge transitions).
	useEffect(() => {
		const streaming = chat.state?.isStreaming ?? false;
		const prev = prevStreaming.current;
		prevStreaming.current = streaming;
		if (prev === null) return; // first observation — don't cue
		if (!prev && streaming) playSound("start", sound);
		else if (prev && !streaming) playSound("done", sound);
	}, [chat.state?.isStreaming, sound]);

	// Questionnaire cue — each new dialog id.
	useEffect(() => {
		const id = chat.dialog?.id ?? null;
		if (id !== null && id !== prevDialogId.current) {
			playSound("question", sound);
		}
		prevDialogId.current = id;
	}, [chat.dialog, sound]);

	// Error cue — new error notices only.
	useEffect(() => {
		const err = [...chat.notices].reverse().find((n) => n.level === "error");
		if (err && err.id !== lastErrorNotice.current) {
			lastErrorNotice.current = err.id;
			playSound("error", sound);
		}
	}, [chat.notices, sound]);

	const closePreview = useCallback(() => setPreviewFile(null), []);
	const attachPreviewLines = useCallback((path: string, name: string, start: number, end: number) => {
		attach(path, name, "lines", false, { start, end });
	}, [attach]);
	const removeAttachment = (pathOrKey: string) =>
		setAttachments((prev) =>
			prev.filter((a) => (a.key ? a.key !== pathOrKey : a.path !== pathOrKey)),
		);

	// Side panels live in mobile drawers — any action inside them (session
	// switch, cwd change, file list…) should close the drawer. Stable wrapper
	// so RightPanel's polling effect doesn't churn (send is stable).
	const panelSend = useCallback(
		(msg: ClientMessage) => {
			// Only close the mobile drawer on an explicit navigation/action. Mounting
			// LeftPanel fires read-only list_* probes that must NOT collapse the
			// freshly-opened drawer (they run through panelSend too). Otherwise the
			// drawer opens and immediately snaps shut.
			if (
				!msg.type.startsWith("list_") &&
				!msg.type.startsWith("get_")
			) {
				setDrawer(null);
			}
			return send(msg);
		},
		[send],
	);

	useEffect(() => {
		const onNewChat = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "n") {
				event.preventDefault();
				setView("chat");
				panelSend({ type: "new_chat" });
			}
		};
		window.addEventListener("keydown", onNewChat);
		return () => window.removeEventListener("keydown", onNewChat);
	}, [panelSend]);

	// -- pasted / dropped / uploaded images (no workspace path) ---------------
	const pasteImageId = useRef(0);
	const lastVisionWarn = useRef(0);
	const appendAttachment = (attachment: PendingAttachment, owner: string) => {
		if (owner === attachmentKey.current) setAttachments((prev) => [...prev, attachment]);
		else attachmentDrafts.current.set(owner, [...(attachmentDrafts.current.get(owner) ?? []), attachment]);
	};
	const attachImage = (img: ProcessedImage, owner: string) => {
		// Warn when the current model can't see images — the image would still
		// be attached but silently ignored by the provider. Throttled so adding
		// several images at once produces one notice, not a stack.
		const now = Date.now();
		if (chat.state?.model && !chat.state.model.vision) {
			if (now - lastVisionWarn.current > 10000) {
				lastVisionWarn.current = now;
				pushNotice("warning", t("imageNotSupported"));
			}
		}
		const key = `paste-${++pasteImageId.current}`;
		appendAttachment({
				path: "",
				key,
				name: img.name,
				mode: "inline",
				imageData: img.data,
				mimeType: img.mimeType,
			}, owner);
	};
	const addImageFiles = async (files: File[], owner = attachmentKey.current) => {
		for (const f of files) {
			const img = await fileToProcessedImage(f);
			if (!img) {
				pushNotice("error", t("imageLoadFailed", { name: f.name }));
				continue;
			}
			attachImage(img, owner);
		}
	};

	// -- dropped / uploaded files (any type, no workspace path) ---------------
	/** Keep in sync with MAX_UPLOAD_BYTES in agent-service.ts. */
	const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
	const uploadId = useRef(0);
	const attachLocalFile = async (f: File, owner: string) => {
		if (f.size > MAX_UPLOAD_BYTES) {
			pushNotice(
				"warning",
				t("fileTooLarge", { name: f.name, size: MAX_UPLOAD_BYTES / 1024 / 1024 }),
			);
			return;
		}
		let base64: string;
		try {
			const dataUrl = await new Promise<string>((res, rej) => {
				const r = new FileReader();
				r.onload = () => res(r.result as string);
				r.onerror = () => rej(r.error ?? new Error("read failed"));
				r.readAsDataURL(f);
			});
			base64 = dataUrl.replace(/^data:[^;]*;base64,/, "");
		} catch {
			pushNotice("error", t("fileLoadFailed", { name: f.name }));
			return;
		}
		const key = `upload-${++uploadId.current}`;
		appendAttachment({
				path: "",
				key,
				name: f.name,
				mode: "inline",
				fileData: base64,
				size: f.size,
				mimeType: f.type || undefined,
			}, owner);
	};
	const addLocalFiles = async (files: File[]) => {
		const owner = attachmentKey.current;
		for (const f of files) {
			// Raster images go through the resize/encode pipeline (vision content);
			// everything else — including SVG — is uploaded raw and attached by path.
			if (isRasterImage(f.type)) {
				await addImageFiles([f], owner);
			} else {
				await attachLocalFile(f, owner);
			}
		}
	};

	// Edit-and-re-ask: the server forks a new session at that message and re-asks
	// the edited text there (stable callback — Message is memoized). Attachments
	// carry the question's original images (fork drops their aside cards) plus
	// any newly pasted/dropped ones — same pipeline as a normal prompt.
	const onEditMessage = useCallback(
		(messageId: string, text: string, attachments?: PromptAttachment[]) => {
			send({ type: "edit_message", messageId, text, attachments });
		},
		[send],
	);

	// Stable callbacks for memoized panels (LeftPanel/RightPanel/ChatInput/
	// GoalBar skip re-render while tokens stream in — inline closures here
	// would break their shallow prop comparison every render).
	const openManageModels = useCallback(() => setManageModelsOpen(true), []);
	const clearAttachments = useCallback((conversationId: string, sent: PendingAttachment[]) => {
		const remaining = (items: PendingAttachment[]) => items.filter((item) => !sent.includes(item));
		if (attachmentKey.current === conversationId) setAttachments(remaining);
		else attachmentDrafts.current.set(conversationId, remaining(attachmentDrafts.current.get(conversationId) ?? []));
	}, []);
	const removeAttachmentCb = useCallback(removeAttachment, []);
	const addImageFilesCb = useCallback(addImageFiles, [addImageFiles]);
	const addLocalFilesCb = useCallback(addLocalFiles, [addLocalFiles]);

	// Narrow snapshot of the model/thinking fields for the memoized ChatInput →
	// ModelThinking chain; identity is stable while tokens stream in.
	const model = chat.state?.model;
	const thinkingLevel = chat.state?.thinkingLevel;
	const availableThinkingLevels = chat.state?.availableThinkingLevels;
	const modelState = useMemo(
		() =>
			model
				? {
						model,
						thinkingLevel: thinkingLevel ?? "off",
						availableThinkingLevels: availableThinkingLevels ?? [],
				  }
				: null,
		// Deps are the STABLE inner refs (server reuses them across snapshots),
		// so the object identity survives token deltas and ChatInput's memo holds.
		[model, thinkingLevel, availableThinkingLevels],
	);

	const createShell = useCallback(() => {
		if (!chat.ready || chat.terminals.length !== 0) return false;
		terminal.create({
			id: randomUuid(),
			conversationId: chat.activeConversationId || chat.state?.conversationId || "",
			title: t("terminalTitle", { n: 1 }),
			cwd: chat.state?.cwd ?? "",
			cols: 80,
			rows: 24,
			running: true,
			exitCode: null,
		});
		return true;
	}, [chat.ready, chat.state?.cwd, chat.terminals.length, t, terminal]);

	// If the user clicked Terminal while the initial connection was still
	// loading, complete that request as soon as the session becomes ready.
	useEffect(() => {
		if (!terminalOpenRequested.current) return;
		if (view !== "terminal" || chat.terminals.length !== 0) {
			terminalOpenRequested.current = false;
			return;
		}
		if (createShell()) terminalOpenRequested.current = false;
	}, [chat.terminals.length, createShell, view]);

	return (
		// Whole window is a drop target (issue #19): dragover highlights + any
		// drop attaches. The plain preventDefault used to merely stop the browser
		// navigating away; children with their own handlers (input bar / edit
		// composer) call stopPropagation and keep priority.
		<div
			className={`app design-workspace ${previewFile && view === "chat" ? "document-open" : ""}`}
			style={{ "--left-w": `${leftWidth}px`, "--right-w": `${rightWidth}px` } as CSSProperties}
			onDragOver={(e) => {
				if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
				e.preventDefault();
				setAppDragOver(true);
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node))
					setAppDragOver(false);
			}}
			onDrop={(e) => {
				setAppDragOver(false);
				if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
				e.preventDefault();
				const files = Array.from(e.dataTransfer?.files ?? []);
				if (files.length === 0) {
					pushNotice("warning", t("foldersNotSupported"));
					return;
				}
				// Same split as ChatInput.handleFiles: raster images go through
				// the vision pipeline, everything else uploads as a raw file.
				const images = files.filter((f) => isRasterImage(f.type));
				const others = files.filter((f) => !isRasterImage(f.type));
				if (images.length > 0) void addImageFiles(images);
				if (others.length > 0) void addLocalFiles(others);
			}}
		>
			{appDragOver && (
				<div className="app-drop-overlay" aria-hidden>
					<span>📎 {t("dropHereToAttach")}</span>
				</div>
			)}
			{view !== "nodes" && <div
				className={`panel-drawer drawer-left ${drawer === "left" ? "open" : ""}`}
			>
				<LeftPanel
					onOpenSettings={() => setSettingsOpen(true)}
					onNewChat={() => { setView("chat"); panelSend({ type: "new_chat" }); }}
					send={panelSend}
					active={!isMobile || drawer === "left"}
					ready={chat.ready}
					status={chat.status}
					cwd={chat.state?.cwd ?? ""}
					sessionFile={chat.state?.sessionFile ?? null}
					conversations={chat.conversations}
					sessions={chat.sessions}
					projects={chat.projects}
					dirBrowse={chat.dirBrowse}
					activeConversationId={chat.activeConversationId}
				/>
			</div>}
			{view !== "nodes" && !isMobile && (
				<ResizeHandle side="left" width={leftWidth} onResize={resizeLeft} />
			)}

			<div className="workspace-column">
				<TopBar
					chat={chat}
					send={send}
					terminal={terminal}
					view={view}
					plugins={enabledPlugins}
					onViewChange={(v: ViewName) => {
						// The terminal panel stays mounted while hidden. Create the first
						// shell on the user's terminal-view click, not on initial mount.
						terminalOpenRequested.current =
							v === "terminal" && chat.terminals.length === 0;
						if (terminalOpenRequested.current && createShell()) {
							terminalOpenRequested.current = false;
						}
						setView(v);
						setDrawer(null);
					}}
					onOpenPanel={(side) => {
						if (side === "right" && !isMobile && !isNarrow && !previewFile) setFilesCollapsed((value) => !value);
						else {
							if (side === "right") setFilesCollapsed(false);
							setDrawer((value) => value === side ? null : side);
						}
					}}
					onManageModels={() => setManageModelsOpen(true)}
					onOpenSettings={() => setSettingsOpen(true)}
					onOpenBgTasks={() => setBgTasksOpen(true)}
					onOpenGoal={() => { setView("chat"); setGoalOpenRequest((value) => value + 1); }}
					onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
					sound={sound}
					onSoundChange={setSound}
					onSoundPreview={(kind: SoundKind) => playSound(kind, sound)}
				/>
				{switchError && <div className="protocol-banner" role="alert"><button onClick={() => send({ type: "set_cwd", path: switchError, source: "ui" })}>{t("retryProjectSwitch")}</button> {switchError}</div>}
				{switching && <div className="protocol-banner" role="status">{t("switchingProject")} {switching}</div>}
				{chat.protocolMismatch && (
					<div className="protocol-banner">
						⚠ {t("protocolMismatch")}
					</div>
				)}
				{view !== "chat" && chat.notices.length > 0 && <div className="notices notices-overlay">
					{chat.notices.map((n) => <NoticeToast key={n.id} notice={n} onDismiss={dismissNotice} />)}
				</div>}
				<div
					className="layout"
					style={{ "--left-w": `${leftWidth}px`, "--right-w": `${rightWidth}px`, "--editor-share": editorShare } as CSSProperties}
				>
					{drawer && (isMobile || (isNarrow && !previewFile) || (drawer === "left" && !!previewFile)) && (
						<div className="drawer-backdrop" onClick={() => setDrawer(null)} />
					)}
					<div className={`view-pane ${previewFile ? "preview-open" : ""} ${view === "chat" ? "" : "hidden"}`}>
						<main className="main">
							{chat.state ? (
								<WorkspacePathContext.Provider value={chat.state.cwd}><MessageList
									active={view === "chat"}
									connected={chat.ready}
									key={chat.state.conversationId ?? "boot"}
									state={chat.state}
									liveOutputs={chat.liveOutputs}
									toolStatuses={chat.toolStatuses}
									onEdit={onEditMessage}
									onKillBash={() => send({ type: "abort_bash" })}
									thinkingWrap={chat.settings?.thinkingWrap ?? true}
								toolsWrap={chat.settings?.toolsWrap ?? true}
								pendingEcho={chat.pendingEcho}
								reloadEvents={chat.reloadEvents}
								/></WorkspacePathContext.Provider>
							) : (
								<div className="boot-wait">
									{chat.ready ? t("loadingSession") : t("connectingServer")}
								</div>
							)}
							<GoalBar
								openRequest={goalOpenRequest}
								send={send}
								goal={chat.goal}
								models={chat.models}
								modelsLoading={chat.modelsLoading}
								activeConversationId={chat.activeConversationId}
							/>
							<AgentSilenceStatus chat={chat} send={send} />
							{/* 扩展问卷：非模态内联面板，插在输入框上方，对话内容保持可见 */}
							{chat.dialog && <Dialog dialog={chat.dialog} send={send} />}
							{chat.notices.length > 0 && <div className="notices">
								{chat.notices.map((n) => <NoticeToast key={n.id} notice={n} onDismiss={dismissNotice} />)}
							</div>}
							<ChatInput
								currentFile={!switching && currentFile?.cwd === chat.state?.cwd ? currentFile : null}
								contextReader={contextReader}
								contextSaver={contextSaver}
								stats={chat.state?.stats}
								promptResult={chat.promptResult}
								send={send}
								ready={chat.ready}
								streaming={chat.state?.isStreaming ?? false}
								silentActivity={chat.agentSilence?.conversationId === chat.activeConversationId ? chat.agentSilence.activity : null}
										messages={chat.state?.messages ?? EMPTY_MESSAGES}
								slashCommands={chat.slashCommands}
								modelState={modelState}
								models={chat.models}
								modelsLoading={chat.modelsLoading}
								activeConversationId={chat.activeConversationId}
								setPendingEcho={setPendingEcho}
								attachments={attachments}
								onRemoveAttachment={removeAttachmentCb}
								onAddImageFiles={addImageFilesCb}
								onAddLocalFiles={addLocalFilesCb}
								onNotice={pushNotice}
								onManageModels={openManageModels}
								onSent={clearAttachments}
							/>
						</main>
						{!isMobile && (!isNarrow || !!previewFile) && (!filesCollapsed || !!previewFile) && (
							<ResizeHandle side={previewFile ? "editor" : "right"} width={previewFile ? 480 : rightWidth} onResize={previewFile ? resizeEditor : resizeRight} onReset={previewFile ? () => { setEditorShare(0.45); localStorage.setItem("pi-web-ui:editor-share", "0.45"); } : undefined} />
						)}
						<div
							className={`panel-drawer drawer-right ${filesCollapsed && !previewFile ? "files-collapsed" : ""} ${drawer === "right" ? "open" : ""}`}
						>
							<div className="file-list-host" hidden={!!previewFile}>
								<RightPanel
									active={!filesCollapsed && !previewFile && !switching && view === "chat" && ((!isMobile && !isNarrow) || drawer === "right")}
									send={send}
									files={chat.files}
									conversationFilesChecked={chat.conversationFilesChecked}
									ready={chat.ready}
									scmData={chat.scmData}
									scmDirty={chat.scmDirty}
									fileChanged={chat.fileChanged}
									widgets={chat.widgets}
									messages={chat.state?.messages ?? []}
									streamingMessage={chat.state?.streamingMessage ?? null}
									taskProgress={chat.state?.taskProgress}
									agentSilence={chat.agentSilence}
									cwd={chat.state?.cwd ?? ""}
									onAttach={(path, name, mode, isDir) => {
										setDrawer(null);
										attach(path, name, mode, isDir);
									}}
									onPreview={openPreview}
									onNotice={(level, text) => pushNotice(level, text)}
								/>
							</div>
							{previewFile && (
								<FilePreviewContent
									key={`${previewFile.cwd}:${previewFile.path}`}
									file={previewFile}
									contextReader={contextReader}
									contextSaver={contextSaver}
									onContextChange={setCurrentFile}
									guard={fileGuard}
									result={chat.fileResult}
									disabled={!!switching || previewFile.cwd !== chat.state?.cwd}
									connected={chat.status === "open"}
									content={chat.fileContent}
									fileChanged={chat.fileChanged}
									scmData={chat.scmData?.type === "scm_data" ? chat.scmData : null}
									scmDirty={chat.scmDirty}
									send={send}
									onAddLines={attachPreviewLines}
									onAttach={attach}
									onClose={closePreview}
								/>
							)}
						</div>
					</div>
					<div className={`view-pane ${view === "terminal" ? "" : "hidden"}`}>
						<Suspense fallback={null}>
							{visited.current.has("terminal") && <TerminalPanel active={view === "terminal" && !switching} chat={chat} send={send} terminal={terminal} />}
						</Suspense>
					</div>
					<div className={`view-pane ${view === "nodes" ? "" : "hidden"}`}>
						<Suspense fallback={null}>{visited.current.has("nodes") && <NodeWorkbench active={view === "nodes"} send={send} />}</Suspense>
					</div>
					<div className={`view-pane ${view === "git" ? "" : "hidden"}`}>
						{visited.current.has("git") && <ScmPanel
							chat={chat}
							send={send}
							terminal={terminal}
							active={view === "git"}
							onSwitchToTerminal={() => setView("terminal")}
						/>}
					</div>
					{pluginViews.map((entry) => {
						const name = `plugin:${entry.info.id}` as ViewName;
						return (
							<div key={entry.info.id} className={`view-pane ${view === name ? "" : "hidden"}`}>
								{visited.current.has(name) && <PluginView entry={entry} send={send} />}
							</div>
						);
					})}
				</div>
			</div>
			<FooterBar chat={chat} send={send} />

			{chat.ready &&
				chat.state &&
				chat.state.piConfigured === false &&
				!setupDismissed &&
				!manageModelsOpen && (
					<PiSetupModal
						send={send}
						piConfigured={chat.state.piConfigured}
						piAgentInstalled={chat.state.piAgentInstalled}
						providers={chat.providers}
						installResult={chat.installResult}
						onClose={() => setSetupDismissed(true)}
					/>
				)}
			{manageModelsOpen && (
				<ModelConfigModal
					send={send}
					providers={chat.modelsConfig}
					providerStatus={chat.providers}
					fetchModelsResult={chat.fetchModelsResult}
					refreshProviderResult={chat.refreshProviderResult}
					cloneProviderResult={chat.cloneProviderResult}
					onClose={() => setManageModelsOpen(false)}
				/>
			)}
			{settingsOpen && (
				<SettingsModal
					chat={chat}
					send={send}
					terminal={terminal}
					onSwitchToTerminal={() => setView("terminal")}
					onClose={() => setSettingsOpen(false)}
				/>
			)}
			{bgTasksOpen && (
				<BgTasksModal
					servers={chat.bgServers}
					send={send}
					onClose={() => setBgTasksOpen(false)}
				/>
			)}
			{globalSearchOpen && (
				<GlobalSearchModal
					send={send}
					sessions={chat.sessions}
					projects={chat.projects}
					cwd={chat.state?.cwd ?? ""}
					fileSearch={chat.fileSearch}
					onClose={() => setGlobalSearchOpen(false)}
					onSwitchSession={(path) => {
						void send({ type: "switch_session", path });
					}}
					onSwitchProject={(path) => {
						void send({ type: "set_cwd", path, source: "ui" });
					}}
					onPreviewFile={openPreview}
				/>
			)}
		</div>
	);
}
