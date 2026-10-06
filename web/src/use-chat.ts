import { useT } from "./i18n";
import { localRecoveryClock } from "./recovery-clock";
import { emitTreeResponse, queueTreeDraft } from "./tree-events";
import { discardExtensionEditor, queueExtensionEditor } from "./extension-editor";
import type { UiMessage } from "./types";
import { mergeLiveToolOutput } from "./live-tool-output";
import { useCallback, useEffect, useReducer, useRef, useState, useMemo } from "react";
import { ProjectCache } from "./project-cache";
import { desktopAPI } from "./desktop";
import { randomUuid } from "./uuid";
import { withToken } from "./auth-token";
import type {
	ClientMessage,
	BgServer,
	CommandDef,
	ConversationSummary,
	FileContent,
	FileListing,
	FileSearchResult,

	ModelInfo,
	DirBrowse,
	ProjectSummary,
	ProviderStatus,
	ServerMessage,
	SessionSummary,
	SlashCommandInfo,
	ToolStatus,
	TerminalInfo,
	UiModelConfigEntry,
	UiPluginInfo,
	UiProviderConfig,
	UiSettingsState,
	UiState,
} from "./types";

import { applyMessageDelta, type MessageDeltaMsg } from "./message-delta";
import { emitPluginData } from "./plugin-loader";
import { PROTOCOL_VERSION } from "./protocol-version";

export type ConnStatus = "connecting" | "open" | "closed";

export interface Notice {
	conversationId?: string;
	id: number;
	level: "info" | "warning" | "error";
	text: string;
}

export type ReloadStatus = Extract<ServerMessage, { type: "reload_status" }>;

const RELOAD_EVENTS_KEY = "pi-web-ui:reload-events";
function restoreReloadEvents(): ReloadStatus[] {
	try {
		const events: unknown = JSON.parse(sessionStorage.getItem(RELOAD_EVENTS_KEY) ?? "[]");
		return Array.isArray(events) ? events.filter((event): event is ReloadStatus =>
			event && typeof event === "object" && event.type === "reload_status" &&
			typeof event.conversationId === "string" && typeof event.requestId === "string" &&
			(event.phase === "running" || event.phase === "done") && typeof event.timestamp === "number",
		).slice(-40) : [];
	} catch { return []; }
}

/** A terminal tab. The output stream itself lives in the xterm instance
 * (via the terminal bridge) — this is just the tab metadata. */
export interface TerminalMeta extends TerminalInfo {
	conversationId: string;
}

export interface ChatState {
	status: ConnStatus;
	/** True once the server confirmed the agent session is ready (hello processed). */
	ready: boolean;
	state: UiState | null;
	/** Live tool output accumulated from tool_delta messages, keyed by toolCallId. */
	liveOutputs: Map<string, { toolName: string; text: string; codemode?: UiMessage["codemode"] }>;
	/**
	 * Tools that FINISHED executing (tool_status from tool_execution_end), keyed
	 * by toolCallId. Lets the card show "done · waiting for the model" even
	 * while the session is still streaming. Cleared once the toolResult message
	 * lands in the snapshot (it carries the authoritative result).
	 */
	toolStatuses: Map<string, ToolStatus>;
	notices: Notice[];
	agentSilence: Extract<ServerMessage, { type: "agent_silence" }> | null;
	agentSilenceByConversation: Record<string, Extract<ServerMessage, { type: "agent_silence" }>>;
	serverVersion?: string;
	/** Persisted session list for the left panel. */
	sessions: SessionSummary[];
	/** Open conversations (each runs its own session in parallel). */
	conversations: ConversationSummary[];
	/** Id of the conversation the current snapshot belongs to. */
	activeConversationId: string;
	/** Recent workspaces this client opened (left panel project picker). */
	projects: ProjectSummary[];
	/** Latest workspace-picker listing (see browse_dirs), null until opened. */
	dirBrowse: DirBrowse | null;
	/** Workspace file listing for the right panel. */
	files: FileListing | null;
	conversationFilesChecked: Extract<ServerMessage, { type: "conversation_files_checked" }> | null;
	gitBranch: Extract<ServerMessage, { type: "git_branch" }> | null;
	/** Latest file content fetched for the preview panel (request-matched in the file editor). */
	fileContent: FileContent | null;
	promptResult: Extract<ServerMessage, { type: "prompt_result" }> | null;
	fileResult: Extract<ServerMessage, { type: "file_result" }> | null;

	/** Last dir-changed push from the server fs.watch (path = listed directory). */
	fileChanged: { path: string } | null;
	/** Models with valid auth, for the model dropdown. */
	models: ModelInfo[];
	/** True while a model list request is in flight. */
	modelsLoading: boolean;
	/** Custom providers from agentDir/models.json (model config panel). */
	modelsConfig: UiProviderConfig[];
	/** Built-in providers with auth status (key-only config). */
	providers: ProviderStatus[];
	/** Result of the last install_pi_agent run (null while not started/running). */
	installResult: { ok: boolean; detail: string } | null;
	/** Path completions for the cwd input. */
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	providerAuth: Extract<ServerMessage, { type: "provider_auth" }>["state"] | null;
	componentUpdates: Extract<ServerMessage, { type: "component_updates" }> | null;
	/** Self-update status (result of check_update). */
	update: {
		current: string;
		latest: string | null;
		latestPublishedAt: string | null;
		upToDate: boolean;
		error?: string;
	} | null;
	/** Extension widgets (TUI overlays bridged to the web UI). */
	widgets: { key: string; lines: string[] }[];
	/** Extension footer statuses (setStatus bridge). */
	statuses: { key: string; text: string | undefined }[];
	/** Active extension dialog (select/confirm/input) awaiting a response. */
	dialog: Extract<ServerMessage, { type: "dialog" }> | null;
	extensionUi: Record<string, { widgets?: ChatState["widgets"]; statuses?: ChatState["statuses"]; title?: string }>;
	pendingDialogs: Extract<ServerMessage, { type: "dialog" }>[];

	/** User command list from .pi/commands.json (terminal left panel). */
	commands: CommandDef[];
	commandsPath: string;
	/** Slash-command catalog for the chat input (builtin + extension +
	 *  template + skill). */
	slashCommands: SlashCommandInfo[];
	/** Open terminal tabs (metadata only; streams go through the bridge). */
	terminals: TerminalMeta[];
	/** Goal / review status (set via the goal bar). */

