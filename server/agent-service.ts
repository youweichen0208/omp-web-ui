import { planSettings } from "./plan/settings.js";
import { resolveNativeAttachments } from "./user-attachments.js";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { SessionTreeController } from "./session-tree-controller.js";
import { SessionBranchCounts } from "./session-file-read.js";
import type { TreeRequest } from "./protocol.js";
import { createHash, randomUUID } from "node:crypto";
import { recoveryEvent, isRecovering, recoverySnapshot, type RecoveryState } from "./recovery-state.js";
import { Readable } from "node:stream";
import { openToolOutput, toolOutputManifest, toolOutputId } from "./tool-output.js";
import { nativeToolDetails, toolExitCode } from "./serialize.js";
import { flushPromptReload, getSystemPromptState, promptReloadStatus, promptUsesFile, queuePromptReload, writeSystemPromptFile } from "./system-prompt-files.js";
import { parseNativeMcpStatus } from "./native-mcp-presentation.js";
import { codemodeDetails } from "./codemode-presentation.js";
import { NativeMcpConfigService } from "./native-mcp-config.js";

import type { ClientMessage } from "./protocol.js";
import { conversationSettings, setConversationRunSettings, nativeToolExtensions } from "./native-tools.js";
import { ProviderAuthService } from "./provider-auth.js";
import { packageManagerFor, updateTargets, checkComponents, componentRestartRequired, updateComponentPackage } from "./component-updates.js";
import { toolOutputUpdate } from "./tool-output.js";
import { ThinkingTimings, ThinkingDurationStore } from "./thinking-timing.js";
import { deliverPrompt, recallPending } from "./prompt-delivery.js";
import type { PromptAttachment } from "./protocol.js";
import { validateEditorSnapshots } from "./editor-snapshot.js";

import { QueryCache } from "./query-cache.js";
/**
 * AgentService — wraps the pi SDK (@earendil-works/pi-coding-agent) for the web
 * frontend. Each browser client (identified by a persistent clientId) gets its
 * own AgentSessionRuntime, but sessions live in the SDK default per-project
 * directory (<agentDir>/sessions/--<cwd>--/) — the same transcript files the
 * pi CLI/TUI use — so every conversation of a folder shows up everywhere.
 *
 * Streaming model: the SDK emits AgentSessionEvents; we forward lightweight
 * `tool_delta` messages for live tool output and schedule throttled full-state
 * snapshots. The frontend is snapshot-driven (server is the source of truth),
 * so reconnects just re-request a snapshot.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	mkdirSync,
	watch,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,

	getAgentDir,
	ModelRuntime,
	SessionManager,
	VERSION,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	type Theme,

} from "@earendil-works/pi-coding-agent";
// pi-coding-agent 自己压缩历史消息（agent-session.js 的 compact()）走的也是这两个
// 调用，不是我们临时拼出来的私活。声明成显式依赖、锁成跟 pi-coding-agent 完全
// 一致的版本号，保证两边用的是同一份实现。
import { contentText } from "@earendil-works/pi-ai";
import { estimateContextParts } from "./context-breakdown.js";
import { appVersion } from "./app-version.js";
import { BgServerTracker } from "./bg-servers.js";
import type {   PluginToolEvent } from "./plugins.js";
import { SettingsService } from "./settings-service.js";

import { SlashCommandsService, parseSlash } from "./slash-commands.js";
import { ModelAdminService } from "./model-admin.js";
import { FilesService, existingConversationFiles, workspacePath } from "./files-service.js";
import {

	ClientStateStore,
	type DiskProjectSummary,
	mergeProjectSummaries,
} from "./client-state.js";
import { saveUpload } from "./uploads.js";
import { WebUIContext } from "./webui-context.js";
import {
	buildAttachmentMessages,

} from "./attachments.js";
import type {
		BgServer,
		CommandDef,
		ConversationSummary,
		FileEntry,

		ServerMessage,
		SessionSummary,
		UiMessage,
		UiModelConfigEntry,
		UiProviderConfig,
		UiSettingsState,

		UiState,
} from "./protocol.js";
import {
	serializeMessage,
	contentFingerprint,
	serializeStreamingMessage,
	type AgentMessage,
} from "./serialize.js";
import { deriveTaskProgress } from "./task-progress.js";

import { taskHistoryFromSession } from "./plan/progress.js";

import {
	loadCommands,
	saveCommandsFile,
	TerminalManager,
} from "./terminals.js";

const SNAPSHOT_INTERVAL_MS = 60;
/** While assistant deltas are flowing, live rendering is carried by
 *  message_delta — full snapshots become pure reconciliation checkpoints, so
 *  send them on a slow event-driven cadence (see flushSnapshot call-sites:
 *  agent_settled / tool_execution_end always checkpoint immediately). */
const STREAMING_SNAPSHOT_INTERVAL_MS = 2000;
/** Deltas newer than this keep the streaming (low-frequency) snapshot cadence. */
const DELTA_ACTIVE_WINDOW_MS = 1500;
const WIDGET_REFRESH_MS = 2000;
/** Model-stall watchdog: warn (don't abort — deep thinking can be legitimately
 *  quiet for minutes) when a streaming run produced NO SDK events for this long.
 *  Covers the failure class the per-tool watchdog cannot see: half-open API
 *  connections / hung proxies where no tool is running and no error is thrown.
 *  Override: PI_WEB_STALL_NOTIFY_MS (milliseconds; 0 disables). */
const STALL_NOTIFY_MS = (() => {
	const v = Number(process.env.PI_WEB_STALL_NOTIFY_MS);
	return Number.isFinite(v) && v >= 0 ? v : 180_000;
})();
/** Serialization-cache cap per conversation (see serializeCached): cached
 *  UiMessage objects are pure-function results, so eviction only costs a
 *  recompute on next access. Bounds memory for marathon sessions. */
const UI_MESSAGE_CACHE_CAP = 4096;
/** Preview panel cap: only the first 512KB of a file is ever read/sent. */

/** Thrown when the service is quiesced (draining) and the request is NEW work
 *  the admission controller refuses: a brand-new client attach, a prompt,
 *  a fork, a session resume, or a goal wizard start. index.ts closes the
 *  WebSocket with 4403 so the browser reconnect loop can retry after the
 *  server reopens admission (see AgentService.quiesce). */
export class QuiesceRejectedError extends Error {
	readonly code = "QUIESCED";
	constructor(detail: string) {
		super(`服务器正在排空存量工作（quiesce）——${detail}`);
		this.name = "QuiesceRejectedError";
	}
}

// ---------------------------------------------------------------------------
// Preview kind classification. The preview panel only opens image / video /
// text-editable files; everything else (exe, jar, archives, …) is refused so
// it is never read or sent to the browser. Media files are served over the
// /api/file HTTP endpoint instead of the WebSocket, so they are classified
// here but never read into the snapshot path.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Web UI context adapter — bridges extension UI calls (setWidget/notify) to the
// browser. Extensions like rpiv-todo render a TUI widget via
// `ui.setWidget(key, (tui, theme) => comp)`; we capture the component, render it
// with a mock theme to plain text lines, and push them to the client.
// ---------------------------------------------------------------------------

export { workspacePath };
// ---------------------------------------------------------------------------
// Per-client persisted UI state (<dataDir>/client-state.json)
// ---------------------------------------------------------------------------

/**
 * One open conversation (chat thread) of a client. Each conversation owns its
 * OWN AgentSessionRuntime, so starting a new chat or switching between chats
 * never interrupts another conversation's in-flight run.
 */
interface Conversation {
	tree?: SessionTreeController;
	treeProjectionRevision?: string;
	treeEntryIds?: Map<string, string[]>;
	recovery: RecoveryState;
	webUi: WebUIContext;
	/** Wiki conversations are temporary native in-memory sessions. */
	wiki?: boolean;
	thinkingTimings: ThinkingTimings;
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;

	runtime: AgentSessionRuntime;
	session: AgentSession;
	cwd: string;
	createdAt: number;
	/** In the per-project "running conversations" list. A conversation enters
	 *  the list when it is displaced to the background while still streaming;
	 *  it leaves (and its runtime is freed) when it is opened again and left
	 *  without continuing. */
	listed: boolean;
	/** A prompt was sent while this conversation was active (cleared whenever
	 *  it becomes active). A listed conversation that is displaced while idle
	 *  with this still false counts as "opened but not continued" and is
	 *  dismissed from the list. */
	promptedSinceActive: boolean;
	/** Last time this conversation became active — set_cwd picks the target
	 *  project's most recently active conversation. */
	lastActiveAt: number;
	/** Last SDK event time for this conversation. This detects a quiet run;
	 *  WebSocket heartbeat separately reports browser/server connectivity. */
	lastSdkEventAt: number;
	/** Timestamp of the latest completed run in the current user turn. */
	lastTaskEndedAt?: number;
	/** Set once the silence state has been sent for the current quiet period;
	 *  cleared on every SDK event and on each new prompt. */
	stallNoticed: boolean;
	/** Names of in-flight tools, so a quiet command is not mistaken for a silent model. */
	runningToolNames: Map<string, string>;
	toolsExecutedSincePrompt: boolean;

	/** Wizard execution is per conversation; dialog transport itself remains
	 * client-wide because the browser can display one dialog at a time. */

	/** Session event subscription — events are routed to THIS conversation. */
	unsubscribe?: () => void;
	/** Monotonic sequence for message_delta/tool_delta pushes of this conversation —
	 *  a gap on the client triggers a get_state resync. */
	deltaSeq: number;
	/** PTYs belong to the conversation, not the browser socket or client. */
	terminals: TerminalManager;
	// Per-conversation serialization caches. Message ids derive from
	// (role, timestamp); two conversations can produce identical pairs, so
	// these must never be shared across conversations.
	msgIds: Map<string, number>;
	nextMsgId: number;
	/** Per-timestamp 1-based user-message seq (drives the `u-<ts>-<seq>` id suffix). */
	userSeqByTs: Map<number, number>;
	uiMessageCache: Map<string, UiMessage>;
	lastMessagesSig: string;
	lastMessagesArray: UiMessage[];
	/** Actual queued prompt TEXTS (steer = 插队, followUp = 排队) — the UI
	 *  renders them as pending bubbles in the real message list. */
	queueSteering: string[];
	queueFollowUp: string[];
	/** tool_execution_start timestamps keyed by toolCallId — lets tool_status
	 *  report how long a tool actually ran (vs. waiting on the model). */
	toolStartTimes: Map<string, number>;

}

/** Hard cap on how long ONE tool call may run before the watchdog aborts the
 *  session. This covers all tools, including explicit long bash timeouts and
 *  extension tools without their own deadlines. Override with the PI_WEB_TOOL_TIMEOUT_MS env var
 *  (milliseconds). */

/** Cap on simultaneously open conversations of ONE project (each keeps a full
 *  runtime alive; conversations of other projects keep their own lists). */
const MAX_OPEN_CONVERSATIONS = 8;
const DEFAULT_CONV_TITLE = "新对话";

// Mirrors web/src/skill-block.ts's parseSkillBlock (which itself mirrors the
// pi SDK's dist/core/agent-session.js) — kept in sync by hand, server and
// web can't share a module across the tsconfig split. When the user sends
// /skill:name args, the SDK expands the prompt into
// `<skill name="..." location="...">\n...SKILL.md body...\n</skill>\n\n<args>`;
// using that raw text as a conversation title would dump (and mid-sentence
// truncate) the entire skill body instead of something readable.
const SKILL_BLOCK_TITLE_RE =
	/^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

function skillAwareTitleText(text: string): string {
	const m = text.match(SKILL_BLOCK_TITLE_RE);
	if (!m) return text;
	const name = m[1];
	const args = m[2]?.trim();
	return `skill:${name}` + (args ? ` · ${args}` : "");
}

/** First user text in a session, truncated for the conversation list. */
function conversationTitle(session: AgentSession): string {
	try {
		for (const m of session.agent.state.messages) {
			if (m.role !== "user") continue;
			const content = m.content as unknown;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				for (const p of content) {
					if (
						p &&
						typeof p === "object" &&
						(p as { type?: unknown }).type === "text" &&
						typeof (p as { text?: unknown }).text === "string"
					) {
						text = (p as { text: string }).text;
						break;
					}
				}
			}
			const trimmed = skillAwareTitleText(text).trim().replace(/\s+/g, " ");
			if (trimmed.length > 0) {
				return trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
			}
		}
	} catch {
		// best-effort
	}
	return DEFAULT_CONV_TITLE;
}

/** AgentSession 私有方法 `_getSummarizationRequestAuth` 的返回结构。
 *  动它之前先看下面 generateAiTitle() 上的注意事项。 */
type SummarizationAuth = {
	model: NonNullable<AgentSession["model"]>;
	apiKey?: string;
	headers?: Record<string, string | null>;
	env?: Record<string, string>;
};

/**
 * 用当前会话的模型给对话起一个短标题。
 *
 * 注意：这里踩了两块 SDK 的非公开地面，都是有意为之、也都做了兜底——
 *   1. `_getSummarizationRequestAuth` 是 AgentSession 的私有方法（下划线开头，
 *      .d.ts 里只 declare、不给类型）。SDK 自己的 compact() 就是靠它解析
 *      summarization 请求要用的 { model, apiKey, headers, env }，我们复用同一条
 *      路径，省得自己再拼一遍 auth / baseUrl 解析。
 *   2. `@earendil-works/pi-ai/compat` 这个入口，它自己的 .d.ts 里就写着是临时
 *      兼容层，将来会随 ModelManager 迁移一起删掉。
 *
 * 所以整个函数包在 try/catch 里，方法不存在时用 typeof 判掉直接返回 null。任何
 * 一步失败都只是「拿不到 AI 标题」，调用方会保留截断的兜底标题，用户侧看不到任何
 * 报错。将来 SDK 把这两个口子改了，表现就是标题退回截断版本，不会崩。
 */

export class ClientSession {
	readonly clientId: string;
	private static liveClients = new Map<string, ClientSession>();

	/** Set by AgentService.attach: reflects the SERVICE-wide quiesce flag
	 *  (server draining — new work rejected). Default false for direct use. */
	isQuiesced: () => boolean = () => false;
	cwd: string;
	/** pi config dir (auth/models/skills). */
	private readonly agentDir: string;
	/** Persisted per-client UI state (last workspace + recent projects). */
	private readonly stateStore: ClientStateStore;
	private readonly thinkingDurationStore: ThinkingDurationStore;
	/** Open conversations — each owns its OWN runtime, so starting a new chat
	 *  or switching chats never interrupts an in-flight run. `runtime` and
	 *  `session` accessors below target the ACTIVE conversation. */
	private convs = new Map<string, Conversation>();
	private activeId = "";
	private convSeq = 0;
	private creatingConversation = false;
	/** One ModelRuntime shared by all conversations — the model chosen in the
	 *  top bar applies to every chat, not just the one that set it. Seeded by
	 *  the first conversation and reused by later ones. */
	private sharedModelRuntime:
		| Awaited<ReturnType<typeof createAgentSessionServices>>["modelRuntime"]
		| undefined;

	// -----------------------------------------------------------------------
	// -----------------------------------------------------------------------

	private settingsSvc!: SettingsService; // 构造函数里创建（需要 clientId/stateStore）
	/** How long a hard abort waits for session.abort() to make the run idle
	 *  before force-resetting the conversation (model streams that ignore the
	 *  abort signal would otherwise leave the chat stuck forever). */
	private static readonly HARD_ABORT_TIMEOUT_MS = 15_000;
	/** Extra settle window after session.abort() returns: the run is only
	 *  considered stopped once its agent_settled event arrives. If it doesn't
	 *  (model stream stuck before the run even started), force-reset. */
	private static readonly HARD_ABORT_SETTLE_MS = 8_000;
	/** Live AbortControllers of THIS client's running bash tool calls — aborting
	 *  them kills only the command (agent run and conversation continue). */

	/** Background-server tracking (port snapshots + 后台任务 panel state) —
	 *  自包含模块，见 bg-servers.ts。列表按 CLIENT 存活，不随对话切换/结束消失。 */
	/** 文件树 / 预览读写 / SCM 查询 / watcher —— 自包含模块，见 files-service.ts。 */
	private readonly files = new FilesService({
		emit: (msg) => this.emit(msg),
		isDisposed: () => this.disposed,
		getCwd: () => this.cwd,
		getActiveCwd: () => this.conv?.cwd ?? this.cwd,
	});
	private readonly bg = new BgServerTracker({
		emit: (msg) => this.emit(msg),
		flushSnapshot: () => this.flushSnapshot(),
		isDisposed: () => this.disposed,
		// 插件注册的常驻任务（host.registerBackgroundTask）并入同一「后台任务」面板。
		pluginTasks: () => this.pluginBgTasksProvider?.() ?? [],
	});

