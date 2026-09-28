import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import {
	FiSidebar,
	FiGitBranch,
	FiGlobe,
	FiMenu,
	FiMessageSquare,
	FiSearch,
	FiPlus,
	FiSettings,
	FiLayers,
	FiTerminal,
	FiMinus,
	FiSquare,
	FiCopy,
	FiX,
} from "react-icons/fi";
import { desktopAPI, type DesktopWindowState } from "../desktop";
import type { ChatState } from "../use-chat";
import type { ClientMessage, CommandDef } from "../types";
import { Dropdown, DropdownItem } from "./Dropdown";
import { ModelThinking } from "./ModelThinking";
import { SoundSettingsPanel } from "./SoundSettings";
import type { SoundKind, SoundSettings } from "../sounds";
import { useI18n, type Locale } from "../i18n";
import { skillAwarePreview } from "../skill-block";
import { conversationDisplayTitle } from "../conversation-display-title";

interface TopBarProps {
	leftCollapsed?: boolean;
	gitChangeCount: number;
	onOpenTask: () => void;
	chat: ChatState;
	send: (msg: ClientMessage) => boolean;
	/** Minimal terminal-tab bridge (same shape SCMPanel uses) — updates run there. */
	terminal: {
		create: (meta: {
			id: string;
			conversationId: string;
			title: string;
			cwd: string;
			cols: number;
			rows: number;
			running: boolean;
			exitCode: number | null;
			command?: CommandDef;
		}) => void;
		restart: (id: string) => void;
	};
	view: "chat" | "terminal" | "git" | "nodes" | `plugin:${string}`;
	onViewChange: (view: "chat" | "terminal" | "git" | "nodes" | `plugin:${string}`) => void;
	/** Installed optional plugins (<dataDir>/plugins) — one view tab each. */
	plugins: { id: string; name: string; icon?: string; description?: string; error?: string }[];
	/** Open a side panel as a mobile drawer ("left" = history, "right" = files). */
	onOpenPanel: (side: "left" | "right") => void;
	/** Open the custom model config panel. */
	onManageModels: () => void;
	/** Open the settings panel (system prompt / skills / extensions / presets). */
	onOpenSettings: () => void;
	/** Open the background-task panel (AI-started servers — stop individually or all). */
	onOpenBgTasks: () => void;
	onOpenGoal: () => void;
	/** Open the global search panel (sessions / projects / workspace files). */
	onOpenGlobalSearch: () => void;
	/** Sound notification settings + change handler (owned by App). */
	sound: SoundSettings;
	onSoundChange: (settings: SoundSettings) => void;
	onSoundPreview: (kind: SoundKind) => void;
}