	/** Settings-panel state (system prompt, skill/extension toggles, presets). */
	settings: UiSettingsState | null;
	/** AI-started background servers (managed from the 后台任务 panel). The
	 *  list lives on the client session, so it survives conversation ends. */
	bgServers: BgServer[];
	/** Last fetch_models probe result (custom-provider model list), matched by
	 *  reqId in the model config modal. */
	fetchModelsResult: {
		reqId: number;
		ok: boolean;
		models?: UiModelConfigEntry[];
		error?: string;
	} | null;
	/** Last refresh_provider_models result (saved-provider list refresh). */
	refreshProviderResult: {
		reqId: number;
		ok: boolean;
		added?: number;
		total?: number;
		error?: string;
	} | null;
	/** Last clone_provider result (built-in → custom draft for the model
	 *  config modal to open pre-filled). */
	cloneProviderResult: {
		reqId: number;
		ok: boolean;
		config?: UiProviderConfig;
		error?: string;
	} | null;
	/** Last source-control query result (scm_status / scm_filediff /
	 *  scm_commit), matched by reqId in the SCM panel. */
	scmData: ServerMessage | null;
	/** Last global-search file query result, matched by reqId in the
	 *  global search panel (stale results with older reqIds are ignored). */
	fileSearch: {
		reqId: number;
		ok: boolean;
		results: FileSearchResult[];
		truncated?: boolean;
	} | null;
	/** Installed optional plugins (<dataDir>/plugins). Empty = none installed. */
	plugins: UiPluginInfo[];
	/** Server-side plugin reload counter (import-cache buster, see plugins msg). */
	pluginsEpoch: number;
	/** Increments when the server reports the watched git dir changed
	 *  outside the panel — SCMPanel refreshes on change while visible. */
	scmDirty: number;
	/** Server wire-protocol version differs from ours — the page was loaded
	 *  before/after an app update; show a persistent refresh banner. */
	protocolMismatch: boolean;
	/**
	 * Optimistic local echo of a just-sent prompt. The server is the single
	 * source of truth for `state.messages` — nothing here is ever treated as
	 * authoritative — but rendering this immediately on send means the user
	 * sees their own message the instant they hit Enter, instead of nothing
	 * happening until the round trip (SDK auth/compaction/extension-hook
	 * checks, then the model call) comes back. Cleared automatically the
	 * moment the next snapshot/snapshot_delta actually appends a message —
	 * see the "snapshot"/"snapshot_delta" reducer cases — never left to a
	 * timer, so it can't outlive or fight with the real message.
	 */
	pendingEcho: PendingEcho | null;
	reloadEvents: ReloadStatus[];
}

export interface PendingEcho {
	conversationId: string;
	text: string;
	ts: number;
}

type Action =
	| { type: "provider_auth"; state: Extract<ServerMessage, { type: "provider_auth" }>["state"] | null }
	| { type: "status"; status: ConnStatus }
	| { type: "snapshot"; state: UiState }
	| { type: "snapshot_delta"; msg: Extract<ServerMessage, { type: "snapshot_delta" }> }
	| { type: "protocol_mismatch" }
	| { type: "tool_delta"; toolCallId: string; toolName: string; delta: string; replace?: boolean; codemode?: UiMessage["codemode"] }
	| { type: "message_delta"; msg: MessageDeltaMsg }
	| { type: "tool_status"; status: ToolStatus }
	| { type: "notice"; notice: Notice }
	| { type: "agent_silence"; event: Extract<ServerMessage, { type: "agent_silence" }> }
	| { type: "reload_status"; event: ReloadStatus }
	| { type: "dismiss_notice"; id: number }
	| { type: "ready"; serverVersion: string; protocolVersion?: number }
	| { type: "sessions"; sessions: SessionSummary[] }
	| {
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
	  }
	| { type: "projects"; projects: ProjectSummary[] }
	| { type: "dir_browse"; dirBrowse: DirBrowse }
	| { type: "files"; files: FileListing }
	| { type: "conversation_files_checked"; result: Extract<ServerMessage, { type: "conversation_files_checked" }> }
	| { type: "git_branch"; data: Extract<ServerMessage, { type: "git_branch" }> }

	| { type: "file_changed"; path: string }
	| { type: "file_content"; content: FileContent }
	| { type: "prompt_result"; result: Extract<ServerMessage, { type: "prompt_result" }> }
	| { type: "file_result"; result: Extract<ServerMessage, { type: "file_result" }> }
	| { type: "models"; models: ModelInfo[]; loading: boolean }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	| { type: "fetch_models_result"; result: { reqId: number; ok: boolean; models?: UiModelConfigEntry[]; error?: string } }
	| { type: "refresh_provider_result"; result: { reqId: number; ok: boolean; added?: number; total?: number; error?: string } }
	| { type: "clone_provider_result"; result: { reqId: number; ok: boolean; config?: UiProviderConfig; error?: string } }
	| { type: "scm_data"; data: ServerMessage }
	| {
			type: "file_search_result";
			result: {
				reqId: number;
				ok: boolean;
				results: FileSearchResult[];
				truncated?: boolean;
			};
	  }
	| { type: "scm_changed" }
	| { type: "install_result"; result: { ok: boolean; detail: string } }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| {
			type: "update_status";
			status: {
				current: string;
				latest: string | null;
				latestPublishedAt: string | null;
				upToDate: boolean;
				error?: string;
			};
	  }
	| { type: "component_updates"; result: Extract<ServerMessage, { type: "component_updates" }> }
	| { type: "component_updates_start"; requestId: string; cwd: string; updating: boolean }
	| { type: "extension_ui"; message: Extract<ServerMessage, { type: "widgets" | "statuses" | "dialog" | "dialog_closed" | "extension_title" }> }

	| { type: "commands"; commands: CommandDef[]; path: string }
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "terminal_add"; meta: TerminalMeta }
	| { type: "terminal_remove"; id: string }
	| { type: "terminal_exit"; conversationId?: string; terminalId: string; exitCode: number | null }
	| { type: "terminal_restart"; terminalId: string }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }

	| { type: "settings"; settings: UiSettingsState }

	| { type: "bg_servers"; servers: BgServer[] }
	| { type: "plugins"; plugins: UiPluginInfo[]; epoch: number }
	| { type: "set_pending_echo"; echo: PendingEcho }
	| { type: "clear_pending_echo" };

