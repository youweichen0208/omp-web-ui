import { memo, useEffect, useState } from "react";
import {
	FiCheck,
	FiChevronDown,
	FiChevronRight,
	FiMoreHorizontal,
	FiPlus,
	FiSettings,
	FiX,
} from "react-icons/fi";
import type {
	ConversationSummary,
	DirBrowse,
	ProjectSummary,
	SessionSummary,
} from "../types";
import { FolderPickerModal } from "./FolderPickerModal";
import type { ConnStatus } from "../use-chat";
import { skillAwarePreview } from "../skill-block";
import { conversationDisplayTitle } from "../conversation-display-title";
import { useI18n } from "../i18n";

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  this entire panel during streaming instead of re-reconciling the file tree
 *  and conversation lists on every delta. Add a prop here when adding a chat
 *  field usage — TypeScript enforces it at the call site. */
interface LeftPanelProps {
	onOpenSettings: () => void;
	onNewChat: () => void;
	ready: boolean;
	status: ConnStatus;
	cwd: string;
	sessionFile: string | null;
	conversations: ConversationSummary[];
	sessions: SessionSummary[];
	projects: ProjectSummary[];
	/** Latest workspace-picker listing (drives FolderPickerModal). */
	dirBrowse: DirBrowse | null;
	activeConversationId: string;
	send: (
		msg:
			| { type: "new_chat" }
			| { type: "list_sessions" }
			| { type: "list_projects" }
			| { type: "switch_session"; path: string }
			| { type: "switch_conversation"; id: string }
			| { type: "set_cwd"; path: string; source?: "ui" }
			| { type: "remove_project"; path: string }
			| { type: "delete_session"; path: string }
			| { type: "rename_session"; path: string; name: string }
			| { type: "browse_dirs"; path?: string },
	) => boolean;
	/** True while the panel is actually on screen (desktop: always; mobile:
	 *  only while the drawer is open). Drives lazy loading of the session
	 *  list + recent projects — both scan session files on disk. */
	active: boolean;
}

function formatModified(ts: number, yesterday: string): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	if (sameDay) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	const previous = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
	if (d.toDateString() === previous.toDateString()) return yesterday;
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