	/** index.ts 注入（经 AgentService 拷贝到每个新会话）：把 SDK 工具执行事件转发给
	 *  插件（PluginManager.emitToolEvent）。未设置时不做任何事。 */
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的 AI 工具（attach 时拷贝到每个新会话）。 */

	/** index.ts 注入：读取插件当前注册的斜杠命令（目录展示 + prompt 拦截执行）。 */

	/** index.ts 注入：读取插件注册的常驻后台任务（并入 bg_servers 面板）。 */
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	/** index.ts 注入：停止插件任务（kill_background_server with taskId）。 */
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	/** 上一轮注入会话的插件工具名集合（用于检测注销/移除）。 */

	/** The active conversation (all session operations target it). */
	private get conv(): Conversation {
		const conv = this.convs.get(this.activeId);
		if (!conv) throw new Error("no active conversation");
		return conv;
	}
	/** Runtime of the active conversation. */
	get runtime(): AgentSessionRuntime {
		return this.conv.runtime;
	}
	/** Session of the active conversation. */
	get conversationId(): string { return this.activeId; }
	get session(): AgentSession {
		return this.conv.session;
	}

	/** PTYs are owned by individual conversations; this getter targets the active one
	 * for compatibility with the existing terminal-panel dispatch path. */
	get terminals(): TerminalManager {
		return this.conv.terminals;
	}

	getTerminalManager(conversationId?: string): TerminalManager | undefined {
		return (conversationId ? this.convs.get(conversationId) : this.conv)?.terminals;
	}

	getTerminalCwd(conversationId?: string): string {
		return (conversationId ? this.convs.get(conversationId) : this.conv)?.cwd ?? this.cwd;
	}

	private makeTerminalManager(conversationId: string, cwd: string): TerminalManager {
		const mgr = new TerminalManager((msg) => this.emitTerminal(conversationId, msg), cwd);

		return mgr;
	}

	private emitTerminal(conversationId: string, msg: ServerMessage): void {
		// Background conversations keep collecting output in their own PTY buffer.
		// Do not stream it into the active xterm; push the retained window on switch.
		if (msg.type === "terminal_output" && conversationId !== this.activeId) return;
		if (msg.type === "terminal_output" || msg.type === "terminal_exit" || msg.type === "terminal_list") {
			this.emit({ ...msg, conversationId } as ServerMessage);
			return;
		}
		this.emit(msg);
	}

	private pushTerminals(conversation = this.conv): void {
		this.emit({
			type: "terminal_list",
			conversationId: conversation.id,
			terminals: conversation.terminals.list(),
		});
		for (const output of conversation.terminals.replay()) {
			this.emit({
				type: "terminal_output",
				conversationId: conversation.id,
				terminalId: output.terminalId,
				data: output.data,
			});
		}
	}

	async systemPromptState() {
		const session=this.session,cwd=this.cwd;await flushPromptReload(session);
		return getSystemPromptState(session,cwd,this.agentDir);
	}
	async savePromptFile(id:string,version:string,content:string|undefined,restore:boolean) {
		const path=writeSystemPromptFile(this.session,this.cwd,this.agentDir,id,version,content,restore);
		for(const client of ClientSession.liveClients.values())for(const conv of client.convs.values()){
			if(!promptUsesFile(conv.session,conv.cwd,client.agentDir,path))continue;
			await queuePromptReload(conv.session,()=>{if(!client.disposed&&client.activeId===conv.id){client.pushSettings();void client.pushSlashCommands();client.flushSnapshot();}});
		}
	}
	async retryPromptReload(){await flushPromptReload(this.session,true);}

	/** The FULL system prompt actually in effect right now (AgentSession getter,
	 *  includes native sections such as
	 *  project context, skills and tool guidance). Read-only view source for
	 *  the settings panel. */
	private effectiveSystemPrompt(): string {
		try {
			const sp = this.session.systemPrompt;
			return typeof sp === "string" ? sp : "";
		} catch {
			// Session not ready yet.
			return "";
		}
	}

	private pendingMcpReload = new Set<string>();
	private mcpStatus = new WeakMap<AgentSession, { text: string; pending: boolean }>();
	private async reloadMcpConversation(conv: Conversation): Promise<void> {
		const trust = new NativeMcpConfigService().isTrusted(conv.cwd);
		conv.session.settingsManager.setProjectTrusted(trust);
		await conv.session.reload();
		if (conv.id === this.activeId) await this.pushSlashCommands();
	}
	async nativeMcpRequest(msg: Extract<ClientMessage, { type: "native_mcp_request" }>): Promise<void> {
		const config = new NativeMcpConfigService();
		const requestSession = this.session;
		try {
			if (msg.cwd !== this.cwd || this.switchingWorkspace) throw new Error("Workspace unavailable");
			if (this.isQuiesced() && msg.action !== "get") throw new Error("Service draining");
			if (msg.action === "codemode") config.saveCodemode(this.cwd, msg.scope, msg.version ?? "", msg.codemode);
			if (msg.action === "save") config.save(this.cwd, msg.scope, msg.version ?? "", msg.document ?? {});
			if (msg.action === "trust") config.trust(this.cwd);
			if (msg.action === "radius") {
				if (!this.nativeModelRuntime.hasConfiguredAuth("radius")) throw new Error("Sign in to Radius first");
				const state = config.get(this.cwd, "global");
				const servers = (state.document.mcpServers ?? {}) as Record<string,Record<string,unknown>>;
				const existing = Object.entries(servers).find(([,entry]) => typeof entry.url === "string" && entry.url.replace(/\/+$/, "") === "https://radius.pi.dev/mcp");
				let name = existing?.[0] ?? "radius", index = 1; if (!existing) while (Object.hasOwn(servers,name)) name = `radius-${index++}`;
				const entry = { ...(existing?.[1] ?? {}), url: "https://radius.pi.dev/mcp", auth: { provider: "radius" } } as Record<string,unknown>; delete entry.oauth;
				config.save(this.cwd,"global",state.version,{ ...state.document, mcpServers: { ...servers, [name]: entry } });
				this.emit({ type: "notice", level: "info", text: `Radius MCP 已配置：${name}` });
			}
			if (msg.action === "command") {
				const runner = this.session.extensionRunner;
				const command = runner?.getCommand("mcp");
				if (!command || !/^(builtin:mcp|<inline:mcp>)$/.test(command.sourceInfo.path)) throw new Error("Official MCP command unavailable or replaced");
				if (this.session.isStreaming) throw new Error("Wait for the current task before managing connections");
				if (msg.name && !/^[\w.-]+$/.test(msg.name)) throw new Error("Invalid server name");
				await command.handler(msg.command === "status" ? "" : `${msg.command ?? ""} ${msg.name ?? ""}`, runner!.createCommandContext());
			}
			if (["save","trust","radius","codemode"].includes(msg.action)) {
				for (const cs of ClientSession.liveClients.values()) {
					for (const conv of cs.convs.values()) {
						if (msg.scope === "project" && msg.action !== "radius" && conv.cwd !== msg.cwd) continue;
						if (conv.session.isStreaming) cs.pendingMcpReload.add(conv.id);
						else await cs.reloadMcpConversation(conv);
					}
				}
			}
			if (this.cwd !== msg.cwd || this.session !== requestSession || this.switchingWorkspace) throw new Error("Workspace or conversation changed");
			const session = requestSession;
			const runner = session.extensionRunner;
			const command = runner?.getCommand("mcp");
			let cached = this.mcpStatus.get(session);
			if (!cached) { cached = { text: "", pending: false }; this.mcpStatus.set(session, cached); }
			if (command && /^(builtin:mcp|<inline:mcp>)$/.test(command.sourceInfo.path) && !cached.pending) {
				// Official /mcp waits for startup connections. Never block the settings reply on it.
				const context = runner!.createCommandContext(), target = cached;
				target.pending = true;
				void Promise.resolve(command.handler("", { ...context, mode: "rpc", ui: { ...context.ui, notify: (text: string) => { target.text = text; } } }))
					.catch(error => { target.text = String(error); }).finally(() => { target.pending = false; });
			}
			const statusText = cached.text;
			const tools = session.getAllTools().filter(tool => tool.name.startsWith("mcp__"));
			this.emit({ type: "native_mcp_result", requestId: msg.requestId, cwd: msg.cwd, state: config.get(msg.cwd,msg.scope),
				pending: [...ClientSession.liveClients.values()].some(cs => cs.pendingMcpReload.size > 0), tools: tools.map(tool => tool.name),
				toolInfo: tools.map(tool => ({ name: tool.name, exposure: tool.exposure, description: tool.description.slice(0, 2000), readOnly: tool.annotations?.readOnlyHint, destructive: tool.annotations?.destructiveHint })),
				servers: parseNativeMcpStatus(statusText), statusText,
				codemode: config.codemode(msg.cwd, msg.scope, session.settingsManager.getSettings().codemode),
				...(msg.action === "log" ? { log: config.log() } : {}),
			});
		} catch (error) { this.emit({ type: "native_mcp_result", requestId: msg.requestId, cwd: msg.cwd, error: (error as Error).message }); }
	}
	private coordinatePlan(conv: Conversation): void {
		const tree = conv.tree?.refresh();
		planSettings().coordinate(conv.session, !tree?.externallyModified && !tree?.verifying && !tree?.busy);
	}
	async setPlanEnabled(enabled: boolean, conversationId: string): Promise<void> {
		if (typeof enabled !== "boolean" || this.activeId !== conversationId || this.switchingWorkspace) throw new Error("Conversation changed");
		if (this.quiesceBlocked()) return;
		planSettings().set(enabled);
		for (const client of ClientSession.liveClients.values()) {
			for (const conv of client.convs.values()) client.coordinatePlan(conv);
			client.flushSnapshot();
		}
	}

	get nativeModelRuntime(): ModelRuntime { return this.runtime.services.modelRuntime; }
	readonly providerAuth = new ProviderAuthService(() => this.runtime.services.modelRuntime, message => this.emit(message), async () => { this.piCheckCache = null; await this.modelAdmin.listProviders(); await this.listModels(); this.flushSnapshot(); }, () => this.session.settingsManager.getOrCreateDeviceId());
	private get webUi(): WebUIContext { return this.conv.webUi; }
	private widgetsTimer: ReturnType<typeof setInterval> | null = null;
	/** Model-stall watchdog interval (see startStallTimer). */
	private stallTimer: ReturnType<typeof setInterval> | null = null;

	/** Connected sockets for this client (multiple tabs share the session). */
	private sinks = new Set<(msg: ServerMessage) => void>();
	private pendingNotices: ServerMessage[] = [];
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	/** Timestamp of the most recent message_delta push — while fresh, snapshots
	 *  use the slower STREAMING_SNAPSHOT_INTERVAL_MS cadence. */
	private lastDeltaAt = 0;
	private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
	private version = 0;
	/** Snapshot revision counter (see emitSnapshotNow / protocol snapshot_delta). */
	private snapRev = 0;
	/** Messages array as of the last emitted snapshot/delta — identity-walked
	 *  against the current array to detect append-only growth. */
	private emittedMessages: UiMessage[] | null = null;
	/** Conversation whose messages emittedMessages belongs to. A conversation
	 *  switch (set_cwd / new_chat / switch_*) must fall back to a FULL snapshot:
	 *  two empty conversations have identical (empty) arrays, so the identity
	 *  walk alone would misread the switch as "nothing changed" → delta. */
	private emittedConvId: string | null = null;
	/** snapRev value at which emittedMessages was captured. */
	private emittedRev = 0;
	/**
	 * Per-conversation serialization caches (stable message ids, UiMessage
	 * object cache, message-array signature, queue counts) live inside each
	 * Conversation — see Conversation above.
	 */
	private disposed = false;
	/** pi-config readiness check, cached briefly so 60ms snapshots don't hit disk. */
	private piCheckCache: { at: number; configured: boolean } | null = null;

	/** fs.watch on the currently-listed directory — file changes push an instant
	 *  refresh (`file_changed`) so the tree updates without waiting for the 10s
	 *  poll. Only the listed directory is watched (one level); navigating
	 *  re-watches the new target. fs.watch isn't available on every platform /
	 *  filesystem — failures silently fall back to the poll. */
	private fsWatcher: ReturnType<typeof watch> | null = null;
	private watchPath: string | null = null;
	/** fs.watch on the active repo's git dir — external changes (CLI commit,
	 *  IDE branch switch) push `scm_changed` so the panel refreshes itself.
	 *  One watcher per client session, re-targeted when the queried cwd
	 *  changes; failures (bare repo, unsupported fs) silently disable it. */
	private gitWatcher: ReturnType<typeof watch> | null = null;
	private gitWatchCwd: string | null = null;
	private gitDirtyTimer: ReturnType<typeof setTimeout> | null = null;
	private watchTimer: ReturnType<typeof setTimeout> | null = null;

	private constructor(
		clientId: string,
		cwd: string,
		agentDir: string,
		stateStore: ClientStateStore,
		thinkingDurationStore: ThinkingDurationStore,
	) {
		this.clientId = clientId;
		ClientSession.liveClients.set(clientId, this);

		this.cwd = cwd;
		this.agentDir = agentDir;
		this.stateStore = stateStore;
		this.thinkingDurationStore = thinkingDurationStore;
		this.settingsSvc = new SettingsService({
			clientId,
			stateStore,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			getSession: () => this.session,
			cwd: () => this.cwd,
			agentDir: () => this.agentDir,
			isStreaming: () => this.session.isStreaming,
			reloadSession: async () => {
				await this.session.reload();
				// reload() 会把 custom 工具重新加回活跃集——重放终端开关。

				await this.pushSlashCommands();
			},

			effectiveSystemPrompt: () => this.effectiveSystemPrompt(),
		});

		this.modelAdmin = new ModelAdminService({
			agentDir,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			modelRuntime: () => this.runtime.services.modelRuntime,
			invalidatePiConfig: () => {
				this.piCheckCache = null;
			},
			pushModels: async () => this.listModels(),
		});
		// Prune dead background tasks every 30s (only spawns netstat/lsof while
		// the list is non-empty). unref: must not keep the process alive.
		this.bg.start();
	}

	static async create(
		clientId: string,
		cwd: string,
		stateStore: ClientStateStore,
		thinkingDurationStore: ThinkingDurationStore,
	): Promise<ClientSession> {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

		const cs = new ClientSession(clientId, cwd, agentDir, stateStore, thinkingDurationStore);
		const conversationId = cs.nextConversationId();
		const terminals = cs.makeTerminalManager(conversationId, cwd);
		const runtime = await createAgentSessionRuntime(cs.makeRuntimeFactory(), {
			cwd,
			agentDir,
			// Resume the most recent session for this project — the SDK default
			// per-project dir (<agentDir>/sessions/--<cwd>--/, shared with the
			// pi CLI/TUI) — or start a fresh one on first visit.
			sessionManager: SessionManager.continueRecent(cwd),
		});
		// First conversation = the resumed session; it also seeds the shared
		// ModelRuntime that every later conversation reuses.
		cs.sharedModelRuntime = runtime.services.modelRuntime;
		const conv = cs.makeConversation(runtime, conversationId, terminals);
		cs.convs.set(conv.id, conv);
		cs.activeId = conv.id;
		for (const d of runtime.diagnostics) {
			if (d.type !== "info") {
				cs.pendingNotices.push({
					type: "notice",
					level: d.type,
					text: d.message,
				});
			}
		}
		await cs.bindSession();
		return cs;
	}