const MAX_TERM_BUFFER = 200_000;

/** Initial (inactive) goal status before the server pushes the first one. */

/**
 * Bridges terminal output from the socket to live xterm instances. Output for
 * a terminal whose component isn't mounted yet (or that this tab doesn't know
 * about) is buffered (capped) so nothing is lost during mount/reconnect.
 */
interface TerminalWriter {
	write: (data: string) => void;
	dispose: () => void;
}

function makeTerminalBridge() {
	/** Multiple writers may subscribe to the same (conversation, terminal) pair —
	 *  e.g. the SCM panel's hidden query terminal parses output through its own
	 *  writer while a (hidden) xterm instance may also be registered for it.
	 *  A Set keeps them all: later registrations no longer shadow earlier ones. */
	const writers = new Map<string, Set<TerminalWriter>>();
	const buffers = new Map<string, string>();
	const key = (conversationId: string, terminalId: string) => `${conversationId}:${terminalId}`;
	return {
		write(conversationId: string, terminalId: string, data: string): void {
			const writerKey = key(conversationId, terminalId);
			const set = writers.get(writerKey);
			if (set && set.size > 0) {
				for (const w of set) {
					try {
						w.write(data);
					} catch {
						// best effort
					}
				}
				return;
			}
			const prev = buffers.get(writerKey) ?? "";
			const next =
				prev.length + data.length > MAX_TERM_BUFFER ? data : prev + data;
			buffers.set(writerKey, next);
		},
		/** Register a writer (xterm instance / output parser); flushes buffered
		 *  output to the new subscriber. Returns an unregister fn. */
		register(conversationId: string, terminalId: string, writer: TerminalWriter): () => void {
			const writerKey = key(conversationId, terminalId);
			let set = writers.get(writerKey);
			if (!set) {
				set = new Set();
				writers.set(writerKey, set);
			}
			set.add(writer);
			const buffered = buffers.get(writerKey);
			if (buffered) {
				try {
					writer.write(buffered);
				} catch {
					// best effort
				}
				buffers.delete(writerKey);
			}
			return () => {
				const s = writers.get(writerKey);
				if (s) {
					s.delete(writer);
					if (s.size === 0) writers.delete(writerKey);
				}
				buffers.delete(writerKey);
			};
		},
		clear(): void {
			writers.clear();
			buffers.clear();
		},
	};
}

function pruneLiveOutputs(
	live: Map<string, { toolName: string; text: string; codemode?: UiMessage["codemode"] }>,
	state: UiState,
): Map<string, { toolName: string; text: string; codemode?: UiMessage["codemode"] }> {
	const completed = new Set<string>();
	for (const m of state.messages) {
		if (m.role === "toolResult" && m.toolCallId) completed.add(m.toolCallId);
		// bashExecution transcript messages supersede live bash deltas
		if (m.role === "bashExecution") completed.add(`bash-${m.id}`);
	}
	let changed = false;
	for (const id of live.keys()) {
		if (completed.has(id)) {
			live.delete(id);
			changed = true;
		}
	}
	return changed ? new Map(live) : live;
}

/** Drop tool_status entries once the authoritative toolResult message lands.
 *  Builds the landed-id Set once (O(messages)) instead of scanning all
 *  messages per status entry (was O(statuses × messages) every snapshot). */
function pruneToolStatuses(
	statuses: Map<string, ToolStatus>,
	state: UiState,
): Map<string, ToolStatus> {
	if (statuses.size === 0) return statuses;
	const landed = new Set<string>();
	for (const m of state.messages) {
		if (m.role === "toolResult" && m.toolCallId) landed.add(m.toolCallId);
	}
	let changed = false;
	for (const [id, status] of statuses) {
		if (landed.has(id) || status.parentToolCallId && landed.has(status.parentToolCallId)) {
			statuses.delete(id);
			changed = true;
		}
	}
	return changed ? new Map(statuses) : statuses;
}