export const LeftPanel = memo(function LeftPanel({
	onOpenSettings, onNewChat, ready, status, cwd, sessionFile, conversations, sessions, projects, dirBrowse, activeConversationId, send, active }: LeftPanelProps) {
	const { t, locale } = useI18n();
	const currentFile = sessionFile;
	const currentCwd = cwd;
	// Two-step delete confirm: which row ("proj:<path>" / "sess:<path>") is
	// awaiting its second click. Mirrors the settings-panel uninstall pattern.
	const [confirmDel, setConfirmDel] = useState<string | null>(null);

	// Inline session rename: which transcript path is being edited, and the
	// draft text. Empty draft clears the name (list falls back to first message).
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [openMenu, setOpenMenu] = useState<string | null>(null);
	const [collapsedActive, setCollapsedActive] = useState(false);
	useEffect(() => setCollapsedActive(false), [cwd]);
	useEffect(() => {
		if (!openMenu) return;
		const closeOutside = (event: PointerEvent) => {
			const zone = event.target instanceof Element ? event.target.closest<HTMLElement>(".lp-menu-zone") : null;
			if (zone?.dataset.menuKey !== openMenu) setOpenMenu(null);
		};
		const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpenMenu(null); };
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeEscape);
		return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape); };
	}, [openMenu]);

	// "Open folder": the recent-project list only ever grew as a side effect
	// of the /cwd slash command — this is the panel's own entry point. Opens
	// a server-driven directory picker (see FolderPickerModal for why a
	// native OS dialog can't work here).
	const [picking, setPicking] = useState(false);

	// 乐观项目切换反馈：点击后立即高亮 + 转圈，等 cwd 真正变过来再清掉。
	// "warm" 切换很快，这段几乎一闪而过；"cold" 切换（需要真正恢复会话运行时）
	// 期间也能让用户立刻知道点击生效了，而不是干等服务端往返。
	const [pendingCwd, setPendingCwd] = useState<string | null>(null);
	useEffect(() => {
		if (pendingCwd && cwd === pendingCwd) setPendingCwd(null);
	}, [cwd, pendingCwd]);
	// 兜底：万一切换失败/服务端从未回包，别让转圈永远卡住。
	useEffect(() => {
		if (!pendingCwd) return;
		const timer = setTimeout(() => setPendingCwd(null), 15000);
		return () => clearTimeout(timer);
	}, [pendingCwd]);

	// Lazy load + stale-while-revalidate: (re)fetch whenever the panel is on
	// screen, the connection is ready, or the workspace changed. Old data
	// stays visible while the fresh listing is in flight.
	useEffect(() => {
		if (!active || !ready || status !== "open") return;
		if (!cwd) return;
		send({ type: "list_sessions" });
		send({ type: "list_projects" });
	}, [active, ready, status, cwd, send]);

	const displayName = (s: SessionSummary): string => {
		// s.name is a user rename (kept verbatim); the fallback is the SDK's
		// raw first-user-message, which for a skill invocation is the entire
		// expanded SKILL.md body — collapse that to "skill:name · args"
		// instead of dumping (and truncating mid-sentence) the raw text.
		const title = s.name || convByFile.get(s.path)?.title || skillAwarePreview(s.firstMessage);
		return conversationDisplayTitle(title.length > 0 ? title : t("emptyChat"), s.firstMessage, s.name, s.messageCount, locale);
	};

	// 运行中的对话原来单独列一段，放在历史对话上面。问题是它平时是空的，一新建
	// 对话就突然冒出来一段带标题的区块，看起来像侧栏多了个列表；而那条对话的
	// transcript 其实已经在磁盘上、也在 list_sessions 的返回里，只是被过滤掉了。
	//
	// 现在合成一段。运行中的状态不靠分区表达，靠历史行自己的圆点（绿色脉冲）。
	// 要紧的是点击行为得跟着分流：有活运行时的那条必须走 switch_conversation
	// （按运行时 id 切过去），不能走 switch_session——后者会从磁盘重新恢复一个
	// 已经有活运行时的对话，等于把它重建一遍。
	const convByFile = new Map<string, ConversationSummary>();
	for (const conv of conversations) {
		if (conv.sessionFile) convByFile.set(conv.sessionFile, conv);
	}
	// 刚新建、还没落盘（或者 list_sessions 还没刷新到）的对话，在 sessions 里
	// 找不到对应项。这些单独补在列表最前面，否则新建的对话会从侧栏里整个消失
	// ——这正是「新建会话不立刻出现在历史对话列表」的成因。
	const sessionPaths = new Set(sessions.map((sess) => sess.path));
	const pendingConvs = conversations.filter(
		(conv) => !conv.sessionFile || !sessionPaths.has(conv.sessionFile),
	);

	const projectName = (path: string): string => {
		const normalized = path.replace(/\\/g, "/").replace(/\/$/, "") || "/";
		if (normalized === "/" || /^[A-Za-z]:$/.test(normalized)) return t("rootDir");
		if (/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)$/.test(normalized)) return "~";
		return normalized.split("/").at(-1) || normalized;
	};
	const projectActivity = (project: ProjectSummary) => Math.max(
		project.lastUsed,
		project.lastConversationAt ?? 0,
		project.path === currentCwd && sessions.length ? Math.max(...sessions.map((session) => session.modified)) : 0,
	);
	const sortedProjects = [...projects].sort((a, b) =>
		Number(b.path === currentCwd) - Number(a.path === currentCwd) ||
		projectActivity(b) - projectActivity(a) || a.path.localeCompare(b.path),
	);

	const history = (
			<div className="panel-sessions">
				<div className="panel-section-title">{t("historySessions")}</div>
				<div className="sessions-scroll">
					{sessions.length === 0 && pendingConvs.length === 0 && (
						<div className="panel-empty">{t("noHistory")}</div>
					)}
					{pendingConvs.map((c) => {
						const active = activeConversationId === c.id;
						return (
							<button
								type="button"
								key={c.id}
								className={`session-item ${active ? "active" : ""}`}
								title={`${c.title}\n${
									active ? t("current") : t("messageCount", { n: c.messageCount })
								}`}
								onClick={() => {
									if (!active) send({ type: "switch_conversation", id: c.id });
								}}
							>
								<span
									className={`session-dot${c.isStreaming ? " streaming" : ""}`}
									title={c.isStreaming ? t("streaming") : undefined}
								/>
								<span className="session-info">
									<span className="session-title">{conversationDisplayTitle(c.title, undefined, undefined, c.messageCount, locale)}</span>
								</span>
								<span className="session-time">{formatModified(c.createdAt ?? Date.now(), t("yesterday"))}</span>
							</button>
						);
					})}
					{sessions.map((s) => {
						const conv = convByFile.get(s.path);
						const active = conv
							? activeConversationId === conv.id
							: currentFile === s.path;
						if (renaming === s.path) {
							return (
								<form
									className="lp-inline-form"
									key={s.path}
									onSubmit={(e) => {
										e.preventDefault();
										send({
											type: "rename_session",
											path: s.path,
											name: renameDraft.trim(),
										});
										setRenaming(null);
									}}
								>
									{/* biome-ignore lint/a11y/noAutofocus: opened by an explicit click */}
									<input
										autoFocus
										className="lp-inline-input"
										placeholder={t("renameSessionPlaceholder")}
										value={renameDraft}
										onChange={(e) => setRenameDraft(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Escape") setRenaming(null);
										}}
									/>
									<button type="submit" className="lp-inline-ok" title={t("confirm")}>
										<FiCheck />
									</button>
									<button
										type="button"
										className="lp-inline-cancel"
										title={t("cancel")}
										onClick={() => setRenaming(null)}
									>
										<FiX />
									</button>
								</form>
							);
						}
						return (
							<div
								className="lp-row"
								key={s.path}
								onMouseLeave={() =>
									setConfirmDel((k) => (k === `sess:${s.path}` ? null : k))
								}
							>
								<button
									type="button"
									className={`session-item ${active ? "active" : ""}`}
									title={`${s.path}\n${
										active
											? t("current")
											: t("messageCount", { n: s.messageCount })
									}`}
									onClick={() => {
										if (active) return;
										send(
											conv
												? { type: "switch_conversation", id: conv.id }
												: { type: "switch_session", path: s.path },
										);
									}}
								>
									<span
										className={`session-dot${conv?.isStreaming ? " streaming" : ""}`}
										title={conv?.isStreaming ? t("streaming") : undefined}
									/>
									<span className="session-info">
										<span className="session-title">{displayName(s)}</span>
									</span>
									{s.source === "tui" && (
										<span className="session-src" title={t("tuiTip")}>
											TUI
										</span>
									)}
									<span className="session-time">
										{formatModified(s.modified, t("yesterday"))}
									</span>
								</button>
								<div className={`lp-menu-zone${openMenu === `sess:${s.path}` ? " is-open" : ""}`} data-menu-key={`sess:${s.path}`}>
									<button type="button" className="lp-menu-trigger" aria-label={`${displayName(s)} · ${t("more")}`} aria-haspopup="menu" aria-expanded={openMenu === `sess:${s.path}`} onClick={() => setOpenMenu((key) => key === `sess:${s.path}` ? null : `sess:${s.path}`)}><FiMoreHorizontal /></button>
									{openMenu === `sess:${s.path}` && <div className="lp-menu-popover" role="menu">
										<button type="button" role="menuitem" onClick={() => { setRenameDraft(s.name ?? displayName(s)); setRenaming(s.path); setOpenMenu(null); }}>{t("renameSession")}</button>
										<button type="button" role="menuitem" className={confirmDel === `sess:${s.path}` ? "danger" : ""} onClick={() => {
											if (confirmDel === `sess:${s.path}`) { send({ type: "delete_session", path: s.path }); setConfirmDel(null); setOpenMenu(null); }
											else setConfirmDel(`sess:${s.path}`);
										}}>{confirmDel === `sess:${s.path}` ? t("deleteSessionConfirm") : t("deleteSession")}</button>
									</div>}
								</div>
							</div>
						);
					})}
				</div>
			</div>
	);
	return (
		<aside className="panel panel-left">
			<div className="sidebar-brand"><img src="/favicon.svg" alt="" /><strong>pi-web-ui</strong></div>
			<div className="sidebar-new"><button type="button" onClick={onNewChat}><span><FiPlus />{t("newChat")}</span><kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}N</kbd></button></div>
			<div className="panel-projects">
				{/* 加项目收进分组标题行：它是个偶尔用一次的动作，不值得在列表
				    最上面常驻一整行。 */}
				<div className="panel-section-title">
					<span>{t("workspaceProjects")}</span>
					<button
						type="button"
						className="lp-add-project"
						title={t("openFolder")}
						aria-label={t("openFolder")}
						onClick={() => setPicking(true)}
					>
						<FiPlus />
					</button>
				</div>
				<div className="projects-scroll">
					{sortedProjects.map((p) => {
						const active = currentCwd === p.path;
						const pending = !active && pendingCwd === p.path;
						const expanded = active && !collapsedActive;
						const count = active ? Math.max(p.conversationCount ?? 0, sessions.length + pendingConvs.length) : p.conversationCount ?? 0;
						return (
							<div
								className="lp-row"
								key={p.path}
								onMouseLeave={() =>
									setConfirmDel((k) => (k === `proj:${p.path}` ? null : k))
								}
							>
								<button
									type="button"
									className={`project-item ${active ? "active" : ""} ${pending ? "pending" : ""}`}
									title={p.path}
									onClick={() => {
										if (active) setCollapsedActive((value) => !value);
										else {
											setCollapsedActive(false);
											setPendingCwd(p.path);
										send({ type: "set_cwd", path: p.path, source: "ui" });
										}
									}}
								>
									{expanded ? <FiChevronDown className="project-chevron" /> : <FiChevronRight className="project-chevron" />}
									<span className="project-info">
										<span className="project-name">{projectName(p.path)}</span>
										<span className="project-count">· {count}</span>
									</span>
									{pending ? (
										<span className="thinking-spinner project-spinner" aria-hidden="true" />
									) : (
										<span className="project-time">
											{formatModified(projectActivity(p), t("yesterday"))}
										</span>
									)}
								</button>
								<div className={`lp-menu-zone${openMenu === `proj:${p.path}` ? " is-open" : ""}`} data-menu-key={`proj:${p.path}`}>
									<button type="button" className="lp-menu-trigger" aria-label={`${projectName(p.path)} · ${t("more")}`} aria-haspopup="menu" aria-expanded={openMenu === `proj:${p.path}`} onClick={() => setOpenMenu((key) => key === `proj:${p.path}` ? null : `proj:${p.path}`)}><FiMoreHorizontal /></button>
									{openMenu === `proj:${p.path}` && <div className="lp-menu-popover" role="menu">
										<button type="button" role="menuitem" className={confirmDel === `proj:${p.path}` ? "danger" : ""} onClick={() => {
											if (confirmDel === `proj:${p.path}`) { send({ type: "remove_project", path: p.path }); setConfirmDel(null); setOpenMenu(null); }
											else setConfirmDel(`proj:${p.path}`);
										}}>{confirmDel === `proj:${p.path}` ? t("deleteProjectConfirm") : t("deleteProject")}</button>
									</div>}
								</div>
								{expanded && history}
							</div>
						);
					})}
				</div>
			</div>

			{!projects.some((project) => project.path === currentCwd) && history}
			<div className="sidebar-footer">
				<span className="sidebar-connection"><i className={ready ? "ok" : "busy"} />{t(ready ? "connected" : "connecting")}</span>
				<span id="sidebar-settings-slot"><button type="button" onClick={onOpenSettings}><FiSettings aria-hidden="true" /> {t("settings")}</button></span>
			</div>

			{picking && (
				<FolderPickerModal
					dirBrowse={dirBrowse}
					onBrowse={(path) => send({ type: "browse_dirs", path })}
					onPick={(path) => {
						setPendingCwd(path);
						send({ type: "set_cwd", path, source: "ui" });
						setPicking(false);
					}}
					onClose={() => setPicking(false)}
				/>
			)}
		</aside>
	);
});