export function TopBar({
	leftCollapsed = false,
	gitChangeCount,
	onOpenTask,
	chat,
	send,
	terminal,
	view,
	plugins,
	onViewChange,
	onOpenPanel,
	onManageModels,
	onOpenSettings,
	onOpenBgTasks,
	onOpenGoal,
	onOpenGlobalSearch,
	sound,
	onSoundChange,
	onSoundPreview,
}: TopBarProps) {
	const { locale, setLocale, t } = useI18n();
	const [langOpen, setLangOpen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const [menuHost, setMenuHost] = useState<HTMLElement | null>(null);
	useEffect(() => {
		setMenuHost(!leftCollapsed ? document.getElementById("sidebar-settings-slot") : null);
	}, [view, leftCollapsed]);
	const [windowState, setWindowState] = useState<DesktopWindowState>({ maximized: false, fullscreen: false });
	useEffect(() => desktopAPI?.onWindowState(setWindowState), []);
	const projectName = chat.state?.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
	const notGitRepo = chat.gitBranch?.cwd === chat.state?.cwd && !!chat.gitBranch?.notRepo;
	const task = chat.state?.conversationId === chat.activeConversationId ? chat.state?.taskProgress : null;
	const planItems = task?.status === "running" ? task.plan?.items.filter((item) => item.status !== "removed") ?? [] : [];
	const currentStep = planItems.findIndex((item) => item.status === "running");

	const session = chat.sessions.find((item) => item.path === chat.state?.sessionFile);
	const conversation = chat.conversations.find((item) => item.id === chat.activeConversationId);
	const conversationTitle = conversationDisplayTitle(
		conversation?.title || skillAwarePreview(session?.firstMessage ?? "") || t("newChat"),
		session?.firstMessage,
		session?.name,
		Math.max(session?.messageCount ?? 0, conversation?.messageCount ?? 0, chat.state?.messages.length ?? 0),
		locale,
		chat.state?.messages,
	);

	const LANGUAGES: { value: Locale; label: string }[] = [
		{ value: "zh", label: t("langZh") },
		{ value: "en", label: t("langEn") },
	];

	const connLabel = chat.ready
		? t("connected")
		: chat.status === "closed"
			? t("reconnecting")
			: t("connecting");
	const connClass = chat.ready ? "ok" : "busy";

	const settingsMenu = (
				<div className="topbar-more">
					<Dropdown
						trigger={
							<>
								<FiSettings aria-hidden="true" />
								<span className="chip-sub">{t("settings")}</span>
							</>
						}
						open={moreOpen}
						onOpenChange={setMoreOpen}
					>
						<div className="dd-header">{t("settings")}</div>
						<DropdownItem onClick={() => { setMoreOpen(false); onOpenGoal(); }}>{t("goalBarTitle")}</DropdownItem>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenSettings();
							}}
						>
							<FiSettings /> {t("settingsTitle")}
						</DropdownItem>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenGlobalSearch();
							}}
						>
							<FiSearch /> {t("searchGlobal")}
						</DropdownItem>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenBgTasks();
							}}
						>
							<FiLayers /> {t("bgTasks")}
							{chat.bgServers.length > 0 && (
								<em className="bg-task-badge">{chat.bgServers.length}</em>
							)}
						</DropdownItem>
						<SoundSettingsPanel
							settings={sound}
							onChange={onSoundChange}
							onPreview={onSoundPreview}
						/>
						<div className="dd-header">{t("language")}</div>
						{LANGUAGES.map((l) => (
							<DropdownItem
								key={l.value}
								active={locale === l.value}
								onClick={() => setLocale(l.value)}
							>
								{l.label}
							</DropdownItem>
						))}
					</Dropdown>
				</div>
	);
	return (
		<header className="topbar">
			<div className="brand">
				<button
					type="button"
					className="panel-toggle"
					title={t("openHistory")}
					onClick={() => onOpenPanel("left")}
				>
					<FiMenu />
				</button>
				<img className="brand-logo" src="/favicon.svg" alt="" />
				<span className="brand-name">pi-web-ui</span>
				{desktopAPI && (
					<span className="desktop-window-title" title={chat.state?.cwd ?? ""}>
						pi <span className="desktop-title-separator">/</span> {projectName || t("desktopWorkspace")}
					</span>
				)}
				<span className={`conn-dot ${connClass}`} title={connLabel} />
				<span className="conn-label">{connLabel}</span>
			</div>

			{view !== "nodes" && <button type="button" className="project-panel-toggle" title={t(leftCollapsed ? "expandProjects" : "collapseProjects")} aria-label={t(leftCollapsed ? "expandProjects" : "collapseProjects")} aria-expanded={!leftCollapsed} onClick={() => onOpenPanel("left")}><FiSidebar /></button>}
			<div className="header-location"><span title={chat.state?.cwd}>{projectName || t("desktopWorkspace")}</span><i>/</i><strong title={conversationTitle}>{conversationTitle}</strong>{currentStep >= 0 && <button type="button" className="header-task-progress" title={t("taskProgress")} onClick={onOpenTask}><span aria-hidden="true">●</span>{t("taskPlanPosition", { current: currentStep + 1, total: planItems.length })}</button>}</div>
			<div className="topbar-actions">
				<div
					className="view-switch"
					role="tablist"
					aria-label={t("viewSwitch")}
				>
					<button
						type="button"
						role="tab"
						aria-label={t("chat")}
						title={t("chat")}
						aria-selected={view === "chat"}
						className={view === "chat" ? "active" : ""}
						onClick={() => onViewChange("chat")}
					>
						<FiMessageSquare />
						<span>{t("chat")}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-label={t("terminal")}
						title={t("terminal")}
						aria-selected={view === "terminal"}
						className={view === "terminal" ? "active" : ""}
						onClick={() => onViewChange("terminal")}
					>
						<FiTerminal />
						<span>{t("terminal")}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-label={t("nodes")}
						title={t("nodes")}
						aria-selected={view === "nodes"}
						className={view === "nodes" ? "active" : ""}
						onClick={() => onViewChange("nodes")}
					>
						<FiGlobe />
						<span>{t("nodes")}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-label={t("scmTab")}
						title={notGitRepo ? t("notGitRepoShort") : t("scmTab")}
						aria-disabled={notGitRepo}
						className={view === "git" ? "active" : undefined}
						aria-selected={view === "git"}
						onClick={() => { if (!notGitRepo) onViewChange("git"); }}
					>
						<FiGitBranch />
						<span>{t("scmTab")}</span>
						{!notGitRepo && gitChangeCount > 0 && <em className="tab-change-count">{gitChangeCount}</em>}
					</button>
					<button type="button" className="workspace-jobs" onClick={onOpenBgTasks} title={t("bgTasksTip")}><FiLayers /><span>{t("bgTasks")}</span>{chat.bgServers.length > 0 && <em className="bg-task-badge">{chat.bgServers.length}</em>}</button>
					{plugins.map((p) => {
						const tip = p.error
							? `${p.name}: ${p.error}`
							: p.description
								? `${p.name} — ${p.description}`
								: p.name;
						return (
							<button
								key={p.id}
								type="button"
								role="tab"
								aria-selected={view === `plugin:${p.id}`}
								className={`plugin-tab${view === `plugin:${p.id}` ? " active" : ""}${p.error ? " broken" : ""}`}
								title={tip}
								onClick={() => onViewChange(`plugin:${p.id}`)}
							>
								{p.icon ? <span aria-hidden>{p.icon}</span> : null}
								<span>{p.name}</span>
							</button>
						);
					})}
				</div>

				{/* Desktop toolbar — hidden on mobile (model/thinking move into the
				    input row; sound/lang fold into "⋯" below). Update-check and
				    GitHub link live only inside the "⋯" panel now, on both
				    desktop and mobile — no separate top-level chips for them. */}
				<div className="topbar-desktop">
					{/* Background tasks — AI-started servers still listening. Always shown
					    so the list survives the conversation that started them (badge = count). */}
					<button
						type="button"
						className="chip bg-task-chip"
						data-tip={t("bgTasksTip")}
						onClick={onOpenBgTasks}
					>
						<FiLayers />
						<span className="chip-sub">{t("bgTasks")}</span>
						{chat.bgServers.length > 0 && (
							<span className="bg-task-badge">{chat.bgServers.length}</span>
						)}
					</button>
					<ModelThinking
						state={chat.state ? { model: chat.state.model, thinkingLevel: chat.state.thinkingLevel, availableThinkingLevels: chat.state.availableThinkingLevels } : null}
						models={chat.models}
						modelsLoading={chat.modelsLoading}
						send={send}
						onManageModels={onManageModels}
					/>

					<button
						type="button"
						className="chip"
						title={t("settingsTitle")}
						onClick={onOpenSettings}
					>
						<FiSettings />
						<span className="chip-sub">{t("settings")}</span>
					</button>

					<Dropdown
						trigger={
							<>
								<FiGlobe />
								<span className="chip-sub">
									{locale === "zh" ? t("langZh") : "EN"}
								</span>
							</>
						}
						open={langOpen}
						onOpenChange={setLangOpen}
					>
						<div className="dd-header">{t("language")}</div>
						{LANGUAGES.map((l) => (
							<DropdownItem
								key={l.value}
								active={locale === l.value}
								onClick={() => {
									setLocale(l.value);
									setLangOpen(false);
								}}
							>
								{l.label}
							</DropdownItem>
						))}
					</Dropdown>

				</div>

				<button
					type="button"
					className="chip newchat"
					data-tip={t("newChatTip")}
					onClick={() => send({ type: "new_chat" })}
				>
					<FiPlus />
					<span>{t("newChat")}</span>
				</button>

				{/* Mobile "⋯" panel — folds sound / language. */}
				{menuHost ? createPortal(settingsMenu, menuHost) : settingsMenu}

				<button
					type="button"
					className="panel-toggle"
					title={t("openFiles")}
					onClick={() => onOpenPanel("right")}
				>
					<FiSidebar />
				</button>
			</div>
			{desktopAPI && desktopAPI.platform !== "darwin" && (
				<div className="desktop-window-controls" aria-label={t("windowControls")}>
					<button type="button" title={t("minimizeWindow")} aria-label={t("minimizeWindow")} onClick={() => desktopAPI?.windowAction("minimize")}><FiMinus /></button>
					<button type="button" title={windowState.maximized || windowState.fullscreen ? t("restoreWindow") : t("maximizeWindow")} aria-label={windowState.maximized || windowState.fullscreen ? t("restoreWindow") : t("maximizeWindow")} onClick={() => desktopAPI?.windowAction("toggle-maximize")}>{windowState.maximized || windowState.fullscreen ? <FiCopy /> : <FiSquare />}</button>
					<button type="button" className="desktop-window-close" title={t("closeWindow")} aria-label={t("closeWindow")} onClick={() => desktopAPI?.windowAction("close")}><FiX /></button>
				</div>
			)}
		</header>
	);
}