function reducer(state: ChatState, action: Action): ChatState {
	switch (action.type) {
		case "status":
			return {
				...state,
				status: action.status,
				pendingDialogs: action.status === "closed" ? [] : state.pendingDialogs,
				extensionUi: action.status === "closed" ? {} : state.extensionUi,
				// A new socket is not ready until its hello/ready round-trip completes.
				ready: action.status === "open" ? state.ready : false,
				agentSilence: action.status === "closed" ? null : state.agentSilence,
				agentSilenceByConversation: action.status === "closed" ? {} : state.agentSilenceByConversation,
				// PTYs are conversation-owned and survive socket reconnects. Clear only
				// the browser views so xterm writers remount when the server replays them.
				terminals: action.status === "closed" ? [] : state.terminals,
			};
		case "ready":
			return {
				...state,
				serverVersion: action.serverVersion,
				ready: true,
				// Old page + new server (or the reverse) after an in-place update:
				// WS handling on either side may be stale — banner asks for refresh.
				protocolMismatch:
					action.protocolVersion !== undefined &&
					action.protocolVersion !== PROTOCOL_VERSION,
			};
		case "snapshot":
			return {
				...state,
				ready: true,
				state: action.state,
				...(state.state?.cwd !== action.state.cwd ? { sessions: [], files: null, conversationFilesChecked: null, fileContent: null, scmData: null } : {}),
				activeConversationId: action.state.conversationId,
				agentSilence: action.state.isStreaming ? state.agentSilenceByConversation[action.state.conversationId] ?? null : null,
				liveOutputs: pruneLiveOutputs(state.liveOutputs, action.state),
				toolStatuses: pruneToolStatuses(state.toolStatuses, action.state),
				// A full resync always reflects reality as of now — whatever we
				// were optimistically echoing is either already in here or gone
				// (conversation switched away from under it).
				pendingEcho: null,
			};
		case "snapshot_delta": {
			// Incremental checkpoint from the server. Apply ONLY when it chains
			// cleanly onto our current rev; a mismatch (dropped message under
			// backpressure, stale tab) is ignored here — the ws handler schedules
			// a get_state resync. Immutable merge: appended messages extend the
			// array (element references preserved → React memo keeps working);
			// light fields replace wholesale.
			const ui = state.state;
			const d = action.msg;
			if (!ui || ui.conversationId !== d.conversationId || ui.rev !== d.baseRev)
				return state;
			const merged: UiState = {
				...ui,
				...d.state,
				messages:
					d.appended.length > 0 ? [...ui.messages, ...d.appended] : ui.messages,
			};
			return {
				...state,
				ready: true,
				state: merged,
				agentSilence: merged.isStreaming ? state.agentSilenceByConversation[merged.conversationId] ?? null : null,
				activeConversationId: merged.conversationId,
				liveOutputs: pruneLiveOutputs(state.liveOutputs, merged),
				toolStatuses: pruneToolStatuses(state.toolStatuses, merged),
				// Only clear once real messages actually landed — a delta that
				// merely updates existing fields (e.g. isStreaming flipping)
				// shouldn't drop the echo before the user's message has a real
				// counterpart to replace it with.
				pendingEcho: d.appended.length > 0 ? null : state.pendingEcho,
			};
		}
		case "tool_delta": {
			const prev = state.liveOutputs.get(action.toolCallId);
			const capped = mergeLiveToolOutput(prev?.text ?? "", action);
			const liveOutputs = new Map(state.liveOutputs);
			liveOutputs.set(action.toolCallId, {
				toolName: action.toolName,
				text: capped,
				codemode: action.codemode ?? prev?.codemode,
			});
			return { ...state, liveOutputs };
		}
		case "message_delta": {
			const ui = state.state;
			// Server only streams the active conversation, but filter defensively:
			// a late delta for another conversation must not clobber this view.
			if (!ui || ui.conversationId !== action.msg.conversationId) return state;
			// applyMessageDelta is pure/immutable (StrictMode double-invokes reducers).
			return { ...state, state: applyMessageDelta(ui, action.msg) };
		}
		case "tool_status":
			if (action.status.conversationId && state.state?.conversationId !== action.status.conversationId) return state;
			return {
				...state,
				toolStatuses: new Map(state.toolStatuses).set(
					action.status.toolCallId,
					{ ...state.toolStatuses.get(action.status.toolCallId), ...action.status },
				),
			};
		case "notice":
			return { ...state, notices: [...state.notices, action.notice].slice(-6) };
		case "agent_silence": {
			const byConversation = { ...state.agentSilenceByConversation };
			if (action.event.phase === "active") delete byConversation[action.event.conversationId];
			else byConversation[action.event.conversationId] = action.event;
			return { ...state, agentSilenceByConversation: byConversation, agentSilence: byConversation[state.activeConversationId] ?? null };
		}
		case "reload_status": {
			const existing = state.reloadEvents.findIndex((event) => event.requestId === action.event.requestId && event.conversationId === action.event.conversationId);
			const reloadEvents = existing < 0
				? [...state.reloadEvents, action.event].slice(-40)
				: state.reloadEvents.map((event, index) => index === existing ? action.event : event);
			return { ...state, reloadEvents };
		}
		case "dismiss_notice":
			return {
				...state,
				notices: state.notices.filter((n) => n.id !== action.id),
			};
		case "set_pending_echo":
			return { ...state, pendingEcho: action.echo };
		case "clear_pending_echo":
			return { ...state, pendingEcho: null };
		case "sessions":
			return { ...state, sessions: action.sessions };
		case "conversations":
			return {
				...state,
				conversations: action.conversations,
				activeConversationId: action.activeId,
			};
		case "projects":
			return { ...state, projects: action.projects };
		case "dir_browse":
			return { ...state, dirBrowse: action.dirBrowse };
		case "git_branch":
			return { ...state, gitBranch: action.data };
		case "files":
			return { ...state, files: action.files };
		case "conversation_files_checked":
			return { ...state, conversationFilesChecked: action.result };
		case "file_changed":
			return { ...state, fileChanged: { path: action.path } };
		case "prompt_result":
			return { ...state, promptResult: action.result };
		case "file_result":
			return { ...state, fileResult: action.result };
		case "file_content":
			return { ...state, fileContent: action.content };
		case "models":
			return { ...state, models: action.models, modelsLoading: action.loading };
		case "models_config":
			return { ...state, modelsConfig: action.providers };
		case "provider_auth":
			return { ...state, providerAuth: action.state };
		case "providers_status":
			return { ...state, providers: action.providers };
		case "fetch_models_result":
			return { ...state, fetchModelsResult: action.result };
		case "refresh_provider_result":
			return { ...state, refreshProviderResult: action.result };
		case "clone_provider_result":
			return { ...state, cloneProviderResult: action.result };
		case "install_result":
			return { ...state, installResult: action.result };
		case "scm_data":
			return { ...state, scmData: action.data };
		case "file_search_result":
			return { ...state, fileSearch: action.result };
		case "scm_changed":
			return { ...state, scmDirty: state.scmDirty + 1 };
		case "path_completions":
			return { ...state, pathCompletions: action.completions };
		case "component_updates_start":
			return { ...state, componentUpdates: { type: "component_updates", requestId: action.requestId, cwd: action.cwd, phase: action.updating ? "updating" : "checking", items: action.updating && state.componentUpdates?.cwd === action.cwd ? state.componentUpdates.items : [] } };
		case "component_updates":
			if (state.componentUpdates?.requestId !== action.result.requestId) return state;
			return { ...state, componentUpdates: { ...action.result, items: action.result.items.length ? action.result.items : state.componentUpdates.items } };
		case "update_status":
			return { ...state, update: action.status };
		case "extension_ui": {
			const m = action.message;
			if (m.type === "dialog") return { ...state, pendingDialogs: [...state.pendingDialogs.filter(d => d.id !== m.id), m] };
			if (m.type === "dialog_closed") return { ...state, pendingDialogs: state.pendingDialogs.filter(d => d.id !== m.id || d.conversationId !== m.conversationId) };
			return { ...state, extensionUi: { ...state.extensionUi, [m.conversationId]: { ...state.extensionUi[m.conversationId], ...(m.type === "widgets" ? { widgets: m.widgets } : m.type === "statuses" ? { statuses: m.statuses } : { title: m.title }) } } };
		}

		case "commands":
			return {
				...state,
				commands: action.commands,
				commandsPath: action.path,
			};
		case "slash_commands":
			return { ...state, slashCommands: action.commands };

		case "settings":
			return { ...state, settings: action.settings };
		case "bg_servers":
			return { ...state, bgServers: action.servers };
		case "plugins":
			return { ...state, plugins: action.plugins, pluginsEpoch: action.epoch };
		case "terminal_add":
			return { ...state, terminals: [...state.terminals, action.meta] };
		case "terminal_remove":
			return {
				...state,
				terminals: state.terminals.filter((t) => t.id !== action.id),
			};
		case "terminal_exit":
			if (
				action.conversationId &&
				(state.activeConversationId || state.state?.conversationId) &&
				action.conversationId !== (state.activeConversationId || state.state?.conversationId)
			) return state;
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId
						? { ...t, running: false, exitCode: action.exitCode }
						: t,
				),
			};
		case "terminal_restart":
			// The command is re-running in the same tab (server restarted the PTY).
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId
						? { ...t, running: true, exitCode: null }
						: t,
				),
			};
		case "terminal_list":
			if (
				action.conversationId &&
				(state.activeConversationId || state.state?.conversationId) &&
				action.conversationId !== (state.activeConversationId || state.state?.conversationId)
			) {
				return state;
			}
			return {
				...state,
				terminals: action.terminals.map((terminal) => ({
					...terminal,
					conversationId: action.conversationId ?? state.state?.conversationId ?? "",
				})),
			};
		default:
			return state;
	}
}