	/**
	 * Factory for cwd-bound runtimes. All conversations share ONE ModelRuntime
	 * (the model choice is client-wide), so later conversations reuse the
	 * instance created with the first one.
	 */
	private makeRuntimeFactory(): CreateAgentSessionRuntimeFactory {
		return async ({ cwd, sessionManager }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: this.agentDir,
				modelRuntime: this.sharedModelRuntime,
				settingsManager: conversationSettings(cwd, this.agentDir),
				resourceLoaderOptions: { extensionFactories: nativeToolExtensions() },
			});
			const created = await createAgentSessionFromServices({ services, sessionManager });
			return { ...created, services, diagnostics: services.diagnostics };
		};
	}

	/** Allocate a stable conversation id before constructing its runtime/tools. */
	private nextConversationId(): string {
		return `c${++this.convSeq}`;
	}

	/** Wrap a fresh runtime as a new conversation record. */
	private makeConversation(
		runtime: AgentSessionRuntime,
		id: string,
		terminals: TerminalManager,
	): Conversation {
		return {
			id,
			recovery: {},
			webUi: new WebUIContext(msg => this.emit(msg), id, () => `${runtime.cwd} · ${this.convs.get(id)?.title ?? conversationTitle(runtime.session)}`),
			title: runtime.session.sessionManager.getSessionName() || conversationTitle(runtime.session),

			runtime,
			session: runtime.session,
			cwd: runtime.cwd,
			createdAt: Date.now(),
			// A brand-new conversation is not yet in the running list — it enters
			// only when it is displaced to the background while still streaming.
			listed: false,
			promptedSinceActive: false,
			lastActiveAt: Date.now(),
			lastSdkEventAt: Date.now(),
			lastTaskEndedAt: undefined,
			stallNoticed: false,
			runningToolNames: new Map(),
			toolsExecutedSincePrompt: false,

			deltaSeq: 0,
			thinkingTimings: new ThinkingTimings(),
			terminals,
			msgIds: new Map(),
			nextMsgId: 1,
			userSeqByTs: new Map(),
			uiMessageCache: new Map(),
			lastMessagesSig: "",
			lastMessagesArray: [],
			queueSteering: [],
			queueFollowUp: [],
			toolStartTimes: new Map(),

		};
	}

	/** Summaries of conversations currently streaming — captured at shutdown
	 *  so the next attach can tell the user their run was interrupted. */
	streamingSummaries(): { title: string; cwd: string }[] {
		const out: { title: string; cwd: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.session.isStreaming) out.push({ title: conv.title, cwd: conv.cwd });
		}
		return out;
	}

	/** Tell the user about runs lost to the last server restart (once). */
	notifyInterrupted(
		list: { title: string; cwd: string; at: number }[] | undefined,
	): void {
		if (!list || list.length === 0) return;
		const names = list
			.map((r) => `「${r.title}」（${r.cwd}）`)
			.join("、");
		this.pendingNotices.push({
			type: "notice",
			level: "warning",
			text: `上次服务重启时有 ${list.length} 个进行中的对话被中断：${names}。可在历史对话中恢复继续。`,
		});
	}

	/** Add a socket to this client's broadcast set; flushes buffered startup notices. */
	attachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.add(send);
		for (const result of this.recalledQueues.values()) send(result);

		this.providerAuth.replay();
		for (const conv of this.convs.values()) {
			conv.webUi.replayDialogs(send);
			conv.webUi.replayTitle(send);
			send({ type: "widgets", conversationId: conv.id, widgets: conv.webUi.snapshot() });
			send({ type: "statuses", conversationId: conv.id, statuses: conv.webUi.statusSnapshot() });
		}
		for (const conv of this.convs.values()) if (conv.stallNoticed && conv.session.isStreaming) send({ type: "agent_silence", conversationId: conv.id, phase: "silent", since: conv.lastSdkEventAt, activity: conv.runningToolNames.size ? "tool" : "model" });
		for (const msg of this.pendingNotices) send(msg);
		this.pendingNotices = [];
		// Replay current extension widgets (setWidget may have fired during
		// session creation, before any socket was attached).

		// Reconnect: push the current project's running-conversation list so the
		// left panel shows every background chat (a fresh socket never got the
		// newChat/switch pushes).
		this.emitConversations();
		// Reconnect: same for the slash-command catalog (the picker needs it even
		// before the client asks).
		void this.pushSlashCommands();
		// Reconnect: push the remembered goal prefs (model choice, rounds cap,
		// locked) so the goal bar restores them on reload — "全局记忆".

		// Reconnect: push the settings panel state (prompt text/mode, skill &
		// extension toggles, saved presets).
		this.pushSettings();
		// Reconnect: push the background-task list — it must survive reconnects
		// and outlive the conversation that started the tasks.
		this.bg.push();
		// PTYs are conversation-owned and survive a socket reconnect.
		this.pushTerminals();
	}

	detachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.delete(send);
		// PTYs intentionally survive a socket drop: they are owned by the
		// conversation and can be inspected after reconnecting. Only conversation
		// disposal or server shutdown kills them.
		if (this.sinks.size === 0) {
			this.files.unwatchDir();
		}
	}

	/** Broadcast to every connected socket of this client. */
	private emit(msg: ServerMessage): void {
		if (this.disposed) return;
		for (const sink of [...this.sinks]) sink(msg);
	}

	/** (Re)attach event plumbing to the ACTIVE conversation's session. */
	private boundUiSessions = new WeakSet<AgentSession>();
	private async bindSession(conv = this.conv): Promise<void> {
		conv.unsubscribe?.();
		if (conv.session !== conv.runtime.session) {
			conv.webUi.dispose();
			conv.webUi = new WebUIContext(msg => this.emit(msg), conv.id, () => `${conv.cwd} · ${conv.title}`);
		}
		conv.session = conv.runtime.session;
		conv.tree ??= new SessionTreeController({
			conversationId: conv.id, runtime: () => conv.runtime,
			active: () => this.activeId === conv.id && this.convs.get(conv.id) === conv,
			admitted: () => !this.quiesceBlocked(),
			emit: message => this.emit(message),
			changed: () => { this.coordinatePlan(conv); this.scheduleSnapshot(); this.scheduleSessionsRefresh(); },
			replaced: async () => { conv.treeProjectionRevision = undefined; conv.uiMessageCache.clear(); conv.title = conv.runtime.session.sessionManager.getSessionName() || conversationTitle(conv.runtime.session); await this.bindSession(conv); this.invalidateLists(); this.flushSnapshot(true); },
			summary: operation => { conv.recovery = { ...conv.recovery, branch: operation, summary: !operation && conv.recovery.summary?.source === "branchSummary" ? undefined : conv.recovery.summary }; this.flushSnapshot(); },
		});
		conv.tree.bindFile();


		if (!this.boundUiSessions.has(conv.session)) {
			this.boundUiSessions.add(conv.session);
			const session = conv.session;
			const reload = session.reload.bind(session);
			session.reload = async options => {
				conv.webUi.dispose();
				conv.webUi = new WebUIContext(msg => this.emit(msg), conv.id, () => `${conv.cwd} · ${conv.title}`);
				await reload({ ...options, beforeSessionStart: async () => {
					session.extensionRunner.setUIContext(conv.webUi, "rpc");
					await options?.beforeSessionStart?.();
				} });
				this.coordinatePlan(conv);
			};
		}

		await conv.session.bindExtensions({
			mode: "rpc",
			uiContext: conv.webUi,
			onError: (err) => {
				this.emit({ type: "notice", conversationId: conv.id, level: "error", text: err.error });
			},
		});

		this.coordinatePlan(conv);
		const unsubscribe = conv.session.subscribe((event) =>
			this.onEvent(conv, event),
		);
		conv.unsubscribe = unsubscribe;
		this.scheduleSnapshot();
		this.webUi.refresh();
		this.startWidgetsTimer();
		this.startStallTimer();

	}

	/** Poll extension widgets so TUI-only overlays (e.g. rpiv-todo) stay live. */
	private startWidgetsTimer(): void {
		if (this.widgetsTimer) return;
		this.widgetsTimer = setInterval(() => {
			if (!this.disposed) for (const conv of this.convs.values()) conv.webUi.refresh();
		}, WIDGET_REFRESH_MS);
	}

	/** Report a quiet model or tool as conversation-scoped state. The WebSocket
	 * heartbeat is separate: a live socket does not imply a live model request. */
	private startStallTimer(): void {
		if (this.stallTimer || STALL_NOTIFY_MS === 0) return;
		this.stallTimer = setInterval(() => {
			if (this.disposed) return;
			const now = Date.now();
			for (const conv of this.convs.values()) {
				if (
					!isRecovering(conv.recovery) &&
					!conv.stallNoticed &&
					conv.session.isStreaming &&
					now - conv.lastSdkEventAt > STALL_NOTIFY_MS
				) {
					conv.stallNoticed = true;
					this.emit({ type: "agent_silence", conversationId: conv.id, phase: "silent", since: conv.lastSdkEventAt, activity: conv.runningToolNames.size ? "tool" : "model" });
				}
			}
		}, 30_000);
	}

	/** Cancel a tool's watchdog — called when the tool finishes normally. */

	/** Cancel every watchdog of a conversation (removeConversation / dispose). */

	private onEvent(conv: Conversation, event: AgentSessionEvent): void {
		const contextTokens = event.type === "compaction_start" ? conv.session.getContextUsage()?.tokens ?? undefined : event.type === "compaction_end" && event.result ? conv.session.messages.reduce((total, message) => total + estimateTokens(message), 0) : undefined;
		conv.recovery = recoveryEvent(conv.recovery, event, Date.now(), contextTokens);
		if (event.type === "agent_settled" || event.type === "message_end") conv.tree?.refresh();

		// Any SDK event proves the run is alive — feeds the stall watchdog below.
		if (conv.stallNoticed) this.emit({ type: "agent_silence", conversationId: conv.id, phase: "active", since: Date.now(), activity: conv.runningToolNames.size ? "tool" : "model" });
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		switch (event.type) {
			case "bash_execution_update": {
				if (event.id) {
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.id,
						toolName: "bash",
						delta: event.delta,
					});
				}
				break;
			}
			case "tool_execution_start": {
				if (event.parentToolCallId) this.emit({
					type: "tool_status", conversationId: conv.id, parentToolCallId: event.parentToolCallId,
					toolCallId: event.toolCallId, toolName: event.toolName, isError: false, running: true,
					argumentsText: JSON.stringify(event.args)?.slice(0, 20_000),
				});
				conv.runningToolNames.set(event.toolCallId, event.toolName);
				conv.toolsExecutedSincePrompt = true;
				// Record the moment the tool actually starts so tool_status can
				// report real execution time (vs. time spent waiting on the model).
				conv.toolStartTimes.set(event.toolCallId, Date.now());
				// Snapshot listeners before a bash run — the post-run diff catches
				// servers the agent started in the background.
				if (event.toolName === "bash") {
					this.bg.snapshotBefore();
				}

				// 插件扩展点：工具开始执行（异常由 emitToolEvent 隔离）。
				this.onToolEvent?.({ phase: "start", toolName: event.toolName, conversationId: conv.id });
				break;
			}
			case "tool_execution_end": {
				conv.runningToolNames.delete(event.toolCallId);
				const startedAt = conv.toolStartTimes.get(event.toolCallId);
				conv.toolStartTimes.delete(event.toolCallId);

				// Bash finished — wait briefly for background servers to bind their
				// ports, then diff against the pre-run snapshot and record them.
				if (event.toolName === "bash") void this.bg.trackAfterBash();
				const durationMs =
					startedAt !== undefined ? Date.now() - startedAt : undefined;
				// 插件扩展点：工具结束执行（带耗时与错误标志）。
				this.onToolEvent?.({
					phase: "end",
					toolName: event.toolName,
					conversationId: conv.id,
					...(durationMs !== undefined ? { durationMs } : {}),
					isError: event.isError,
				});
				const exitCode = toolExitCode(event.result, event.isError);
				this.emit({
					type: "tool_status",
					conversationId: conv.id,
					running: false,
					parentToolCallId: event.parentToolCallId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					exitCode,
					durationMs,
				});
				break;
			}
			case "tool_execution_update": {
				const update = toolOutputUpdate(event.partialResult);
				const codemode = event.toolName === "codemode" ? codemodeDetails((event.partialResult as { details?: unknown })?.details) : undefined;
				if (update || codemode) {
					this.emit({
						type: "tool_delta",
						parentToolCallId: event.parentToolCallId,
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						delta: "",
						...update,
						codemode,
					});
				}
				break;
			}
			case "queue_update":
				conv.queueSteering = event.steering.map(text => text.length > 2000 ? text.slice(0, 2000) + "…" : text);
				conv.queueFollowUp = event.followUp.map(text => text.length > 2000 ? text.slice(0, 2000) + "…" : text);
				break;
			// A run finished or a new entry was persisted — keep the session list fresh
			// (new chat + first message, completed turns, compaction, etc.).
			case "agent_settled": {
				this.coordinatePlan(conv);
				if (this.pendingMcpReload.delete(conv.id)) void this.reloadMcpConversation(conv).catch(error => this.emit({ type: "notice", level: "error", text: `MCP reload failed: ${error.message}` }));

				conv.lastTaskEndedAt = Date.now();
				this.scheduleSessionsRefresh();

				// Deferred settings reload: settings (system prompt / skills /
				// extensions) changed while the run was streaming — applying now
				// would have torn down the in-flight run.
				if (this.settingsSvc.hasPendingReload() && !this.disposed) {
					this.settingsSvc.consumePendingReload();
					void this.applySettingsReload();
				}
				break;
			}
			case "entry_appended":
				this.scheduleSessionsRefresh();
				break;
			case "message_end": {
				if (event.message.role === "assistant") {
					conv.thinkingTimings.finish(event.message.timestamp);
					this.thinkingDurationStore.save(conv.session.sessionFile, event.message.timestamp, conv.thinkingTimings.finishedDurations(event.message.timestamp));
				}
				break;
			}
			case "message_update": {
				conv.thinkingTimings.observe(event.message.timestamp, event.assistantMessageEvent);
				// Live assistant-message increment, deliberately OUTSIDE the snapshot
				// channel: send() drops snapshots under backpressure (big sessions),
				// but this small message must always get through or the UI freezes on
				// stale state. Only the ACTIVE conversation streams to the browser —
				// background conversations would clobber the streaming view; their
				// state arrives via snapshot when switched to.
				if (conv.id !== this.conv.id) break;
				const ame = event.assistantMessageEvent;
				const m = event.message as { timestamp?: number };
				this.lastDeltaAt = Date.now();
				this.emit({
					type: "message_delta",
					conversationId: conv.id,
					seq: ++conv.deltaSeq,
					// Must match serializeStreamingMessage()'s stable id so deltas
					// patch onto the snapshot's streamingMessage and reconcile.
					messageId: `stream-${m?.timestamp ?? 0}`,
					usage: (() => {
						try {
							const t = this.session.getSessionStats().tokens;
							return t ? { input: t.input, output: t.output, total: t.total } : null;
						} catch {
							return null;
						}
					})(),
					// Strip `partial` (the cumulative message): re-serializing it per
					// token is exactly what we're trying to avoid. The next snapshot
					// carries the authoritative full message anyway.
					assistantMessageEvent: {
						type: ame.type,
						contentIndex: "contentIndex" in ame ? ame.contentIndex : undefined,
						delta: "delta" in ame ? ame.delta : undefined,
					},
				});
				break;
			}
			default:
				break;
		}
		// Snapshot checkpoint policy: deltas carry live rendering during streaming;
		// full snapshots are reconciliation checkpoints taken immediately at
		// run/tool boundaries and on a slow timer otherwise.
		if (event.type === "agent_settled" || event.type === "tool_execution_end") {
			this.flushSnapshot();
		} else {
			this.scheduleSnapshot();
		}
	}

	/** Debounced push of the persisted session list + open conversations. */
	private scheduleSessionsRefresh(): void {
		if (this.sessionsTimer) return;
		this.sessionsTimer = setTimeout(() => {
			this.sessionsTimer = null;
			if (this.disposed) return;
			for (const conv of [...this.convs.values()]) {
				if (conv.wiki && conv.id !== this.activeId && !conv.session.isStreaming && conv.terminals.list().length === 0) this.removeConversation(conv.id);
			}
			this.invalidateLists();
			this.emitConversations();
			void this.pushSessions();
		}, 800);
		// pushSessions no-ops unless the client opted in via list_sessions.
	}

	private toolContentIds = new WeakMap<object, number>();
	private toolContentSeq = 0;
	/** Serialize a persisted message with a STABLE id + cached object reference. */
	private serializeCached(m: AgentMessage): UiMessage | null {
		const conv = this.conv;
		// toolResult messages are keyed by toolCallId; everything else by
		// role+timestamp. A single prompt can emit several same-role messages
		// within the SAME millisecond (multiple attachment asides), so the
		// timestamp alone collides in the cache and only the first one renders
		// — append a cheap content fingerprint to keep them distinct while
		// staying stable across snapshots (content never changes once persisted).
		const key =
			m.role === "toolResult"
				? `t:${m.toolCallId}`
				: `${m.role}:${m.timestamp}:${contentFingerprint(m)}`;
		let n = conv.msgIds.get(key);
		if (n === undefined) {
			n = conv.nextMsgId++;
			conv.msgIds.set(key, n);
		}
		// Persisted content is immutable; inspect mutable projected metadata without
		// rebuilding or hashing the potentially very large output on every snapshot.
		let toolRevision = "";
		if (m.role === "toolResult") {
			let contentId = this.toolContentIds.get(m.content);
			if (contentId === undefined) { contentId = ++this.toolContentSeq; this.toolContentIds.set(m.content, contentId); }
			const metadata = serializeMessage({ ...m, content: [] }, n);
			toolRevision = `:${contentId}:${createHash("sha256").update(JSON.stringify(metadata)).digest("hex")}`;
		}
		const cacheKey = `${key}#${n}${toolRevision}`;
		const cached = conv.uiMessageCache.get(cacheKey);
		if (cached) return cached;
		// User-message id suffix is a 1-based count of user messages sharing
		// this timestamp (that's what resolveUserMessageEntryId() expects). n is
		// a global per-conversation counter across ALL roles, so it can't be
		// reused as the seq — otherwise editing anything but the first question
		// fails to resolve ("找不到要编辑的消息").
		let seq = n;
		if (m.role === "user") {
			const ts = m.timestamp ?? 0;
			seq = (conv.userSeqByTs.get(ts) ?? 0) + 1;
			conv.userSeqByTs.set(ts, seq);
		}
		const measured = conv.thinkingTimings.annotate(serializeMessage(m, seq), m.timestamp ?? 0);
		const msg = this.thinkingDurationStore.annotate(measured, conv.session.sessionFile, m.timestamp ?? 0);
		if (msg) {
			if (m.role === "toolResult") msg.toolOutputUrl = `/api/tool-output?${new URLSearchParams({ clientId: this.clientId, conversationId: conv.id, toolCallId: m.toolCallId })}`;
			conv.uiMessageCache.set(cacheKey, msg);
			// Bound the cache (marathon sessions otherwise grow without limit;
			// single messages can reach TEXT_CAP = 200K chars). Map iteration is
			// insertion order, so dropping from the front evicts the oldest —
			// recent messages (the ones every snapshot touches) always survive.
			// Safe: a miss just recomputes an identical object on next access.
			let excess = conv.uiMessageCache.size - UI_MESSAGE_CACHE_CAP;
			while (excess-- > 0) {
				const oldest = conv.uiMessageCache.keys().next().value;
				if (oldest === undefined) break;
				conv.uiMessageCache.delete(oldest);
			}
		}
		return msg;
	}

	/** Current messages array (with the existing sig-reuse optimization).
	 *  Element objects are reference-stable (serializeCached cache), which is
	 *  what lets emitSnapshotNow detect append-only growth via identity walk. */
	private currentMessages(): UiMessage[] {
		const conv = this.conv;
		const tree = conv.tree?.refresh();
		const messageKey = (m: AgentMessage) => m.role === "toolResult" ? `t:${m.toolCallId}` : `${m.role}:${m.timestamp}:${contentFingerprint(m)}`;
		if (tree && conv.treeProjectionRevision !== tree.revision) {
			conv.treeEntryIds = new Map();
			for (const entry of conv.session.sessionManager.buildSessionProjection().entries) for (const m of entry.messages) {
				const key = messageKey(m), ids = conv.treeEntryIds.get(key) ?? [];
				ids.push(entry.sourceEntry.id); conv.treeEntryIds.set(key, ids);
			}
			conv.treeProjectionRevision = tree.revision;
		}
		const occurrences = new Map<string, number>();
		const rawMessages = conv.session.agent.state.messages
			.map((m) => {
				const value = this.serializeCached(m);
				const key = messageKey(m), index = occurrences.get(key) ?? 0; occurrences.set(key, index + 1);
				return value ? conv.tree?.decorate(value, conv.treeEntryIds?.get(key)?.[index]) ?? value : null;
			})
			.filter((m): m is NonNullable<typeof m> => m !== null);
		// Reuse the previous array when nothing changed: the element objects are
		// cached (reference-stable) anyway, and a stable array reference lets the
		// frontend memoize derived maps instead of rebuilding them every 60ms.
		const sig = rawMessages.map((m) => m.id).join("\u0001");
		const messages =
			conv.lastMessagesArray.length === rawMessages.length && rawMessages.every((m, i) => m === conv.lastMessagesArray[i]) ? conv.lastMessagesArray : rawMessages;
		conv.lastMessagesSig = sig;
		conv.lastMessagesArray = messages;
		return messages;
	}

	/** Build every UiState field EXCEPT messages (the expensive part). */
	private buildLightState(
		rev: number,
		messages: UiMessage[],
	): Omit<UiState, "messages" | "rev"> & { rev: number } {
		const conv = this.conv;
		const state = conv.session.agent.state;
		const model = state.model;
		const streamingMessage = state.streamingMessage
			? conv.thinkingTimings.annotate(serializeStreamingMessage(state.streamingMessage), state.streamingMessage.timestamp ?? 0)
			: null;
		let stats: UiState["stats"] = {
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
			contextParts: null,
		};
		try {
			const s = this.session.getSessionStats();
			stats = {
				totalMessages: s.totalMessages,
				tokens: s.tokens,
				cost: s.cost,
				contextUsage: s.contextUsage
					? {
							tokens: s.contextUsage.tokens,
							contextWindow: s.contextUsage.contextWindow,
							percent: s.contextUsage.percent,
						}
					: stats.contextUsage,
				contextParts: estimateContextParts(this.session.messages, this.session.systemPrompt, s.contextUsage?.tokens ?? null),
			};
		} catch {
			// stats are best-effort
		}
		return {
			planSettings: planSettings().state(conv.session),
			tree: conv.tree?.refresh(),
			clientId: this.clientId,
			cwd: this.cwd,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			conversationId: this.activeId,
			cwdEvents: this.session.sessionManager.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "pi-web-ui:cwd-switch" && typeof (entry.data as { cwd?: unknown } | undefined)?.cwd === "string")
				.slice(-40)
				.map((entry) => ({ cwd: (entry as { data: { cwd: string } }).data.cwd, timestamp: Date.parse(entry.timestamp) })),
			rev,
			// The in-progress assistant message lives in state.streamingMessage
			// (the SDK only pushes it into state.messages at message_end). Surfacing
			// it here is what makes thinking + text stream into the browser at
			// ~60ms granularity instead of appearing only when the turn finishes.
			streamingMessage,
			taskProgress: deriveTaskProgress(conv.id, taskHistoryFromSession(conv.session.sessionManager, (message) => this.serializeCached(message)) ?? messages, streamingMessage, conv.session.isStreaming, conv.lastTaskEndedAt),
			isStreaming: this.session.isStreaming,
			recovery: recoverySnapshot(conv.recovery),
			runSettings: { autoCompaction: conv.session.autoCompactionEnabled, autoRetry: conv.session.autoRetryEnabled },
			model: model
				? {
						id: model.id,
						name: model.name,
						provider: model.provider,
						vision: model.input?.includes("image") ?? false,
				  }
				: null,
			...(this.session.routedModel ? { routedModel: {
				id: this.session.routedModel.model.id, name: this.session.routedModel.model.name,
				provider: this.session.routedModel.model.provider,
				vision: this.session.routedModel.model.input.includes("image"),
				thinkingLevel: this.session.routedModel.thinkingLevel,
			} } : {}),
			thinkingLevel: state.thinkingLevel,
			// Only the levels the current model actually supports — the SDK clamps
			// anything else, so the UI must not offer (or must disable) the rest.
			availableThinkingLevels: this.session.getAvailableThinkingLevels(),
			queue: { steering: conv.queueSteering, followUp: conv.queueFollowUp },
			errorMessage: state.errorMessage,
			tools: state.tools.map((t) => t.name),
			version: ++this.version,
			piConfigured: this.isPiConfigured(),
			piAgentInstalled: this.isPiCliInstalled(),
			stats,
		};
	}

	/** Emit one snapshot update — incremental when possible, full otherwise.
	 *
	 *  Persisted messages are content-immutable with reference-stable objects
	 *  (serializeCached), so an IDENTITY WALK over the previous array detects
	 *  append-only growth in O(n) pointer compares. Appends travel as
	 *  snapshot_delta carrying only the new tail + light fields; any mid-array
	 *  change/truncation (switch session, edit fork, compaction) or a forced
	 *  resync falls back to a full snapshot. The 10MB-stringify-per-checkpoint
	 *  cost of big sessions collapses to a few hundred bytes for the common
	 *  "nothing but stats/version changed" checkpoint. */
	private emitSnapshotNow(forceFull = false): void {
		if (this.disposed) return;
		const cur = this.currentMessages();
		const prev = this.emittedMessages;
		let incremental =
			!forceFull &&
			prev !== null &&
			this.emittedConvId === this.activeId &&
			prev.length <= cur.length;
		if (incremental && prev) {
			for (let i = 0; i < prev.length; i++) {
				if (prev[i] !== cur[i]) {
					incremental = false;
					break;
				}
			}
		}
		const rev = ++this.snapRev;
		if (incremental && prev) {
			const baseRev = this.emittedRev;
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot_delta",
				conversationId: this.activeId,
				rev,
				baseRev,
				appended: cur.slice(prev.length),
				state: this.buildLightState(rev, cur),
			});
		} else {
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot",
				state: { ...this.buildLightState(rev, cur), messages: cur },
			});
		}
	}

	/** Resolve a browser-bridged dialog (select/confirm/input) for this session. */
	cancelRecovery(conversationId: string, operationId: string): void {
		const conv = this.convs.get(conversationId);
		if (!conv || conversationId !== this.activeId) return;
		const { compaction, retry, summary, branch } = conv.recovery;
		if (branch?.id === operationId) conv.session.abortBranchSummary();
		else if (summary?.id === operationId) { if (summary.source === "branchSummary") conv.session.abortBranchSummary(); else conv.session.abortCompaction(); }
		else if (compaction?.id === operationId) conv.session.abortCompaction();
		else if (retry?.id === operationId) conv.session.abortRetry();
	}
	async treeRequest(message: TreeRequest): Promise<void> {
		const conv = this.convs.get(message.conversationId);
		if (!conv?.tree || conv.id !== this.activeId) {
			this.emit({ type: "tree_navigate_result", conversationId: message.conversationId, reqId: message.reqId, status: "error", error: "只能操作当前活动对话。" }); return;
		}
		await conv.tree.request(message);
		this.coordinatePlan(conv);
		this.flushSnapshot(true);
	}
	setRunSettings(message: Extract<ClientMessage, { type: "set_run_settings" }>): void {
		const conv = this.convs.get(message.conversationId);
		if (!conv || conv.id !== this.activeId) return;
		setConversationRunSettings(conv.session.settingsManager, message);
		this.flushSnapshot();
	}

	private readonly recalledQueues = new Map<string, Extract<ServerMessage, { type: "queue_recalled" }>>();
	acknowledgeQueueRecall(conversationId: string, requestId: string): void {
		if (this.recalledQueues.get(requestId)?.conversationId === conversationId) this.recalledQueues.delete(requestId);
	}
	recallQueue(conversationId: string, requestId: string): void {
		const conv = this.convs.get(conversationId);
		if (!conv || conversationId !== this.activeId) return;
		const previous = this.recalledQueues.get(requestId);
		if (previous) { this.emit(previous); return; }
		if (this.recalledQueues.size >= 8) { this.emitNotice("warning", "请先接收已撤回的消息，再继续撤回。"); return; }
		const restored = recallPending(conv.session);
		const result: Extract<ServerMessage, { type: "queue_recalled" }> = { type: "queue_recalled", conversationId, requestId, text: [...restored.steering, ...restored.followUp].join("\n\n"), images: restored.images };
		this.recalledQueues.set(requestId, result);
		this.emit(result);
		this.flushSnapshot();
	}

	private toolResultForDownload(conversationId: string, toolCallId: string) {
		const conv = this.convs.get(conversationId);
		if (!conv) throw Object.assign(new Error("Output access denied"), { code: "EACCES" });
		// Context projection omits pre-compaction records. Native entries retain them.
		const result = conv.session.sessionManager.getEntries().flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId ? [entry.message] : []).at(-1)
			?? conv.session.messages.find(m => m.role === "toolResult" && m.toolCallId === toolCallId);
		if (!result || result.role !== "toolResult") throw Object.assign(new Error("Output access denied"), { code: "EACCES" });
		return { conv, result };
	}
	async listToolOutputs(conversationId: string, toolCallId: string) {
		const { conv, result } = this.toolResultForDownload(conversationId, toolCallId);
		const path = nativeToolDetails(result.toolName, result)?.fullOutputPath;
		const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		return toolOutputManifest(conv.cwd, result.toolName, text, typeof path === "string" ? path : undefined);
	}
	async downloadToolOutput(conversationId: string, toolCallId: string, outputId?: string) {
		const { conv, result } = this.toolResultForDownload(conversationId, toolCallId);
		const path = nativeToolDetails(result.toolName, result)?.fullOutputPath;
		if (outputId && !(typeof path === "string" && outputId === toolOutputId(path))) {
			const output = (await this.listToolOutputs(conversationId, toolCallId)).find(output => output.id === outputId);
			if (!output) throw Object.assign(new Error("Output access denied"), { code: "EACCES" });
			return { name: output.name, handle: await openToolOutput(conv.cwd, output.path) };
		}
		if (typeof path === "string") return { name: path.split(/[\\/]/).pop()!, handle: await openToolOutput(conv.cwd, path) };
		return { name: "tool-output.txt", handle: { createReadStream: () => Readable.from(result.content.filter(part => part.type === "text").map(part => part.text + "\n")) } };
	}

	resolveDialog(conversationId: string, id: string, value: string | boolean | null): void {
		if (conversationId !== this.activeId) return;
		this.convs.get(conversationId)?.webUi.resolveDialog(id, value);
	}

	/**
	 * Whether the pi agent config looks ready: the agent dir exists and
	 * auth.json has at least one provider credential. Cached for 2s.
	 */
	isPiConfigured(): boolean {
		const now = Date.now();
		const cached = this.piCheckCache;
		if (cached && now - cached.at < 2000) return cached.configured;
		let configured = false;
		try {
			const authPath = join(this.agentDir, "auth.json");
			if (existsSync(authPath)) {
				const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
					string,
					unknown
				>;
				configured =
					typeof data === "object" &&
					data !== null &&
					Object.keys(data).length > 0;
			}
		} catch {
			configured = false;
		}
		this.piCheckCache = { at: now, configured };
		return configured;
	}

	/**
	 * Whether the pi CLI binary is installed and runnable (`pi --version`
	 * probe). Cached machine-wide (same binary for every client) for 10s —
	 * the check is only rerun after install or when the cache expires.
	 */
	private static piCliProbe: { at: number; installed: boolean } | null = null;
	private static readonly PI_CLI_PROBE_TTL_MS = 10_000;

	private isPiCliInstalled(): boolean {
		const now = Date.now();
		const cached = ClientSession.piCliProbe;
		if (cached && now - cached.at < ClientSession.PI_CLI_PROBE_TTL_MS)
			return cached.installed;
		let installed = false;
		try {
			const res = spawnSync("pi", ["--version"], {
				timeout: 5000,
				stdio: "ignore",
				// Windows: `pi` resolves to a pi.cmd shim — spawnSync can only
				// exec those through a shell (else ENOENT).
				shell: process.platform === "win32",
			});
			installed = !res.error && res.status === 0;
		} catch {
			installed = false;
		}
		ClientSession.piCliProbe = { at: now, installed };
		return installed;
	}

	private static invalidatePiCliProbe(): void {
		ClientSession.piCliProbe = null;
	}

	/**
	 * Run a command async, collecting stdout+stderr; kills on timeout.
	 * Never throws / never crashes the server: spawn errors (ENOENT etc.)
	 * resolve with code -1 so callers can report them as notices.
	 */
	private runAsync(
		cmd: string,
		args: string[],
		timeoutMs: number,
		cwd?: string,
	): Promise<{ code: number | null; out: string }> {
		return new Promise((resolve) => {
			let p;
			try {
				p = spawn(cmd, args, {
					...(cwd ? { cwd } : {}),
					stdio: ["ignore", "pipe", "pipe"],
					// Windows: npm and friends are .cmd shims — Node can only exec
					// them through the shell (otherwise spawn npm → ENOENT).
					shell: process.platform === "win32",
				});
			} catch (err) {
				resolve({ code: -1, out: String(err) });
				return;
			}
			let out = "";
			let settled = false;
			const done = (code: number | null, text?: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(t);
				resolve({ code, out: text ?? out });
			};
			const t = setTimeout(() => p.kill(), timeoutMs);
			p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
			p.stderr?.on("data", (d: Buffer) => (out += d.toString()));
			p.on("error", (err) => done(-1, String(err)));
			p.on("close", (code) => done(code));
		});
	}

	/**
	 * Auto-install the pi agent: ensure the config dir exists and install the
	 * pi CLI globally (npm i -g). Auth is configured afterwards via the API key
	 * form or by running `pi` in a terminal.
	 */

	/**
	 * Version of the RUNNING pi-web-ui package, shared with the ready handshake.
	 */
	private static currentAppVersion(): string {
		return appVersion();
	}

	/** Simple numeric semver compare: >0 means a newer than b. */
	private static compareVersions(a: string, b: string): number {
		const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
		const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
		for (let i = 0; i < 3; i++) {
			const x = pa[i] ?? 0;
			const y = pb[i] ?? 0;
			if (x !== y) return x - y;
		}
		return 0;
	}

	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** 本客户端成功切换工作区（set_cwd）后触发，参数为新绝对路径。
	 *  attach 时由 AgentService 接到全局 onClientCwdChanged —— 编辑器等
	 *  工作区跟随型插件借此把根目录切到用户当前项目。 */
	onCwdChanged: ((abs: string) => void) | undefined = undefined;

	/** Ask the npm registry for the latest pi-web-ui version and report it. */
	async checkUpdate(): Promise<void> {
		const current = ClientSession.currentAppVersion();
		try {
			// Fetch the full package doc (not /latest): it carries the per-version
			// publish timestamps so the UI can hint when a version was JUST
			// published and the registry/CDN caches may not have caught up yet.
			const res = await fetch("https://registry.npmjs.org/@youweichen%2fpi-web-ui", {
				signal: AbortSignal.timeout(8_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				"dist-tags"?: { latest?: string };
				time?: Record<string, string>;
			};
			const latest = data["dist-tags"]?.latest ?? null;
			const latestPublishedAt =
				latest && data.time ? (data.time[latest] ?? null) : null;
			const upToDate =
				latest === null || ClientSession.compareVersions(current, latest) >= 0;
			this.emit({
				type: "update_status",
				current,
				latest,
				latestPublishedAt,
				upToDate,
			});
		} catch (err) {
			this.emit({
				type: "update_status",
				current,
				latest: null,
				latestPublishedAt: null,
				upToDate: false,
				error: `检查更新失败：${(err as Error).message}`,
			});
		}
	}

	async checkComponentUpdates(requestId: string): Promise<void> {
		const session = this.session;
		const cwd = this.cwd;
		this.emit({ type: "component_updates", requestId, cwd, phase: "checking", items: [] });
		try {
			const manager = packageManagerFor(session, cwd, this.agentDir);
			const items = await checkComponents(updateTargets(session, manager));
			this.emit({ type: "component_updates", requestId, cwd, phase: "ready", items, restartRequired: componentRestartRequired() });
		} catch (error) {
			this.emit({ type: "component_updates", requestId, cwd, phase: "error", items: [], error: String(error) });
		}
	}

	async updateComponent(requestId: string, id: string): Promise<void> {
		const cwd = this.cwd;
		const session = this.session;
		this.emit({ type: "component_updates", requestId, cwd, phase: "updating", items: [] });
		try {
			const manager = packageManagerFor(session, cwd, this.agentDir);
			const targets = updateTargets(session, manager);
			await updateComponentPackage(targets, id, (source) => manager.update(source));
			// SDK modules may be shared by other conversations. Restart, rather than
			// hot-swapping one session and claiming every session now runs new code.
			const items = await checkComponents(updateTargets(session, manager));
			this.emit({ type: "component_updates", requestId, cwd, phase: "updated", items, restartRequired: true });
		} catch (error) {
			this.emit({ type: "component_updates", requestId, cwd, phase: "error", items: [], error: error instanceof Error ? error.message : String(error) });
		}
	}

	async installPiAgent(): Promise<void> {
		try {
			mkdirSync(this.agentDir, { recursive: true });
			this.emit({
				type: "notice",
				level: "info",
				text: "正在安装 pi agent CLI（npm i -g @earendil-works/pi-coding-agent）…",
			});
			const { code, out } = await this.runAsync(
				"npm",
				["i", "-g", "@earendil-works/pi-coding-agent"],
				180_000,
			);
			if (code === 0) {
				this.emit({
					type: "notice",
					level: "info",
					text: "✅ pi agent CLI 安装完成。填入 API 密钥即可开始，或在终端运行 pi 完成登录。",
				});
				this.emit({ type: "install_result", ok: true, detail: "" });
			} else {
				this.emit({
					type: "notice",
					level: "error",
					text: `pi agent 安装失败（${code ?? "timeout"}）：${out.slice(0, 400)}`,
				});
				this.emit({
					type: "install_result",
					ok: false,
					detail: out.slice(0, 600),
				});
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `pi agent 安装失败：${(err as Error).message}`,
			});
		}
		// The CLI may just have landed on PATH (or the install may have failed) —
		// drop the probe cache so the next snapshot re-checks.
		ClientSession.invalidatePiCliProbe();
		this.flushSnapshot();
	}

	/** Send a snapshot immediately (cancels any pending throttled one).
	 *  forceFull skips the incremental path — used by get_state so a (re)
	 *  connecting or desynced client always receives an authoritative full
	 *  state it can rebuild from. */
	flushSnapshot(forceFull = false): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		this.emitSnapshotNow(forceFull);
	}

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.disposed) return;
		// During active streaming the deltas carry live rendering — full snapshots
		// are just a periodic reconciliation checkpoint, so send them far less
		// often (they serialize the whole session; big sessions made this path OOM).
		const interval =
			Date.now() - this.lastDeltaAt < DELTA_ACTIVE_WINDOW_MS
				? STREAMING_SNAPSHOT_INTERVAL_MS
				: SNAPSHOT_INTERVAL_MS;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			this.emitSnapshotNow();
		}, interval);
	}

	/** Slash-command catalog + native command execution — 自包含模块，见
	 *  slash-commands.ts（内置命令拦截 + 扩展/模板/技能目录推送）。 */
	private readonly slash = new SlashCommandsService({
		emit: (msg) => this.emit(msg),
		cwd: () => this.cwd,
		getSession: () => this.session,
		startNewSession: () => this.startNewSession(),
		treeCommand: async (name, args, context) => {
				const conv = this.conv;
				if (conv.id !== context.conversationId) return;
				if (name === "tree" || name === "fork") this.emit({ type: "tree_open", conversationId: conv.id, mode: name === "fork" ? "fork" : "tree" });
				else if (name === "name") {
					conv.tree?.assertWritable();
					if (!args.trim()) { this.emitNotice("info", "用法：/name <名称>"); return; }
					conv.session.setSessionName(args.trim().slice(0, 200)); conv.title = args.trim().slice(0, 200);
					this.invalidateLists(); this.scheduleSessionsRefresh(); this.flushSnapshot();
				} else await this.treeRequest({ type: "session_clone", conversationId: conv.id, reqId: `command-${context.requestId}` });
			},
			setModel: (id) => this.setModel(id),
		setCwd: (path) => this.setCwd(path),
		setThinking: (level) => this.setThinking(level),
		refreshSessions: () => this.refreshSessions(),

		onQuit: () => this.onQuit?.() ?? false,
	});

	/** Catalog push — index.ts get_commands / attach / cwd 切换等都会调用。 */
	pushSlashCommands(): Promise<void> {
		return this.slash.push();
	}

	/** 模型/服务商配置管理 —— 自包含模块，见 model-admin.ts。 */
	private readonly modelAdmin!: ModelAdminService;

	/** Persist an api-key credential for a provider (auth.json). */
	setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		return this.modelAdmin.setProviderApiKey(provider, apiKey);
	}
	clearProviderApiKey(provider: string): Promise<void> {
		return this.modelAdmin.clearProviderApiKey(provider);
	}
	listProviders(): Promise<void> {
		return this.modelAdmin.listProviders();
	}
	listModelsConfig(): Promise<void> {
		return this.modelAdmin.listModelsConfig();
	}
	fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
	): Promise<void> {
		return this.modelAdmin.fetchModelsList(reqId, baseUrl, apiKey, authHeader, api);
	}
	refreshProviderModels(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.refreshProviderModels(providerId, reqId);
	}
	/** Copy a built-in provider into an editable custom-provider draft
	 *  (clone_provider_result) — lets the user run a second API key without
	 *  overwriting the built-in one. */
	cloneProvider(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.cloneProvider(providerId, reqId);
	}
	saveModelConfig(providerId: string, config: unknown): Promise<void> {
		return this.modelAdmin.saveModelConfig(providerId, config as never);
	}
	deleteModelConfig(providerId: string): Promise<void> {
		return this.modelAdmin.deleteModelConfig(providerId);
	}

	// ---------------------------------------------------------------------------
	// Settings (system prompt / skills / extensions / presets)
	// ---------------------------------------------------------------------------

	/** Push the full settings state (current settings + loaded skills/extensions
	 *  with enabled flags + saved presets). Pushed on attach and after every
	 *  settings change. */
	pushSettings(): void {
		this.settingsSvc.push();
	}

	/** Extensions/skills changed externally (e.g. `pi remove` finished in the
	 *  terminal): re-run session.reload() and re-push state. Streaming-safe —
	 *  deferred to agent_settled, same as settings reloads. */
	async reloadExtensions(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** Persist + apply a partial settings update (prompt text/mode, toggles). */
	async setSettings(partial: Partial<import("./client-state.js").ClientSettings>): Promise<void> { await this.settingsSvc.set(partial); }

	/** Replace the current settings with the named preset and apply it. */

	/** Remove a named preset. */

		/** Make settings effective in the running runtime（流式中则延迟到 agent_settled）。 */
	private async applyRuntimeSettings(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** 把终端工具开关应用到 session 的活跃工具集：关闭时从活跃集中剔除
	 *  terminal_*（工具仍留在注册表，重开时可直接加回）。session.reload() 与新
	 *  会话创建都会把 custom 工具加回活跃集，所以这两条路径之后都要重放本方法。 */

	/** 把插件 AI 工具同步进一个已存在的会话（新增/更新/移除）。
	 *  实际 diff 逻辑在 plugins.ts 的 syncPluginToolsIntoSession（可单测）。 */

	/** index.ts 经 pluginMgr.onAgentToolsChanged 触发：把插件 AI 工具推入全部会话。 */

	private async applySettingsReload(): Promise<void> {
		// 兼容旧入口：reload + 刷目录在宿主回调里完成
		return this.settingsSvc.applyRuntime();
	}

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

	/** True when the service is draining (quiesced): emits a rejection notice
	 *  and returns true. Guards every NEW-work entry point (prompt / new chat /
	 *  edit-resend / session resume / goal wizard) — existing runs keep going.
	 *  Called BEFORE any LLM/token work starts so quiesce is a hard admission
	 *  gate, not a best-effort hint. */
	private quiesceBlocked(): boolean {

		if (!this.isQuiesced()) return false;
		this.emit({
			type: "notice",
			level: "error",
			text: "服务器正在排空存量工作（quiesce），已拒绝新的对话/消息/编辑。存量运行会继续跑完；用 pi-web-ui server unquiesce 可恢复。",
		});
		this.flushSnapshot();
		return true;
	}

	/** Conversations with an in-flight run — active work for quiesce status. */
	activeConversations(): number {
		let n = 0;
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) n += 1;
			} catch {
				// session being replaced — not running
			}
		}
		return n;
	}

	/** Messages queued in the SDK (steer + follow-up) — pending work for
	 *  quiesce status. Quiesce refuses to add more, so this only drains. */
	pendingMessages(): number {
		let n = 0;
		for (const c of this.convs.values())
			n += c.queueFollowUp.length + c.queueSteering.length;
		return n;
	}

	async prompt(
		text: string,
		attachments?: PromptAttachment[],
		/**
		 * true = followUp: while streaming, queue the prompt and deliver it only
		 * after the WHOLE run finishes (补充 button — "AI 生成结束才发送").
		 * false/undefined = steer: the pi CLI Enter semantic — injected right
		 * after the current turn settles, skipping remaining planned tool calls.
		 */
		queue = false,
		requestId?: string,
		onAccepted?: (ok: boolean) => void,
	): Promise<void> {
		const conv = this.conv;
		let acknowledged = false;
		const acknowledge = (ok: boolean, commandExecuted?: boolean) => {
			if (acknowledged) return;
			acknowledged = true;
			if (requestId) this.emit({ type: "prompt_result", requestId, conversationId: conv.id, ok, commandExecuted, attachmentsConsumed: ok && !commandExecuted });
			onAccepted?.(ok);
		};
		try {
			if (!["tree", "fork"].includes(parseSlash(text)?.name ?? "")) await conv.tree?.waitForVerification();
			const s = conv.session;
			await flushPromptReload(s);
			const promptReloadError=promptReloadStatus(s).reloadError;
			if(promptReloadError)throw new Error(`Native prompt reload failed: ${promptReloadError}`);
			if (this.conv !== conv || conv.session !== s) throw new Error("Conversation changed");
			const extensionCommand = text.startsWith("/") && s.extensionRunner.getCommand(text.slice(1).split(" ", 1)[0]);
			if (!extensionCommand) { attachments = resolveNativeAttachments(s, attachments); validateEditorSnapshots(this.cwd, attachments); }
			// Native slash commands (see NATIVE_COMMANDS) are executed here and
			// never reach the SDK. Extension / skill / template commands fall
			// through — AgentSession.prompt() handles those itself.
			const slash = parseSlash(text);
			if (slash?.name === "reload") acknowledge(true);
			if (slash && (await this.slash.exec(slash.name, slash.args, { conversationId: conv.id, requestId: requestId ?? `reload-${Date.now()}` }))) {
				acknowledge(true);
				this.flushSnapshot();
				return;
			}
			// Native commands above are pure config tweaks (no tokens) — allow them
			// even while quiesced. Everything that reaches the SDK is NEW work and
			// is refused until admission reopens.
			if (this.quiesceBlocked()) throw new Error("服务暂停接收消息");
			if (conv.title === DEFAULT_CONV_TITLE && text.trim()) {
				const temporary = skillAwareTitleText(text).trim().replace(/\s+/g, " ");
				conv.title = temporary.length > 30 ? `${temporary.slice(0, 30)}…` : temporary;
				this.emitConversations();
			}
			// Bundle file context with the question as one native queue item.
			const asides = await buildAttachmentMessages(
				{
					cwd: this.cwd,
					clientId: this.clientId,
					emit: (msg) => this.emit(msg),

					session: this.session,
				},
				extensionCommand ? undefined : attachments,
			);
			await conv.tree?.waitForVerification();
			if (this.conv !== conv || conv.session !== s) throw new Error("Conversation changed");
			if (!s.isStreaming) { conv.toolsExecutedSincePrompt = false; conv.lastTaskEndedAt = undefined; }
			this.coordinatePlan(conv);
			await deliverPrompt(s, text, asides, queue, acknowledge);
		} catch (err) {
			acknowledge(false);
			this.emit({
				type: "notice",
				level: "error",
				conversationId: conv.id,
				text: `提示发送失败：${(err as Error).message}`,
			});
		}
		// The active conversation has been continued since it was opened — it
		// must not be dismissed when the user switches away. (Also bumps the
		// per-project "most recently active" order used by set_cwd.)
		conv.promptedSinceActive = true;
		conv.lastActiveAt = Date.now();
		// Fresh run — restart the stall watchdog window.
		conv.lastSdkEventAt = Date.now();
		if (conv.stallNoticed) this.emit({ type: "agent_silence", conversationId: conv.id, phase: "active", since: conv.lastSdkEventAt, activity: "model" });
		conv.stallNoticed = false;
		this.flushSnapshot();
	}

	/**
	 * Turn attached files into custom-message payloads.
	 *
	 * Text files are size-aware: small files are inlined into the message so the
	 * model sees them immediately; large files are passed as a <file path="...">
	 * reference and the model reads them on demand with its read tool (which has
	 * built-in truncation). Images are always passed as image content. Mode
	 * "lines" inlines only a 1-based inclusive line range of the file. Raw
	 * pasted/dropped/uploaded images (attachment.imageData) skip the workspace
	 * path entirely and go straight to the model as image content. Raw uploaded
	 * files (attachment.fileData) are persisted under <dataDir>/uploads/ and
	 * attached as absolute-path references (small text ones are inlined).
	 */

	/**
	 * Hard-abort the running agent (Stop button / global 中断). Tries
	 * session.abort() first; if the run is not idle within
	 * HARD_ABORT_TIMEOUT_MS (model stream ignoring the abort signal), the
	 * conversation's runtime is force-disposed and recreated from the last
	 * persisted session so the chat ALWAYS comes back usable — never stuck
	 * overnight. The notice fires only on the forced-reset path.
	 */
	async abort(): Promise<void> {
		// 只停止智能体运行本身；AI 在后台启动的服务由「后台任务」面板单独
		// 管理（可逐个停止或全部关闭），不会在停止对话时被连带杀掉。
		const conv = this.conv;
		await this.interruptRun(conv, "已停止");
		conv.runningToolNames.clear();
		if (conv.stallNoticed) this.emit({ type: "agent_silence", conversationId: conv.id, phase: "active", since: Date.now(), activity: "model" });
		conv.stallNoticed = false;
		this.flushSnapshot();
	}

	/** Retry only a silent model request with no tool side effects in this turn. */
	async retrySilentPrompt(conversationId: string, text: string): Promise<void> {
		const conv = this.conv;
		if (conv.id !== conversationId || isRecovering(conv.recovery) || !conv.stallNoticed || conv.toolsExecutedSincePrompt || conv.runningToolNames.size || !text.trim()) {
			this.emit({ type: "notice", level: "warning", text: "当前运行状态已变化，无法手动重试；请检查对话后手动发送。" });
			return;
		}
		const user = conv.session.messages.findLast(m => m.role === "user");
		if (!user || user.role !== "user") return;
		const original = typeof user.content === "string" ? user.content : user.content.every(b => b.type === "text") ? user.content.map(b => b.type === "text" ? b.text : "").join("\n") : undefined;
		if (original !== text) return;
		await this.abort();
		if (this.conv !== conv || isRecovering(conv.recovery) || conv.toolsExecutedSincePrompt || conv.session.messages.findLast(m => m.role === "user")?.timestamp !== user.timestamp) return;
		await this.prompt(text);
	}

	/** Re-push the current list on request (panel opened); prunes dead entries first. */
	async listBgServers(): Promise<void> {
		await this.bg.listAndPush();
	}

	/** 插件任务集合变化时由宿主调用：重推一次 bg_servers（含插件任务）。 */
	refreshBgTasks(): void {
		this.bg.push();
	}

	/** 插件设置保存结果等需要从 index.ts 发 notice 时用（emit 是私有的）。 */
	emitNotice(level: "info" | "warning" | "error", text: string): void {
		this.emit({ type: "notice", level, text });
	}

	/** Kill ONE background server (by port); returns whether anything was killed. */
	/** Kill ONE background server (by port) OR a plugin task (by taskId). */
	async killBackgroundServer(port: number | undefined, taskId?: string): Promise<boolean> {
		if (taskId) {
			// 插件任务：交给插件管理器 stop 回调（不杀进程树——任务在宿主进程内）。
			const ok = this.pluginStopBgTask?.(taskId) ?? false;
			if (!ok) {
				this.emit({
					type: "notice",
					level: "info",
					text: `后台任务「${taskId}」不存在或已结束`,
				});
			}
			this.bg.push();
			this.flushSnapshot();
			return ok;
		}
		if (typeof port !== "number") return false;
		return this.bg.killOne(port);
	}

	/** Kill every background server the agent started; returns the freed ports. */
	async killAllBackgroundServers(): Promise<string[]> {
		return this.bg.killAll();
	}

	/** Kill only the running bash command(s) — the agent run itself continues
	 *  (the bash tool returns an aborted error and the model moves on). Uses
	 *  the per-client AbortController set registered by
	 *  makeKillableBashTool. */

	/** Interrupt a run: abort, with a force-reset fallback on timeout. */
	private async interruptRun(conv: Conversation, reason: string): Promise<void> {

		// The run is only truly stopped when its agent_settled event arrives:
		// session.abort() can return without stopping anything when the run is
		// stuck before the agent even started (e.g. a model stream that never
		// begins), so we watch for agent_settled and force-reset when it never
		// comes — abort 卡住（超时）或空转（结算窗口）两条路都覆盖。
		let ended = false;
		let forced = false;
		const off = conv.session.subscribe((e) => {
			if (e.type === "agent_settled") {
				ended = true;
			}
		});
		const force = () => {
			if (forced) return;
			forced = true;
			void this.forceResetConversation(
				conv,
				`${reason}：运行未终止，已强制重置当前对话`,
			);
		};
		// 1) abort itself hangs (model stream ignores the signal) → hard kill.
		const abortTimer = setTimeout(() => {
			if (!ended) force();
		}, ClientSession.HARD_ABORT_TIMEOUT_MS);
		abortTimer.unref?.();
		// 2) abort itself (Stop semantics: kills the process tree, emits
		//    agent_end with stopReason "aborted" on the normal path).
		try {
			await conv.runtime.session.abort();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `中止失败：${(err as Error).message}`,
			});
		}
		// 3) abort returned but no agent_settled within the settle window → the
		//    run was stuck before it started; force-reset to recover.
		if (!ended) {
			await new Promise((r) => setTimeout(r, ClientSession.HARD_ABORT_SETTLE_MS));
		}
		clearTimeout(abortTimer);
		off();
		if (!ended) force();
	}

	/** Force-reset a conversation: dispose the stuck runtime (kills the hung
	 *  model stream / child processes) and rebuild it from the most recent
	 *  persisted session. The conversation record itself is kept (same id,
	 *  same cwd, same serialization caches), so the UI stays attached. */
	private async forceResetConversation(conv: Conversation, reason: string): Promise<void> {

		try {
			conv.unsubscribe?.();
			conv.unsubscribe = undefined;

			const manager = conv.session.sessionManager;
			const header = manager.getHeader();
			const wikiManager = conv.wiki ? SessionManager.inMemory(conv.cwd, undefined, [...(header ? [header] : []), ...manager.getEntries()]) : null;
			conv.toolStartTimes.clear();
			await conv.runtime.dispose();
			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(),
				{
					cwd: conv.cwd,
					agentDir: this.agentDir,
					sessionManager: wikiManager ?? SessionManager.continueRecent(conv.cwd),
				},
			);
			conv.runtime = runtime;
			conv.webUi.dispose();
			conv.webUi = new WebUIContext(msg => this.emit(msg), conv.id, () => `${conv.cwd} · ${conv.title}`);
			conv.recovery = {};
			conv.session = runtime.session;
			this.emit({ type: "notice", level: "warning", text: reason });
			await this.bindSession();
			this.emitConversations();
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `强制中断失败：${(err as Error).message}`,
			});
		}
	}

	/** /new delegates session creation and history persistence to the SDK; the Web slot is reused. */
	async startNewSession(): Promise<void> {
		if (this.conv.tree?.busy) { this.emitNotice("warning", "等待当前切换完成。"); return; }
		if (this.quiesceBlocked()) return;
		const previous = this.conv;
		const model = previous.session.model;
		const thinking = previous.session.thinkingLevel;

		const result = await previous.runtime.newSession();
		if (result.cancelled) return;

		previous.unsubscribe?.();
		previous.tree?.dispose();

		const conv = this.makeConversation(previous.runtime, previous.id, previous.terminals);
		// IDs and delta sequence remain monotonic within this conversation.
		conv.wiki = previous.wiki;
		conv.deltaSeq = previous.deltaSeq;
		conv.nextMsgId = previous.nextMsgId;
		conv.createdAt = previous.createdAt;
		this.convs.set(conv.id, conv);
		await this.bindSession(conv);
		if (model) await conv.session.setModel(model);
		conv.session.setThinkingLevel(thinking);
		this.invalidateLists();
		this.emitConversations();

		if (previous.stallNoticed) this.emit({ type: "agent_silence", conversationId: conv.id, phase: "active", since: Date.now(), activity: "model" });
		this.flushSnapshot(true);
		void this.pushSlashCommands();
	}

	async newChat(fresh = false, wiki = false): Promise<boolean> {
		if (this.conv.tree?.busy) { this.emitNotice("warning", "等待当前切换完成。"); return false; }
		if (this.creatingConversation) return false;
		this.creatingConversation = true;
		const previous = this.activeId;
		try { await this.createChat(fresh, wiki); return this.activeId !== previous; }
		finally { this.creatingConversation = false; }
	}

	private async createChat(fresh: boolean, wiki = false): Promise<void> {
		this.invalidateLists();
		if (this.quiesceBlocked()) return;
		// Reuse an already-open blank conversation instead of piling up new ones
		// on every click: if the active chat has no messages it IS the new chat
		// (focus already on it); otherwise switch to the first blank one (under
		// the per-project running-list model displaced blanks are disposed, so
		// this branch normally can't exist — kept as a safety net).
		const isBlank = (c: Conversation): boolean => {
			try {
				return c.session.getSessionStats().totalMessages === 0 && c.terminals.list().length === 0;
			} catch {
				// session being replaced — treat as used so we don't switch onto it
				return false;
			}
		};
		const active = this.conv;
		if (!fresh && active && !active.wiki && isBlank(active)) {
			this.flushSnapshot();
			return;
		}
		for (const conv of this.convs.values()) {
			if (conv.id === this.activeId) continue;
			if (!fresh && !conv.wiki && isBlank(conv)) {
				await this.switchConversation(conv.id);
				this.flushSnapshot();
				return;
			}
		}
		// Wiki opens a fresh session for each document. Retire the outgoing idle
		// runtime after success; temporary Wiki history is discarded with it.
		const replaceActive = fresh && active && !active.session.isStreaming && active.terminals.list().length === 0 ? active : null;
		// Cap is per project — conversations of other projects keep their own
		// lists and don't consume this project's slots.
		const openInProject = [...this.convs.values()].filter(
			(c) => c.cwd === this.cwd,
		).length;
		if (openInProject >= MAX_OPEN_CONVERSATIONS && !replaceActive) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `当前项目运行的对话已达上限（${MAX_OPEN_CONVERSATIONS} 个），请先打开某个对话并离开（不继续对话）以移出列表`,
			});
			return;
		}
		// The outgoing conversation is left behind — apply the running-list
		// lifecycle. Removal is deferred until the new chat exists so the active
		// conversation stays valid during the (async) runtime creation.
		const displaced = replaceActive ?? this.displaceActive();
		// Carry the model chosen in the active chat over to the new chat so it
		// doesn't silently revert to the ModelRuntime default model.
		const prevModel = this.conv.session.agent.state.model ?? null;
		try {
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, this.cwd);
			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(),
				{
					cwd: this.cwd,
					agentDir: this.agentDir,
					sessionManager: wiki ? SessionManager.inMemory(this.cwd) : SessionManager.create(this.cwd),
				},
			);
			const conv = this.makeConversation(runtime, conversationId, terminals);
			conv.wiki = wiki;
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			// New session seeds with the ModelRuntime default model — restore the
			// model the user had selected in the previous chat.
			if (prevModel && this.sharedModelRuntime) {
				try {
					await this.session.setModel(prevModel);
				} catch {
					// model no longer resolvable — keep the default
				}
			}
			this.emitConversations();

			this.pushTerminals();
			// The new runtime re-discovered skills/templates — refresh the catalog
			// so the picker stops showing the previous runtime's list.
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `新建对话失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * The active conversation is being left (new_chat / switch_conversation /
	 * set_cwd). Runs the running-list lifecycle:
	 *
	 * - still streaming → it becomes a background run: ensure it is listed;
	 * - idle + listed + continued → keep it (the user did continue it);
	 * - any retained terminal state → keep it listed until the terminals are closed;
	 * - idle + just-viewed (never prompted this visit) → ALSO kept listed, as
	 *   long as the owning project is under its MAX_OPEN_CONVERSATIONS cap.
	 *   Disposing on every glance meant switching back to a project you'd only
	 *   looked at (not typed into) paid a full cold restart — a fresh
	 *   AgentSessionRuntime + SessionManager.continueRecent() disk resume +
	 *   TerminalManager — every single time. That cost is real on any
	 *   platform but lands hardest on Windows (slower fs I/O, AV scanning
	 *   every spawned process/file, ConPTY init), which is what made "project
	 *   switching" itself feel slow rather than just the first visit. Idle
	 *   conversations are cheap to hold (no streaming, no PTYs) — bounding by
	 *   the existing per-project cap keeps memory use where it already was
	 *   allowed to go, just makes it more likely to actually get there.
	 * - only over-cap does the caller now actually drop it (returns it so
	 *   removal happens after the active conversation has been switched away).
	 */
	private displaceActive(): Conversation | null {
		const conv = this.conv;
		// An isolated reviewer can keep working while the main session is idle;
		// retain that conversation so its review is not disposed when the user
		// switches away without sending another prompt.

		if (conv.session.isStreaming) {
			conv.listed = true;
			return null;
		}
		// Terminal state is a reason to keep an otherwise idle conversation alive:
		// switching chats must not kill a PTY the user or agent may still need.
		if (conv.terminals.list().length > 0) {
			conv.listed = true;
			return null;
		}
		if (conv.wiki) return conv;
		if (conv.listed && conv.promptedSinceActive) return null;
		// Idle and never continued this visit — still worth keeping warm
		// (see above) unless doing so would push this project over its cap,
		// in which case free the slot the old way.
		const openInProject = [...this.convs.values()].filter(
			(c) => c.cwd === conv.cwd,
		).length;
		if (openInProject < MAX_OPEN_CONVERSATIONS) {
			conv.listed = true;
			return null;
		}
		return conv;
	}

	/** Remove a conversation from the running list and free its runtime. The
	 *  session stays persisted on disk, so it remains recoverable from the
	 *  history list. Never removes the active conversation. */
	private removeConversation(id: string): Promise<void> {
		const conv = this.convs.get(id);
		if (!conv || id === this.activeId) return Promise.resolve();

		conv.tree?.dispose();
		conv.webUi.dispose();
		this.convs.delete(id);

		conv.terminals.killAll();
		conv.unsubscribe?.();
		conv.unsubscribe = undefined;
		return conv.runtime.dispose().catch(() => {});
	}

	/** Switch the ACTIVE conversation without interrupting any other chat. */
	async switchConversation(id: string): Promise<void> {
		if (this.conv.tree?.busy) { this.emitNotice("warning", "等待当前切换完成。"); return; }
		if (!this.convs.has(id) || id === this.activeId) return;
		const displaced = this.displaceActive();
		this.activeId = id;
		this.cwd = this.conv.cwd;
		// All listed conversations share the current project's cwd, so this is
		// normally a no-op — kept defensive for stale clients.
		if (displaced) this.removeConversation(displaced.id);
		this.conv.promptedSinceActive = false;
		this.conv.lastActiveAt = Date.now();
		this.webUi.refresh();
		this.emitConversations();

		this.pushTerminals();
		// The switched-to conversation has its own runtime (own resource cache).
		void this.pushSlashCommands();
		this.flushSnapshot();
	}

	/** Push the current project's running-conversation list to the client. */
	private emitConversations(): void {
		const conversations: ConversationSummary[] = [];
		for (const conv of this.convs.values()) {
			// Wiki history stays out of the project list. Keep only running Wiki
			// tasks reachable so users can stop a background run.
			if (conv.wiki && !conv.session.isStreaming) continue;
			// Always include the active conversation. A fresh session has no
			// transcript yet, so history cannot provide its sidebar row.
			if (conv.cwd !== this.cwd || (!conv.listed && conv.id !== this.activeId)) continue;
			let messageCount = 0;
			let isStreaming = false;
			try {
				messageCount = conv.session.getSessionStats().totalMessages;
				isStreaming = conv.session.isStreaming;
			} catch {
				// session being replaced — report defaults
			}
			conversations.push({
				branchPoints: conv.tree?.refresh().branchPoints,
				parentSessionPath: conv.session.sessionManager.getHeader()?.parentSession,
				id: conv.id,
				createdAt: conv.createdAt,
				title: conv.title,
				cwd: conv.cwd,
				messageCount,
				isStreaming,
				// resolve() so it is byte-comparable with the paths
				// SessionManager.list() reports to the client — the two are
				// compared as plain strings there, and an unnormalized form
				// here would make the dedup silently miss.
				sessionFile: conv.session.sessionFile
					? resolve(conv.session.sessionFile)
					: undefined,
			});
		}
		this.emit({
			type: "conversations",
			conversations,
			activeId: this.activeId,
		});
	}

	/** List persisted sessions for this client, newest first. */
	/** The client asked for the session list at least once (lazy loading) —
	 *  background refreshes only re-push when this is true, so a mobile
	 *  client that never opened the panel never pays the disk scan. */
	private sessionsRequested = false;
	private sessionQueries = new QueryCache<SessionSummary[]>(5_000);
	private projectQueries = new QueryCache<DiskProjectSummary[]>(30_000, 1);
	private invalidateLists(): void {
		this.sessionQueries.clear();
		this.projectQueries.clear();
	}

	/** Push the persisted session list to the client (client-requested). */
	async refreshSessions(): Promise<void> {
		this.sessionsRequested = true;
		await this.pushSessions();
	}

	private readonly branchCounts = new SessionBranchCounts();
	private async pushSessions(): Promise<void> {
		if (!this.sessionsRequested) return;
		const cwd = this.cwd;
		try {
			// Sessions live in the SDK default per-project dir
			// (<agentDir>/sessions/--<cwd>--/), the same files the pi CLI/TUI
			// use — one listing covers every conversation of the current folder.
			const sorted = await this.sessionQueries.get(cwd, async () => {
				const infos = await SessionManager.list(cwd);
				// SDK SessionInfo includes allMessagesText. Retain only UI summaries.
				const sessions = new Map<string, SessionSummary>();
				const selected = infos.sort((a, b) => b.created.getTime() - a.created.getTime()).slice(0, 200);
				const counts = await this.branchCounts.getMany(selected.map(info => resolve(info.path)));
				for (const [index, info] of selected.entries()) {
					const path = resolve(info.path);
					sessions.set(path, {
						path, name: info.name, firstMessage: info.firstMessage,
						parentSessionPath: info.parentSessionPath,
						branchPoints: counts[index],
						messageCount: info.messageCount, modified: info.modified.getTime(),
						created: info.created.getTime(), source: "web",
					});
				}
				// 创建时间新→旧；条目位置此后固定（UI 不再按选中/活动重排）。
				return [...sessions.values()].sort((a, b) => b.created - a.created).slice(0, 200);
			}, () => { if (this.cwd === cwd) void this.pushSessions(); });
			this.emit({ type: "sessions", cwd, sessions: sorted });
		} catch {
			this.emit({ type: "sessions", cwd, sessions: [] });
		}
	}

	/** Remove an entry from the client's recent-project list (UI state only). */
	async removeProject(path: string): Promise<void> {
		this.invalidateLists();
		this.stateStore.removeProject(this.clientId, path);
		await this.pushProjects();
	}

	/** Permanently delete a persisted session transcript file (history list ✕). */
	async deleteSession(path: string): Promise<void> {
		this.invalidateLists();
		try {
			const abs = resolve(path);
			// Guardrail: only transcripts under the shared sessions root
			// (<agentDir>/sessions/) may be deleted — never arbitrary files.
			const sessionsRoot = resolve(this.agentDir, "sessions");
			if (!abs.startsWith(sessionsRoot + sep)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "只能删除会话目录中的对话记录",
				});
				return;
			}
			// Warm, idle runtimes are caches, not active use. Protect actual work
			// before releasing any matching runtimes and deleting the transcript.
			const owners = [...this.convs.values()].filter((conv) =>
				conv.session.sessionFile && resolve(conv.session.sessionFile) === abs);
			for (const conv of owners) {
				if (conv.id === this.activeId || conv.session.isStreaming ||

					conv.queueSteering.length > 0 || conv.queueFollowUp.length > 0 ||
					conv.terminals.list().length > 0) {
					this.emit({
						type: "notice",
						level: "warning",
						text: conv.id === this.activeId
							? "该对话正在使用中，请先切换到其他对话再删除"
							: "该对话仍有后台任务或终端，请先停止任务并关闭终端再删除",
					});
					return;
				}
			}
			await Promise.all(owners.map((conv) => this.removeConversation(conv.id)));
			rmSync(abs, { force: true });
			this.emitConversations();
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `删除会话失败：${(err as Error).message}`,
			});
		}
	}

	/** List subdirectories for the workspace picker (`browse_dirs`).
	 *
	 * Deliberately NOT routed through FilesService.listFiles(), which pins
	 * every listing inside the current workspace — choosing a new workspace
	 * is exactly the case that has to look outside it. Scope is kept narrow
	 * instead: directory *names* only, never file contents, and the same
	 * loopback binding + PI_WEB_TOKEN auth as every other message guards it.
	 * (The agent can already shell out with bash, so this exposes nothing it
	 * could not already reach — it just makes it clickable.)
	 */
	async browseDirs(path?: string): Promise<void> {
		const { homedir } = await import("node:os");
		const fs = await import("node:fs/promises");
		const { dirname } = await import("node:path");
		const MAX = 500;
		const target = resolve(path?.trim() || homedir());
		try {
			const dirents = await fs.readdir(target, { withFileTypes: true });
			const dirs: string[] = [];
			for (const d of dirents) {
				// Symlinked directories are worth following (project checkouts
				// are often symlinked), but a broken link must not abort the
				// whole listing — isDirectory() is false for those, which is
				// the behaviour we want anyway.
				if (!d.isDirectory()) continue;
				if (d.name.startsWith(".")) continue; // dotfolders: noise here
				dirs.push(d.name);
				if (dirs.length >= MAX) break;
			}
			dirs.sort((a, b) => a.localeCompare(b));
			const parent = dirname(target);
			this.emit({
				type: "dir_browse",
				path: target,
				parent: parent === target ? null : parent,
				dirs,
				truncated: dirs.length >= MAX,
				drives: await listWindowsDrives(),
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `无法读取目录：${(err as Error).message}`,
			});
		}
	}

	/** Rename a persisted session (history list ✎).
	 *
	 * The display name lives in the transcript itself as a `session_info`
	 * entry, so renaming means appending one via the SDK rather than touching
	 * any sidecar state — `SessionManager.list()` already surfaces the latest
	 * one as `SessionInfo.name`, which is what the panel renders. An empty
	 * name clears it and the list falls back to the first user message.
	 */
	async renameSession(path: string, name: string): Promise<void> {
		this.invalidateLists();
		try {
			const abs = resolve(path);
			// Same guardrail as deleteSession: only transcripts under the
			// shared sessions root may be written, never arbitrary files.
			const sessionsRoot = resolve(this.agentDir, "sessions");
			if (!abs.startsWith(sessionsRoot + sep)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "只能重命名会话目录中的对话记录",
				});
				return;
			}
			const trimmed = name.trim().slice(0, 120);
			// A live conversation holds its own SessionManager on this file;
			// append through that one so the two don't fight over the tail.
			const liveConv = [...this.convs.values()].find(
				(conv) => conv.session.sessionFile === abs,
			);
			if (liveConv) {
				liveConv.tree?.assertWritable();
				liveConv.session.sessionManager.appendSessionInfo(trimmed);
				liveConv.title = trimmed || conversationTitle(liveConv.session);
				this.emitConversations();
			} else {
				SessionManager.open(abs).appendSessionInfo(trimmed);
			}
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `重命名会话失败：${(err as Error).message}`,
			});
		}
	}

	/** Open a persisted session as the active conversation (from listSessions).
	 *
	 * A persisted-session click must follow the same ownership rule as
	 * new_chat/switch_conversation: every open conversation keeps its own
	 * runtime. AgentSessionRuntime.switchSession() tears down (and aborts) the
	 * current runtime, which would otherwise stop a response merely because the
	 * user opened history while it was streaming.
	 */
	async switchSession(path: string): Promise<void> {
		if (this.conv.tree?.busy) { this.emitNotice("warning", "等待当前切换完成。"); return; }
		if (this.quiesceBlocked()) return;
		let openedRuntime: AgentSessionRuntime | null = null;
		let openedTerminals: TerminalManager | null = null;
		try {
			const targetPath = resolve(path);

			// A session may already be open in the running-conversation map. Reuse it
			// instead of creating a second writer for the same JSONL transcript.
			for (const conv of this.convs.values()) {
				const sessionFile = conv.session.sessionFile;
				if (sessionFile && resolve(sessionFile) === targetPath) {
					await this.switchConversation(conv.id);
					return;
				}
			}

			const sessionManager = SessionManager.open(targetPath);
			const targetCwd = sessionManager.getCwd();
			const conversationId = this.nextConversationId();
			openedTerminals = this.makeTerminalManager(conversationId, targetCwd);
			openedRuntime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(),
				{
					cwd: targetCwd,
					agentDir: this.agentDir,
					sessionManager,
				},
			);

			// Only displace the old active conversation after the replacement runtime
			// is known-good. This keeps a failed history open entirely non-destructive.
			const oldListed = this.conv.listed;
			const displaced = this.displaceActive();
			const openInProject =
				[...this.convs.values()].filter((c) => c.cwd === targetCwd).length +
				1 -
				(displaced?.cwd === targetCwd ? 1 : 0);
			if (openInProject > MAX_OPEN_CONVERSATIONS) {
				// displaceActive() may have promoted a streaming conversation into the
				// running list. Roll that presentation-only mutation back because no
				// switch will take place.
				this.conv.listed = oldListed;
				openedTerminals.killAll();
				await openedRuntime.dispose();
				openedRuntime = null;
				openedTerminals = null;
				this.emit({
					type: "notice",
					level: "warning",
					text: `当前项目运行的对话已达上限（${MAX_OPEN_CONVERSATIONS} 个），请先打开某个对话并离开（不继续对话）以移出列表`,
				});
				return;
			}

			const conv = this.makeConversation(
				openedRuntime,
				conversationId,
				openedTerminals,
			);
			// Deliberately resumed — must not be dismissed when the user later
			// switches away without sending a new message.
			conv.promptedSinceActive = true;
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			openedRuntime = null;
			openedTerminals = null;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			this.cwd = targetCwd;
			this.conv.lastActiveAt = Date.now();
			this.webUi.refresh();
			this.emitConversations();

			this.pushTerminals();
			// The restored conversation has a fresh project-bound resource cache.
			void this.pushSlashCommands();
		} catch (err) {
			openedTerminals?.killAll();
			if (openedRuntime) await openedRuntime.dispose().catch(() => {});
			this.emit({
				type: "notice",
				level: "error",
				text: `切换会话失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Map a rendered user-message id (`u-<timestamp>-<seq>`, assigned in
	 * serialize.ts) back to its append-only session entry id. The seq handles
	 * two user messages sharing the same millisecond timestamp.
	 */
	private resolveUserMessageEntryId(messageId: string): string | null {
		const m = /^u-(\d+)(?:-(\d+))?$/.exec(messageId);
		if (!m) return null;
		const ts = Number(m[1]);
		const seq = m[2] ? Number(m[2]) : 1;
		let count = 0;
		// Resolve against the compaction-aware current leaf path — the same list
		// the UI renders (state.messages). Scanning the whole file (getEntries)
		// could match a summarized entry or one on a different branch.
		for (const entry of this.session.sessionManager.buildContextEntries()) {
			if (entry.type !== "message") continue;
			const msg = (entry as unknown as { message?: AgentMessage }).message;
			if (!msg || msg.role !== "user" || msg.timestamp !== ts) continue;
			count += 1;
			if (count === seq) return entry.id;
		}
		return null;
	}

	/** Re-ask on a native in-file branch by default; an explicit choice or UI
	 * preference preserves the separate-file fork behavior. Attachments travel
	 * through prompt() again because their original asides remain on the old path. */
	async editMessage(
		messageId: string,
		text: string,
		attachments?: Parameters<ClientSession["prompt"]>[1],
		options: { conversationId?: string; entryId?: string; newSession?: boolean } = {},
	): Promise<void> {
		if (this.quiesceBlocked()) return;
		const trimmed = text.trim();
		if (!trimmed) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "编辑内容为空，已取消",
			});
			this.flushSnapshot();
			return;
		}
		const conv = this.conv;
		if (options.conversationId && options.conversationId !== conv.id) return;
		const entryId = options.entryId ?? this.resolveUserMessageEntryId(messageId);
		if (!entryId) {
			this.emit({
				type: "notice",
				level: "error",
				text: "找不到要编辑的消息（可能已被压缩或不在当前分支）",
			});
			this.flushSnapshot();
			return;
		}
		try {
			attachments = resolveNativeAttachments(conv.session, attachments);
			validateEditorSnapshots(this.cwd, attachments);
			// Preserve the model the user had selected — fork() seeds a new
			// branch with the ModelRuntime default model otherwise.
			const prevModel = this.session.agent.state.model ?? null;
			conv.tree?.assertWritable();
			const entry = conv.session.sessionManager.getEntry(entryId);
			if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("只能编辑用户消息。");
			const newSession = options.newSession ?? this.settingsSvc.current.editResendNewSession ?? false;
			let status = "error";
			const context = { conversationId: conv.id, reqId: `edit-${randomUUID()}` };
			await conv.tree?.request(newSession
				? { type: "session_fork", ...context, entryId, position: "before" }
				: { type: "tree_navigate", ...context, targetId: entryId, summary: "none" }, result => { status = result; });
			if (status !== "ok" || this.conv !== conv) return;
			await conv.tree?.waitForVerification();
			if (newSession && prevModel && this.sharedModelRuntime) {
				try { await conv.session.setModel(prevModel); } catch { /* Keep the runtime default if unavailable. */ }
			}
			await conv.tree?.waitForVerification();
			if (this.conv !== conv) return;
			await this.prompt(trimmed, attachments);
			if (newSession) this.emit({
				type: "notice",
				level: "info",
				text: "已从该问题重新提问（原对话保留在会话列表中）",
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `编辑重问失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Push the recent-project list (persisted per client, merged with every cwd
	 * that has persisted sessions in this client's session store — so workspaces
	 * opened before the recent-list feature existed still show up).
	 */
	async pushProjects(): Promise<void> {
		try {
			const saved = this.stateStore.get(this.clientId);
			const removedProjects = new Set(
				this.stateStore.getRemovedProjects(this.clientId),
			);
			const all = await this.projectQueries.get("all", async () => {
				const newest = new Map<string, Omit<DiskProjectSummary, "path">>();
				for (const info of await SessionManager.listAll()) {
					if (!info.cwd) continue;
					const previous = newest.get(info.cwd);
					newest.set(info.cwd, {
						lastUsed: Math.max(previous?.lastUsed ?? 0, info.modified.getTime()),
						conversationCount: (previous?.conversationCount ?? 0) + 1,
						// 首次添加锚点：该 cwd 下最早的会话创建时间。
						firstAdded: Math.min(
							previous?.firstAdded ?? Number.MAX_SAFE_INTEGER,
							info.created.getTime(),
						),
					});
				}
				return [...newest].map(([path, summary]) => ({ path, ...summary }));
			}, () => { void this.pushProjects(); });
			// Only keep directories that still exist — a deleted/unmounted workspace
			// is useless in the picker. Tombstoned entries (explicitly removed by
			// the user) stay hidden even though session files still mention them.
			// Order is most recently used/activity first (mergeProjectSummaries).
			const projects = mergeProjectSummaries(
				saved.projects.filter((p) => existsSync(p.path)),
				all.filter((p) => existsSync(p.path)),
				removedProjects,
			);
			this.stateStore.rememberDisplayedProjects(this.clientId, projects);
			this.emit({ type: "projects", projects });
		} catch {
			this.emit({ type: "projects", projects: [] });
		}
	}

	/** List a workspace directory (relative to the configured cwd). */
	async listFiles(relPath?: string): Promise<void> {
		return this.files.listFiles(relPath);
	}

	checkConversationFiles(cwd: string, reqId: number, paths: string[]): void {
		const current = this.cwd;
		this.emit({ type: "conversation_files_checked", cwd, reqId, paths: cwd === current && Array.isArray(paths) ? existingConversationFiles(current, paths) : [] });
	}

	/** 全局搜索：递归文件名匹配（结果经 search_files_result 回推，reqId 匹配）。 */
	async searchFiles(query: string, reqId: number): Promise<void> {
		return this.files.searchFiles(query, reqId);
	}

	/** SCM 只读查询（结构化 JSON，reqId 匹配）。 */
	async gitBranch(): Promise<void> { return this.files.gitBranch(); }

	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void> {
		return this.files.scmQuery(kind, reqId, arg);
	}

	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	async readFile(relPath: string, options?: { requestId?: string; cwd?: string }): Promise<void> {
		return this.files.readFile(relPath, options);
	}

	/** Save text from the file preview panel within the active workspace. */
	async writeFile(relPath: string, text: string, options?: { requestId?: string; cwd?: string; expectedVersion?: string; force?: boolean }): Promise<void> {
		return this.files.writeFile(relPath, text, options);
	}

	async cycleModel(): Promise<void> {
		try {
			this.conv.tree?.assertWritable();
			await this.session.cycleModel();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换模型失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Path completion for the cwd input: expand ~/relative paths, list the parent
	 * directory, and return prefix matches (dirs first, capped).
	 */
	async completePath(input: string): Promise<void> {
		return this.files.completePath(input);
	}

	private cwdQueue: { path: string; id?: string; source?: "ui"; done: () => void } | null = null;
	private cwdSwitchRunning = false;
	get switchingWorkspace(): boolean { return this.cwdSwitchRunning; }

	async setCwd(path: string, id?: string, source?: "ui"): Promise<void> {
		if (this.conv.tree?.busy) { this.emitNotice("warning", "等待当前切换完成。"); return; }
		return new Promise<void>((done) => {
			if (this.cwdQueue) {
				if (this.cwdQueue.id) this.emit({ type: "cwd_result", requestId: this.cwdQueue.id, cwd: this.cwd, ok: false, error: "superseded" });
				this.cwdQueue.done();
			}
			this.cwdQueue = { path, id, source, done };
			void this.drainCwdQueue();
		});
	}

	private async drainCwdQueue(): Promise<void> {
		if (this.cwdSwitchRunning) return;
		this.cwdSwitchRunning = true;
		try {
			while (this.cwdQueue) {
				const next = this.cwdQueue;
				this.cwdQueue = null;
				await this.commitCwd(next.path, next.id, next.source);
				next.done();
			}
		} finally { this.cwdSwitchRunning = false; }
	}

	private async commitCwd(newCwd: string, requestId?: string, source?: "ui"): Promise<void> {
		const startedAt = Date.now();
		try {
			const { resolve } = await import("node:path");
			// Watchers change only after the target has been prepared.
			const fs = await import("node:fs/promises");
			const abs = resolve(newCwd);
			const st = await fs.stat(abs);
			if (!st.isDirectory()) {
				throw new Error("路径不是目录");
			}
			if (abs === this.cwd) {
				if (requestId) this.emit({ type: "cwd_result", requestId, cwd: abs, ok: true });
				this.flushSnapshot(true);
				return;
			}

			// The outgoing conversation is left behind — apply the running-list
			// lifecycle (removal is deferred until the active conversation is
			// safely switched away).
			// Prefer the target project's own most recently active conversation;
			// only create a fresh one (resuming its most recent session) when the
			// project has none open yet.
			let target: Conversation | undefined;
			for (const c of this.convs.values()) {
				if (
					c.cwd === abs && !c.wiki &&
					(!target || c.lastActiveAt > target.lastActiveAt)
				) {
					target = c;
				}
			}

			if (target) {
				const displaced = this.displaceActive();
				this.activeId = target.id;
				if (displaced) this.removeConversation(displaced.id);
			} else {
				// First visit to this project: resume its most recent session.
				const conversationId = this.nextConversationId();
				const terminals = this.makeTerminalManager(conversationId, abs);
				const newRuntime = await createAgentSessionRuntime(
					this.makeRuntimeFactory(),
					{
						cwd: abs,
						agentDir: this.agentDir,
						sessionManager: SessionManager.continueRecent(abs),
					},
				);
				const conv = this.makeConversation(newRuntime, conversationId, terminals);
				this.convs.set(conv.id, conv);
				try {
					await this.bindSession(conv);
				} catch (error) {
					this.removeConversation(conv.id);
					throw error;
				}
				const displaced = this.displaceActive();
				this.activeId = conv.id;
				if (displaced) this.removeConversation(displaced.id);
				for (const d of newRuntime.diagnostics) {
					if (d.type !== "info") {
						this.emit({ type: "notice", level: d.type, text: d.message });
					}
				}
			}

			this.pushTerminals();
			this.conv.promptedSinceActive = false;
			this.conv.lastActiveAt = Date.now();
			this.cwd = abs;
			this.files.unwatchGit();
			this.files.unwatchDir();
			if (source !== "ui") {
				try { this.session.sessionManager.appendCustomEntry("pi-web-ui:cwd-switch", { cwd: abs }); }
				catch { /* A transcript write failure must not turn a completed switch into an error. */ }
			}
			const preparedAt = Date.now();
			this.flushSnapshot(true);
			if (requestId) this.emit({ type: "cwd_result", requestId, cwd: abs, ok: true,
				timing: { startedAt, preparedAt, snapshotAt: Date.now() },
			});
			// 工作区跟随型插件（编辑器文件树等）同步切根。
			try {
				this.onCwdChanged?.(abs);
			} catch {
				/* 钩子异常不影响主流程 */
			}
			// Remember the new workspace (restore target + recent-project entry).
			this.stateStore.remember(this.clientId, abs);
			void this.pushProjects();
			this.webUi.refresh();
			this.emitConversations();

			// Skills / prompt templates are project-bound — refresh the catalog.
			void this.pushSlashCommands();
			void this.refreshSessions();
			// Commands are per-project (.pi/commands.json in the current cwd).
			void this.listCommands();
			return;
		} catch (err) {
			if (requestId) this.emit({ type: "cwd_result", requestId, cwd: this.cwd, ok: false, error: (err as Error).message });
			this.emit({
				type: "notice",
				level: "error",
				text: `切换工作目录失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot(true);
	}

	/** List models that have valid authentication configured. */
	async listModels(): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const available = await mr.getAvailable();
			const models = available.map((m) => ({
				id: `${m.provider}/${m.id}`,
				name: m.name,
				provider: m.provider,
				reasoning: m.reasoning,
				vision: m.input?.includes("image") ?? false,
			}));
			this.emit({ type: "models", models });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `获取模型列表失败：${(err as Error).message}`,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Goal / review
	// ---------------------------------------------------------------------------

	/** Run a git diff (unstaged + staged) in a conversation's workspace, or
	 * "" when not a repo. */

	/** Switch to a specific model by "provider/id" (e.g. "anthropic/claude-sonnet-5"). */
	async setModel(modelId: string): Promise<void> {
		try {
			this.conv.tree?.assertWritable();
			const mr = this.runtime.services.modelRuntime;
			const slash = modelId.indexOf("/");
			if (slash <= 0 || slash === modelId.length - 1) {
				throw new Error(`无效的模型 ID：${modelId}`);
			}
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			const model = mr.getModel(provider, id);
			if (!model) throw new Error(`模型不存在：${modelId}`);
			await this.session.setModel(model);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换模型失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Set the thinking level for future turns. */
	setThinking(level: string): void {
		try {
			this.conv.tree?.assertWritable();
			this.session.setThinkingLevel(
				level as Parameters<AgentSession["setThinkingLevel"]>[0],
			);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换思考强度失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	cycleThinking(): void {
		try {
			this.conv.tree?.assertWritable();
			this.session.cycleThinkingLevel();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换思考强度失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Push the user command list (.pi/commands.json) to the client. */
	async listCommands(): Promise<void> {
		const cwd = this.cwd;
		const { commands, path, warning } = await loadCommands(cwd);
		if (warning) {
			this.emit({ type: "notice", level: "warning", text: warning });
		}
		this.emit({ type: "commands", commands, path, cwd });
	}

	/** Persist the user command list (.pi/commands.json). */
	async saveCommands(commands: CommandDef[]): Promise<void> {
		const cwd = this.cwd;
		const { path, error } = await saveCommandsFile(cwd, commands);
		if (error) {
			this.emit({ type: "notice", level: "error", text: error });
			return;
		}
		this.emit({ type: "commands", commands, path, cwd });
		this.emit({ type: "notice", level: "info", text: `命令已保存：${path}` });
	}

	async dispose(): Promise<void> {

		ClientSession.liveClients.delete(this.clientId);
		this.disposed = true;
		for (const conv of this.convs.values()) {

			conv.terminals.killAll();
		}
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		if (this.sessionsTimer) {
			clearTimeout(this.sessionsTimer);
			this.sessionsTimer = null;
		}
		if (this.widgetsTimer) {
			clearInterval(this.widgetsTimer);
			this.widgetsTimer = null;
		}
		if (this.stallTimer) {
			clearInterval(this.stallTimer);
			this.stallTimer = null;
		}
		this.files.unwatchDir();
		this.files.unwatchGit();
		this.providerAuth.cancel();
		for (const conv of this.convs.values()) { conv.tree?.dispose(); conv.webUi.dispose(); }
		this.bg.stop();
		for (const conv of this.convs.values()) {

			conv.unsubscribe?.();
			try {
				await conv.runtime.dispose();
			} catch {
				// best effort
			}
		}
	}
}

/**
 * Windows drive roots that currently exist ("C:\\", "D:\\", …); empty on
 * POSIX (where "/" already reaches everything).
 *
 * Needed because Windows has no unified filesystem root: dirname("C:\\") is
 * "C:\\", so the picker's walk-up hits a ceiling on the boot drive and can
 * never reach D:. Probing A–Z with access() avoids shelling out to wmic /
 * PowerShell (both slow to spawn, and wmic is gone on recent Windows).
 * Missing/empty drives simply reject, so they drop out.
 */
async function listWindowsDrives(): Promise<string[] | undefined> {
	if (process.platform !== "win32") return undefined;
	const fs = await import("node:fs/promises");
	const letters = Array.from({ length: 26 }, (_, i) =>
		String.fromCharCode(65 + i),
	);
	const found = await Promise.all(
		letters.map(async (letter) => {
			const root = `${letter}:\\`;
			try {
				await fs.access(root);
				return root;
			} catch {
				return null;
			}
		}),
	);
	return found.filter((d): d is string => d !== null);
}

export class AgentService {
		/** index.ts 注入：SDK 工具执行事件的插件转发钩子，attach 时拷贝到每个新会话。 */
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的 AI 工具（attach 时拷贝到每个新会话）。 */

	/** index.ts 注入：读取插件当前注册的斜杠命令（attach 时拷贝到每个新会话）。 */

	/** index.ts 注入：读取插件注册的常驻后台任务（并入 bg_servers 面板）。 */
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	/** index.ts 注入：停止插件任务（kill_background_server with taskId）。 */
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	private clients = new Map<string, ClientSession>();
	/** Quiesce (draining) state — the service refuses NEW work (prompts, forks,
	 *  session resumes, new clients) so a deploy/upgrade/backup can stop cleanly
	 *  once existing runs finish. Controlled via the local control socket:
	 *  `pi-web-ui server quiesce|unquiesce`. */
	private quiesced = false;
	private quiescedAt = 0;
	/** Attached browser sockets (reported by index.ts on open/close) — the
	 *  control socket reports real sockets, not cached client-session objects. */
	private socketCount = 0;
	private pending = new Map<string, Promise<ClientSession>>();
	private stateStore: ClientStateStore;
	private thinkingDurationStore: ThinkingDurationStore;
	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** 任意客户端成功切换工作区后触发（新绝对路径）。index.ts 接到
	 *  PluginManager.notifyCwd，让插件宿主的 host.cwd 实时跟随当前项目。 */
	onClientCwdChanged: ((cwd: string) => void) | undefined = undefined;

	constructor(
		private cwd: string,
		stateFile: string,
	) {
		this.stateStore = new ClientStateStore(stateFile);
		this.thinkingDurationStore = new ThinkingDurationStore(join(dirname(stateFile), "thinking-durations.json"));
	}

	/** Get or create the session for a client, racing attach calls safely. */
	/** True while the service is draining — new work is refused. */
	isQuiesced(): boolean {
		return this.quiesced;
	}

	/** Enter quiesce: stop admitting new work. Existing runs keep going. */
	quiesce(): void {
		this.quiesced = true;
		this.quiescedAt = Date.now();
	}

	/** Leave quiesce: admit new work again. */
	unquiesce(): void {
		this.quiesced = false;
		this.quiescedAt = 0;
	}

	/** Snapshot for the control socket / status command. */
	quiesceInfo(): { quiesced: boolean; quiescedSince?: number } {
		return this.quiesced
			? { quiesced: true, quiescedSince: this.quiescedAt }
			: { quiesced: false };
	}

	/** Aggregate across every client session: conversations with in-flight runs. */
	activeConversations(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.activeConversations();
		return n;
	}

	/** Aggregate across every client session: messages queued in the SDK. */
	pendingMessages(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.pendingMessages();
		return n;
	}

	/** index.ts calls this when a browser socket opens/closes. */
	noteSocketOpen(): void {
		this.socketCount += 1;
	}
	noteSocketClose(): void {
		this.socketCount = Math.max(0, this.socketCount - 1);
	}

	/** Full status for the control socket / `server status` command. */
	serviceStatus(): {
		pid: number;
		version: string;
		cwd: string;
		quiesced: boolean;
		quiescedSince?: number;
		connectedClients: number;
		activeConversations: number;
		pendingMessages: number;
	} {
		return {
			pid: process.pid,
			version: VERSION,
			cwd: this.cwd,
			...this.quiesceInfo(),
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
		};
	}

	/** Get or create the session for a client, racing attach calls safely. */
	async attach(
		clientId: string,
		send: (msg: ServerMessage) => void,
	): Promise<ClientSession> {
		let cs = this.clients.get(clientId);
		if (!cs) {
			const inflight = this.pending.get(clientId);
			if (inflight) {
				cs = await inflight;
			} else {
				// Restore this client's last-used workspace when it still exists;
				// Admission gate: while quiesced, only clients with an EXISTING
				// session may attach (they can watch their runs drain); brand-new
				// clients are refused — index.ts closes their socket (4403) and the
				// browser reconnect loop retries after admission reopens.
				if (this.quiesced) {
					throw new QuiesceRejectedError("新连接被拒绝，请等服务器恢复后重试");
				}
				// otherwise fall back to the server's configured default cwd.
				let cwd = this.cwd;
				const saved = this.stateStore.get(clientId);
				if (saved.lastCwd && saved.lastCwd !== this.cwd) {
					try {
						if (statSync(saved.lastCwd).isDirectory()) cwd = saved.lastCwd;
					} catch {
						// gone (unmounted drive / deleted) — fall back to the default
					}
				}
				// Sessions use the SDK default per-project dir — no per-client dir.
				const creating = ClientSession.create(
					clientId,
					cwd,
					this.stateStore,
					this.thinkingDurationStore,
				).finally(() => {
					this.pending.delete(clientId);
				});
				this.pending.set(clientId, creating);
				cs = await creating;
				this.clients.set(clientId, cs);
				// Make sure the restored/default workspace appears in the project list.
				this.stateStore.remember(clientId, cwd);
				if (cwd !== this.cwd) {
					send({
						type: "notice",
						level: "info",
						text: `已恢复上次的工作目录：${cwd}`,
					});
				}
			}
		}
		// First attach after a restart: report runs that were interrupted when
		// the previous process shut down (consumed once, then cleared). Queue
		// BEFORE attachSink so the notice rides the initial pending-notice flush.
		cs.notifyInterrupted(this.stateStore.takeInterrupted(clientId));
		cs.attachSink(send);
		// Forward hooks (set once by index.ts) to every session.
		cs.onQuit = this.onQuit;
		cs.onToolEvent = this.onToolEvent;

		cs.pluginBgTasksProvider = this.pluginBgTasksProvider;
		cs.pluginStopBgTask = this.pluginStopBgTask;
		cs.isQuiesced = () => this.quiesced;
		// 插件宿主工作区跟随：初次接入也同步一次（恢复的 lastCwd 可能≠服务启动目录），
		// notifyCwd 幂等去重；此后 set_cwd 成功时由 cs.onCwdChanged 继续驱动。
		cs.onCwdChanged = (abs) => this.onClientCwdChanged?.(abs);
		this.onClientCwdChanged?.(cs.cwd);
		return cs;
	}

	/** 插件 AI 工具集合变化（注册/注销）时由 index.ts 触发：推送到所有客户端的全部会话。 */

	/** 插件斜杠命令集合变化时由 index.ts 触发：重推各客户端的命令目录。 */

	/** 插件常驻后台任务变化时由 index.ts 触发：重推各客户端的 bg_servers。 */
	refreshBackgroundServers(): void {
		for (const cs of this.clients.values()) cs.refreshBgTasks();
	}

	/** Remove a socket from a client's broadcast set (called on socket close). */
	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		this.clients.get(clientId)?.detachSink(send);
	}

	get(clientId: string): ClientSession | undefined {
		return this.clients.get(clientId);
	}

	async disposeAll(): Promise<void> {
		// Record still-streaming conversations BEFORE tearing anything down, so
		// the next attach can tell the user what was lost (SIGTERM / update).
		for (const [clientId, cs] of [...this.clients]) {
			try {
				const running = cs.streamingSummaries();
				if (running.length > 0) {
					this.stateStore.saveInterrupted(
						clientId,
						running.map((r) => ({ ...r, at: Date.now() })),
					);
				}
			} catch {
				// best effort — never block shutdown on bookkeeping
			}
		}
		const all = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(all.map((cs) => cs.dispose()));
	}
}