const CLIENT_ID_KEY = "pi-web-client-id";
let cachedClientId: string | null = null;

/**
 * 浏览器客户端标识每标签页独立；桌面单窗口使用主进程持久化的 ID。
 *
 * 曾用 localStorage：同源所有标签页共享同一 clientId，后端把它们挂到同一个
 * ClientSession 上互为镜像——B 标签页切换对话会同步切走 A 页、甚至把 A 页
 * 正在输出的 agent 强制中断且状态持久化（issue #10）。改为 sessionStorage 后
 * 新开标签页即新客户端；刷新本页仍保留同一 id，client-state（最近项目等）不丢。
 */
export function getClientId(): string {
	if (cachedClientId) return cachedClientId;
	let id: string | null = desktopAPI?.clientId ?? null;
	try {
		// Mirror the desktop identity for existing integrations; browser tabs stay isolated.
		if (id) sessionStorage.setItem(CLIENT_ID_KEY, id);
		id = id ?? sessionStorage.getItem(CLIENT_ID_KEY);
		if (!id) {
			id = randomUuid();
			sessionStorage.setItem(CLIENT_ID_KEY, id);
		}
	} catch {
		// storage 不可用（隐私模式等）：退化为页面生命周期内的一次性 id
		id = id ?? randomUuid();
	}
	cachedClientId = id;
	return id;
}

/** Resolve the WebSocket URL: same host when served by the backend, or the Vite proxy in dev. */
function wsUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return withToken(`${proto}//${location.host}/ws`);
}

export function useChat() {
	const t = useT();
	const translate = useRef(t); translate.current = t;
	const [chat, dispatch] = useReducer(reducer, {
		status: "connecting",
		ready: false,
		state: null,
		liveOutputs: new Map(),
		toolStatuses: new Map(),
		notices: [],
		agentSilence: null,
		agentSilenceByConversation: {},
		sessions: [],
		conversations: [],
		activeConversationId: "",
		projects: [],
		dirBrowse: null,
		files: null,
		conversationFilesChecked: null,
		gitBranch: null,

		fileChanged: null,
		fileContent: null,
		promptResult: null,
		fileResult: null,
		models: [],
		modelsLoading: false,
		modelsConfig: [],
		providers: [],
		installResult: null,
		pathCompletions: [],
		update: null,
		componentUpdates: null,
		providerAuth: null,
		extensionUi: {},
		pendingDialogs: [],
		widgets: [],
		statuses: [],
		dialog: null,
		commands: [],
		commandsPath: "",
		slashCommands: [],
		terminals: [],

		bgServers: [],
		settings: null,
		fetchModelsResult: null,
		refreshProviderResult: null,
		cloneProviderResult: null,
		scmData: null,
		fileSearch: null,
		scmDirty: 0,
		plugins: [],
		pluginsEpoch: 0,
		protocolMismatch: false,
		pendingEcho: null,
		reloadEvents: restoreReloadEvents(),
	});
	useEffect(() => {
		try { sessionStorage.setItem(RELOAD_EVENTS_KEY, JSON.stringify(chat.reloadEvents)); } catch { /* storage unavailable or full */ }
	}, [chat.reloadEvents]);
	const authoritative = useRef(chat);
	authoritative.current = chat;
	const cache = useRef(new ProjectCache<Pick<ChatState, "state" | "sessions" | "files">>());
	const [switching, setSwitching] = useState<{ id: string; path: string; display?: Pick<ChatState, "state" | "sessions" | "files"> } | null>(null);
	const switchRef = useRef(switching);
	const confirmedCwd = useRef("");
	const snapshotReady = useRef(false);
	const [hasSnapshot, setHasSnapshot] = useState(false);
	const acknowledged = useRef<string | null>(null);
	const [switchError, setSwitchError] = useState<string | null>(null);
	useEffect(() => {
		if (switching && acknowledged.current === switching.id && chat.state?.cwd === confirmedCwd.current) {
			switchRef.current = null;
			setSwitching(null);
		}
	}, [chat.state, switching]);
	useEffect(() => {
		if (!switching?.display) return;
		const frame = requestAnimationFrame(() => {
			performance.clearMeasures("project-switch:cached-content");
			performance.measure("project-switch:cached-content", "project-switch:click");
		});
		return () => cancelAnimationFrame(frame);
	}, [switching]);
	const wsRef = useRef<WebSocket | null>(null);
	/** Terminal output bridge (writers keyed by terminalId). */
	const bridgeRef = useRef(makeTerminalBridge());
	/** Reconnect backoff counter — ref so it never causes re-renders. */
	const retryRef = useRef(0);
	/** Pending reconnect timer. */
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** False once the hook is unmounted/cleaned up — stops stale onclose handlers from reconnecting. */
	const aliveRef = useRef(true);
	/** Last time any server message arrived — used to detect half-open connections. */
	const lastBeatRef = useRef(0);
	const noticeId = useRef(0);
	/** Stop requested while offline; replay only for the same still-running conversation. */
	const pendingAbortRef = useRef<string | null>(null);
	/** Last delta seq seen per conversation (message_delta + tool_delta share
	 *  one per-conversation sequence) — a gap on the ACTIVE conversation
	 *  triggers a one-shot get_state resync; background conversations converge
	 *  via snapshot when switched to. */
	const lastDeltaSeqRef = useRef<Map<string, number>>(new Map());
	const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** Debounced authoritative resync: get_state always returns a FULL snapshot.
	 *  Shared by delta-seq gap detection and snapshot_delta rev mismatch. */
	const scheduleResync = (): void => {
		if (resyncTimerRef.current) return;
		resyncTimerRef.current = setTimeout(() => {
			resyncTimerRef.current = null;
			const ws = wsRef.current;
			if (ws && ws.readyState === WebSocket.OPEN)
				ws.send(
					JSON.stringify({ type: "get_state" } satisfies ClientMessage),
				);
		}, 300);
	};

	const noteDeltaSeq = (conversationId: string, seq: number): void => {
		const map = lastDeltaSeqRef.current;
		const last = map.get(conversationId);
		if (last !== undefined && seq !== last + 1) {
			const c = authoritative.current;
			const active = c.activeConversationId || c.state?.conversationId;
			if (conversationId === active) {
				// Missed deltas (should not happen on a healthy WS) — resync via a
				// debounced get_state; keep patching meanwhile (the next snapshot
				// reconciles any drift).
				scheduleResync();
			}
		}
		map.set(conversationId, seq);
	};

	const pushNotice = useCallback((level: Notice["level"], text: string) => {
		const id = ++noticeId.current;
		dispatch({ type: "notice", notice: { id, level, text } });
		// 自动消失计时由通知组件（NoticeToast）管理：悬浮暂停、移开继续。
	}, []);

	const send = useCallback((msg: ClientMessage) => {
		const ws = wsRef.current;
		if (msg.type === "abort" && (!ws || ws.readyState !== WebSocket.OPEN || !snapshotReady.current)) {
			const conversationId = authoritative.current.state?.conversationId;
			if (!conversationId) return false;
			pendingAbortRef.current = conversationId;
			return true;
		}
		if (ws && ws.readyState === WebSocket.OPEN) {
			if (!snapshotReady.current && msg.type !== "get_state") return false;
			if (msg.type === "check_component_updates" || msg.type === "update_component") dispatch({ type: "component_updates_start", requestId: msg.requestId, cwd: authoritative.current.state?.cwd ?? "", updating: msg.type === "update_component" });
			if (msg.type === "set_cwd") {
				const current = authoritative.current;
				const display = cache.current.get(msg.path);
				if (!switchRef.current && current.state) cache.current.set(current.state.cwd, {
					state: current.state, sessions: current.sessions, files: current.files,
				});
				setSwitchError(null);
				const id = randomUuid();
				const pending = { id, path: msg.path, display };
				switchRef.current = pending;
				setSwitching(pending);
				performance.clearMarks("project-switch:click");
				performance.mark("project-switch:click");
				msg = { ...msg, requestId: id };
			} else if (switchRef.current && msg.type !== "get_state") {
				return false;
			}
			ws.send(JSON.stringify(msg));
			return true;
		}
		return false;
	}, []);

	/** Stable across renders — the reconnect loop lives entirely inside this closure. */
	const connect = useCallback(() => {
		if (!aliveRef.current) return;
		dispatch({ type: "status", status: "connecting" });
		const ws = new WebSocket(wsUrl());
		wsRef.current = ws;

		ws.onopen = () => {
			if (wsRef.current !== ws) return; // stale socket
			dispatch({ type: "status", status: "open" });
			retryRef.current = 0;
			lastBeatRef.current = Date.now();
			ws.send(
				JSON.stringify({
					type: "hello",
					clientId: getClientId(),
				} satisfies ClientMessage),
			);
		};

		ws.onmessage = (ev) => {
			if (wsRef.current !== ws) return; // stale socket
			lastBeatRef.current = Date.now(); // any traffic proves the connection is alive
			let msg: ServerMessage;
			try {
				msg = JSON.parse(ev.data as string) as ServerMessage;
			} catch {
				return;
			}
			switch (msg.type) {
				case "node_event":
					window.dispatchEvent(new CustomEvent("pi-node-event", { detail: msg }));
					break;
				case "ready":
					dispatch({
						type: "ready",
						serverVersion: msg.serverVersion,
						protocolVersion: msg.protocolVersion,
					});
					// Ensure a fresh snapshot on (re)connect.
					ws.send(
						JSON.stringify({ type: "get_state" } satisfies ClientMessage),
					);
					// Sessions + recent projects are LAZY: LeftPanel requests them
					// when it is actually shown — listing scans every session file
					// on disk (listAll scans ALL projects), too heavy for the
					// connect critical path.
					ws.send(
						JSON.stringify({ type: "list_models" } satisfies ClientMessage),
					);
					ws.send(
						JSON.stringify({ type: "list_commands" } satisfies ClientMessage),
					);
					ws.send(
						JSON.stringify({ type: "get_commands" } satisfies ClientMessage),
					);
					ws.send(
						JSON.stringify({ type: "check_update" } satisfies ClientMessage),
					);
					break;
				case "cwd_result":
					if (msg.requestId === switchRef.current?.id) {
						confirmedCwd.current = msg.cwd;
						acknowledged.current = msg.requestId;
						if (!msg.ok) setSwitchError(switchRef.current.path);
						if (!msg.ok || authoritative.current.state?.cwd === msg.cwd) {
							switchRef.current = null;
							setSwitching(null);
						} else {
							// The snapshot may be queued in React or retried after backpressure.
							ws.send(JSON.stringify({ type: "get_state" }));
						}
					}
					break;
				case "snapshot":
					snapshotReady.current = true;
					setHasSnapshot(true);
					if (!switchRef.current) confirmedCwd.current = msg.state.cwd;
					if (switchRef.current && acknowledged.current === switchRef.current.id && confirmedCwd.current === msg.state.cwd) {
						switchRef.current = null;
						setSwitching(null);
					}
					// Snapshot is authoritative — delta sequence tracking restarts.
					lastDeltaSeqRef.current = new Map();
					dispatch({ type: "snapshot", state: { ...msg.state, recovery: localRecoveryClock(msg.state.recovery) } });
					if (pendingAbortRef.current) {
						const shouldAbort = pendingAbortRef.current === msg.state.conversationId && msg.state.isStreaming;
						pendingAbortRef.current = null;
						if (shouldAbort) ws.send(JSON.stringify({ type: "abort" } satisfies ClientMessage));
					}
					break;
				case "snapshot_delta": {
					// Gap detection BEFORE dispatch: if this incremental checkpoint
					// doesn't chain onto our current rev (a message was dropped under
					// backpressure, or we're stale), schedule one debounced full resync.
					const cur = authoritative.current.state;
					if (
						!cur ||
						cur.conversationId !== msg.conversationId ||
						cur.rev !== msg.baseRev
					)
						scheduleResync();
					dispatch({ type: "snapshot_delta", msg: { ...msg, state: { ...msg.state, recovery: localRecoveryClock(msg.state.recovery) } } });
					break;
				}
				case "tool_delta":
					noteDeltaSeq(msg.conversationId, msg.seq);
					dispatch({
						type: "tool_delta",
						toolCallId: msg.toolCallId,
						toolName: msg.toolName,
						delta: msg.delta,
						replace: msg.replace,
						codemode: msg.codemode,
					});
					break;
				case "tool_status":
					dispatch({ type: "tool_status", status: msg });
					break;
				case "message_delta": {
					noteDeltaSeq(msg.conversationId, msg.seq);
					dispatch({ type: "message_delta", msg });
					break;
				}
				case "notice": {
					if ((!msg.conversationId || msg.conversationId === authoritative.current.activeConversationId) && /MCP|mcp/i.test(msg.text)) window.dispatchEvent(new CustomEvent("pi-mcp-notice", { detail: msg.text }));
					const id = ++noticeId.current;
					dispatch({
						type: "notice",
						notice: { id, conversationId: msg.conversationId, level: msg.level, text: msg.text },
					});
					break;
				}
				case "agent_silence":
					dispatch({ type: "agent_silence", event: msg });
					break;
				case "reload_status":
					dispatch({ type: "reload_status", event: msg });
					break;
				case "sessions":
					if (msg.cwd !== confirmedCwd.current) break;
					dispatch({ type: "sessions", sessions: msg.sessions });
					break;
				case "conversations":
					if (authoritative.current.state?.conversationId !== msg.activeId) scheduleResync();
					dispatch({
						type: "conversations",
						conversations: msg.conversations,
						activeId: msg.activeId,
					});
					break;
				case "projects":
					dispatch({ type: "projects", projects: msg.projects });
					break;
				case "dir_browse":
					dispatch({
						type: "dir_browse",
						dirBrowse: {
							path: msg.path,
							parent: msg.parent,
							dirs: msg.dirs,
							truncated: msg.truncated,
						},
					});
					break;
				case "git_branch":
					if (msg.cwd !== confirmedCwd.current || switchRef.current) break;
					dispatch({ type: "git_branch", data: msg });
					break;
				case "files":
					if (msg.cwd !== confirmedCwd.current) break;
					dispatch({ type: "files", files: msg });
					break;
				case "conversation_files_checked":
					if (msg.cwd !== confirmedCwd.current) break;
					dispatch({ type: "conversation_files_checked", result: msg });
					break;
				case "file_changed":
					dispatch({ type: "file_changed", path: msg.path });
					break;
				case "prompt_result":
					dispatch({ type: "prompt_result", result: msg });
					break;
				case "file_result":
					dispatch({ type: "file_result", result: msg });
					break;
				case "file_content":
					if (msg.cwd !== confirmedCwd.current || switchRef.current) break;
					dispatch({ type: "file_content", content: msg });
					break;
				case "models":
					dispatch({ type: "models", models: msg.models, loading: false });
					break;
				case "models_config":
					dispatch({ type: "models_config", providers: msg.providers });
					break;
				case "native_mcp_result":
					window.dispatchEvent(new CustomEvent("pi-native-mcp-event", { detail: msg }));
					break;
				case "provider_auth":
					dispatch({ type: "provider_auth", state: msg.state });
					break;
				case "providers_status":
					dispatch({ type: "providers_status", providers: msg.providers });
					break;
				case "fetch_models_result":
					dispatch({
						type: "fetch_models_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							models: msg.models,
							error: msg.error,
						},
					});
					break;
				case "refresh_provider_result":
					dispatch({
						type: "refresh_provider_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							added: msg.added,
							total: msg.total,
							error: msg.error,
						},
					});
					break;
				case "clone_provider_result":
					dispatch({
						type: "clone_provider_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							config: msg.config,
							error: msg.error,
						},
					});
					break;
				case "scm_data":
					if (msg.cwd !== confirmedCwd.current || switchRef.current) break;
					dispatch({ type: "scm_data", data: msg });
					break;
				case "search_files_result":
					if (msg.cwd !== confirmedCwd.current || switchRef.current) break;
					dispatch({
						type: "file_search_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							results: msg.results,
							truncated: msg.truncated,
						},
					});
					break;
				case "scm_changed":
					dispatch({ type: "scm_changed" });
					break;
				case "install_result":
					dispatch({ type: "install_result", result: msg });
					break;
				case "path_completions":
					dispatch({ type: "path_completions", completions: msg.completions });
					break;
				case "component_updates":
					dispatch({ type: "component_updates", result: msg });
					break;
				case "update_status":
					dispatch({ type: "update_status", status: msg });
					break;
				case "widgets":
				case "statuses":
				case "dialog":
				case "dialog_closed":
				case "extension_title":
					dispatch({ type: "extension_ui", message: msg });
					break;
				case "extension_ui_reset":
					discardExtensionEditor(msg.conversationId);
					break;
				case "tree": case "tree_changed": case "tree_open": case "tree_content_result": case "tree_preview_result": case "tree_navigate_result":
					if (msg.type === "tree_navigate_result") {
						if (msg.reqId.startsWith("edit-") && msg.status !== "ok") dispatch({ type: "notice", notice: {
							id: ++noticeId.current, conversationId: msg.conversationId, level: "warning",
							text: msg.error ?? translate.current(msg.status === "busy" ? "editBusy" : "editFailed"),
						} });
						const restored = [...(msg.restoredQueue?.steering ?? []), ...(msg.restoredQueue?.followUp ?? [])];
						if (msg.editorText && !msg.reqId.startsWith("edit-")) restored.push(msg.editorText);
						queueTreeDraft({ id: msg.reqId, conversationId: msg.conversationId, text: restored.join("\n\n"), images: msg.restoredQueue?.images });
					}
					emitTreeResponse(msg);
					break;
				case "queue_recalled":
					queueTreeDraft({ id: msg.requestId, conversationId: msg.conversationId, text: msg.text, images: msg.images });
					ws.send(JSON.stringify({ type: "queue_recall_ack", conversationId: msg.conversationId, requestId: msg.requestId }));
					break;
				case "extension_editor":
					queueExtensionEditor(msg);
					break;

				case "terminal_output":
					bridgeRef.current.write(
						msg.conversationId ?? authoritative.current.activeConversationId,
						msg.terminalId,
						msg.data,
					);
					break;
				case "terminal_exit":
					dispatch({
						type: "terminal_exit",
						conversationId: msg.conversationId,
						terminalId: msg.terminalId,
						exitCode: msg.exitCode,
					});
					break;
				case "terminal_list":
					dispatch({
						type: "terminal_list",
						conversationId: msg.conversationId,
						terminals: msg.terminals,
					});
					break;
				case "commands":
					if (msg.cwd !== confirmedCwd.current || switchRef.current) break;
					dispatch({
						type: "commands",
						commands: msg.commands,
						path: msg.path,
					});
					break;
				case "slash_commands":
					dispatch({ type: "slash_commands", commands: msg.commands });
					break;

				case "settings_state":
					dispatch({ type: "settings", settings: msg.settings });
					break;
				case "bg_servers":
					dispatch({ type: "bg_servers", servers: msg.servers });
					break;
				case "plugins":
					dispatch({ type: "plugins", plugins: msg.plugins, epoch: msg.epoch });
					break;
				case "plugin_data":
					emitPluginData(msg.pluginId, msg.payload);
					break;
				default:
					break;
			}
		};

		ws.onclose = () => {
			if (wsRef.current === ws) wsRef.current = null;
			// Terminals died with the server-side PTYs — drop writers/buffers.
			bridgeRef.current.clear();
			// Cleanup closed this socket on purpose — do not reconnect.
			if (!aliveRef.current) return;
			// A newer socket already took over (e.g. a StrictMode remount raced
			// this socket's close) — do not spawn a third connection that would
			// shadow the live one and drop its incoming messages.
			if (wsRef.current && wsRef.current !== ws) return;
			switchRef.current = null;
			setSwitching(null);
			snapshotReady.current = false;
			setHasSnapshot(false);
			dispatch({ type: "status", status: "closed" });
			// Reconnect with exponential backoff (1s → 2s → 4s → … capped at 10s).
			const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
			retryRef.current += 1;
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				connect();
			}, delay);
		};

		ws.onerror = () => {
			// onclose fires after onerror, triggering reconnect.
			// Do NOT call ws.close() here: it's redundant and causes a browser
			// warning "WebSocket is closed before the connection is established"
			// when the connection is still in CONNECTING state.
		};
	}, []);

	// Mount once; all reconnection is self-contained in `connect`.
	useEffect(() => {
		aliveRef.current = true;
		connect();
		// Watchdog: if no server message arrives for 30s, assume the connection is
		// half-open and force a close, which triggers the normal reconnect path.
		const watchdog = setInterval(() => {
			if (!aliveRef.current) return;
			const ws = wsRef.current;
			if (
				ws &&
				ws.readyState === WebSocket.OPEN &&
				Date.now() - lastBeatRef.current > 30_000
			) {
				ws.close();
			}
		}, 5_000);
		return () => {
			aliveRef.current = false;
			clearInterval(watchdog);
			if (resyncTimerRef.current) {
				clearTimeout(resyncTimerRef.current);
				resyncTimerRef.current = null;
			}
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			wsRef.current?.close();
			wsRef.current = null;
		};
	}, [connect]);

	const dismissNotice = useCallback(
		(id: number) => dispatch({ type: "dismiss_notice", id }),
		[],
	);

	/** See ChatState.pendingEcho — call right alongside send({type:"prompt",…}). */
	const setPendingEcho = useCallback(
		(conversationId: string, text: string) =>
			dispatch({
				type: "set_pending_echo",
				echo: { conversationId, text, ts: Date.now() },
			}),
		[],
	);

	// -- terminal tab management ----------------------------------------------

	const terminalCreate = useCallback(
		(meta: TerminalMeta) => dispatch({ type: "terminal_add", meta }),
		[],
	);
	const terminalClose = useCallback(
		(id: string) => dispatch({ type: "terminal_remove", id }),
		[],
	);
	const terminalRestart = useCallback(
		(id: string) => dispatch({ type: "terminal_restart", terminalId: id }),
		[],
	);
	const terminalRegister = useCallback(
		(conversationId: string, id: string, writer: TerminalWriter) =>
			bridgeRef.current.register(conversationId, id, writer),
		[],
	);

	const terminalApi = useMemo(() => ({
		create: terminalCreate,
		close: terminalClose,
		register: terminalRegister,
		restart: terminalRestart,
	}), [terminalCreate, terminalClose, terminalRegister, terminalRestart]);

	const chatApi = useRef({
		chat,
		send,
		pushNotice,
		dismissNotice,
		setPendingEcho,
		terminal: terminalApi,
	});
	chatApi.current = {
		chat,
		send,
		pushNotice,
		dismissNotice,
		setPendingEcho,
		terminal: terminalApi,
	};
	const extension = chat.extensionUi[chat.activeConversationId];
	useEffect(() => { document.title = extension?.title || "pi-web-ui"; }, [extension?.title]);
	const scopedChat = { ...chat, notices: chat.notices.filter(n => !n.conversationId || n.conversationId === chat.activeConversationId), widgets: extension?.widgets ?? [], statuses: extension?.statuses ?? [], dialog: chat.pendingDialogs.find(d => d.conversationId === chat.activeConversationId) ?? null };
	const displayChat = switching ? {
		...chat,
		state: switching.display?.state ?? null,
		sessions: switching.display?.sessions ?? [],
		files: switching.display?.files ?? null,
		activeConversationId: switching.display?.state?.conversationId ?? `pending:${switching.path}`,
		ready: false,
		liveOutputs: new Map(),
		toolStatuses: new Map(),
		dialog: null,
	} : { ...scopedChat, ready: chat.ready && hasSnapshot, files: chat.files ?? cache.current.get(chat.state?.cwd ?? "")?.files ?? null };
	return {
		...chatApi.current, chat: displayChat, switching: switching?.path ?? null, switchError };
}
