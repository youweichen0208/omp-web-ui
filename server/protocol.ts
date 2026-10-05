/**
 * Wire protocol between the browser client and the pi-web-ui server.
 * Pure JSON over WebSocket. The web frontend mirrors these types in
 * web/src/types.ts (kept in sync by hand — types only, no shared runtime code).
 */

// ---------------------------------------------------------------------------
// Serialized messages (server -> client snapshot)
// ---------------------------------------------------------------------------

export interface UiTextBlock {
	type: "text";
	text: string;
	truncated?: boolean;
}

export interface UiThinkingBlock {
	type: "thinking";
	thinking: string;
	/** Observed server duration; absent for older sessions without timing data. */
	durationMs?: number;
}

export interface UiToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	argumentsText?: string;
	argumentsTruncated?: boolean;
}

export interface UiImageBlock {
	type: "image";
	dataUrl?: string;
	mimeType?: string;
}

/** Live bash execution (the `!` command / bashExecution transcript message). */
export interface UiBashBlock {
	type: "bash";
	command: string;
	output: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
}

export type UiContentBlock =
	| UiTextBlock
	| UiThinkingBlock
	| UiToolCallBlock
	| UiImageBlock
	| UiBashBlock
	| { type: string; [k: string]: unknown };

/** Allowlisted todo result for chat presentation; never includes extension metadata. */
export interface UiTodoSnapshot {
	action?: string;
	error?: string;
	tasks: { id: number; subject: string; status: "pending" | "in_progress" | "completed" | "deleted" }[];
}

export interface UiCodemodeDetails {
	calls: { id: string; name: string; args: string; status: "running" | "ok" | "error" | "cancelled"; durationMs?: number; error?: string; cost?: number }[];
	totalCalls: number;
	fullOutputPath?: string;
}

export interface UiNestedToolCall {
	id: string;
	name: string;
	argumentsText?: string;
	argumentsBytes?: number;
	status: "ok" | "error" | "unfinished";
	durationMs?: number;
	error?: string;
}

export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
export interface UiTreeSiblings {
	index: number;
	count: number;
	prevTarget?: string;
	nextTarget?: string;
}
export interface UiTreeNode {
	id: string;
	parentId: string | null;
	visibleParentId: string | null;
	depth: number;
	rootId: string;
	kind: "user" | "assistant" | "tool" | "compaction" | "branchSummary" | "custom" | "model" | "thinking" | "info" | "contextEdit" | "label";
	preview: string;
	timestamp: number;
	label?: string;
	onActivePath: boolean;
	isLeaf: boolean;
	childCount: number;
	toolName?: string;
	model?: string;
	stopReason?: "error" | "aborted";
	summaryFromId?: string;
}
export interface UiTreeState {
	revision: string;
	leafId: string | null;
	branchPoints: number;
	rootCount: number;
	filterMode: TreeFilterMode;
	skipSummaryPrompt: boolean;
	externallyModified: boolean;
	busy: boolean;
}
export type TreeRequest =
	| { type: "tree_get"; conversationId: string; reqId: string; filter?: TreeFilterMode; query?: string }
	| { type: "tree_content"; conversationId: string; reqId: string; entryId: string }
	| { type: "tree_preview"; conversationId: string; reqId: string; targetId: string }
	| { type: "tree_navigate"; conversationId: string; reqId: string; targetId: string; summary: "none" | "default" | "custom"; customInstructions?: string; replaceInstructions?: boolean; label?: string; abortRunning?: boolean }
	| { type: "tree_label"; conversationId: string; reqId: string; entryId: string; label: string | null }
	| { type: "session_clone"; conversationId: string; reqId: string }
	| { type: "session_fork"; conversationId: string; reqId: string; entryId: string; position: "before" | "at" }
	| { type: "session_reopen"; conversationId: string; reqId: string };
export type TreeResponse =
	| { type: "tree"; conversationId: string; reqId: string; revision: string; leafId: string | null; nodes: UiTreeNode[]; truncated: boolean }
	| { type: "tree_changed"; conversationId: string; revision: string; branchPoints: number }
	| { type: "tree_open"; conversationId: string; mode: "tree" | "fork" }
	| { type: "tree_content_result"; conversationId: string; reqId: string; entryId: string; content: string }
	| { type: "tree_preview_result"; conversationId: string; reqId: string; entryCount?: number; commonAncestorId?: string | null }
	| { type: "tree_navigate_result"; conversationId: string; reqId: string; status: "ok" | "cancelled" | "aborted" | "busy" | "error"; editorText?: string; restoredQueue?: { steering: string[]; followUp: string[] }; error?: string };

export interface UiMessage {
	entryId?: string;
	siblings?: UiTreeSiblings;
	label?: string;
	/** Stable-ish id for React keys: u-<ts>-<seq> / a-<ts>-<seq> / t-<toolCallId>. */
	id: string;
	role: string;
	content: UiContentBlock[];
	timestamp?: number;
	model?: string;
	provider?: string;
	stopReason?: string;
	/** Provider-reported usage for one assistant response. */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	errorMessage?: string;
	/** Present on toolResult messages; links to the assistant message's toolCall block. */
	toolCallId?: string;
	toolName?: string;
	toolOutputUrl?: string;
	isError?: boolean;
	todoSnapshot?: UiTodoSnapshot;
	nestedCalls?: { calls: UiNestedToolCall[]; complete: boolean };
	codemode?: UiCodemodeDetails;
	/** Extension-injected custom messages. */
	customType?: string;
	/** Extension-provided metadata (e.g. attachment file name/path). */
	details?: unknown;
}

/** Current task inferred from the authoritative transcript. P0 has one task
 * per active conversation; historical tasks and explicit plans come later. */
export interface TaskProgress {
	id: string;
	conversationId: string;
	sourceMessageId: string;
	title: string;
	status: "running" | "waiting" | "done" | "failed" | "cancelled";
	startedAt: number;
	/** Last recorded reply/tool timestamp for a completed turn. */
	endedAt?: number;
	completed: number;
	steps: TaskStep[];
	/** Explicit todo state, or a legacy task_plan transcript. */
	plan?: {
		source?: "todo";
		origin?: string;
		revision: number;
		added: number;
		removed: number;
		title?: string;
		completionCriteria?: string;
		changeSummary?: string;
		changes?: { kind: "added" | "removed" | "updated"; title: string; position?: number }[];
		items: { id: string; title: string; detail?: string; toolCallIds?: string[]; blockedBy?: string[]; status: "pending" | "running" | "done" | "removed"; added?: boolean; startedAt?: number; endedAt?: number; actions?: { read: number; write: number; edit: number; command: number } }[];
	};
}

export interface TaskStep {
	id: string;
	messageId: string;
	title: string;
	/** Short action summary; never a full assistant reply. */
	detail?: string;
	status: "running" | "done" | "failed";
	startedAt: number;
	endedAt?: number;
	hint?: string;
	artifacts: { toolCallId: string; kind: string; label: string; path?: string; outputLines?: number }[];
}

export interface UiModelInfo {
	id: string;
	name: string;
	provider: string;
	/** Whether the model accepts image input (SDK `input` includes "image"). */
	vision: boolean;
}

export interface UiRecovery {
	branch?: { id: string };
	compaction?: { id: string; reason: "manual" | "threshold" | "overflow" };
	retry?: { id: string; phase: "waiting" | "running"; attempt: number; maxAttempts: number; deadline: number; error: string };
	summary?: { id: string; source: "compaction" | "branchSummary"; phase: "waiting" | "running"; attempt?: number; maxAttempts?: number; deadline?: number; error?: string };
}

export interface UiState {
	tree?: UiTreeState;
	recovery?: UiRecovery;
	runSettings?: { autoCompaction: boolean; autoRetry: boolean };
	clientId: string;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	/** Id of the ACTIVE conversation (see `conversations` message). */
	conversationId: string;
	/** Command-driven workspace changes stored in this session's transcript. */
	cwdEvents: { cwd: string; timestamp: number }[];
	/** Monotonic snapshot revision — increments on every snapshot/snapshot_delta
	 *  emission. snapshot_delta.baseRev must equal the client's current rev;
	 *  a mismatch means the client missed an update and must get_state resync. */
	rev: number;
	messages: UiMessage[];
	/**
	 * Live partial assistant message while a run is streaming. The SDK keeps the
	 * in-progress message in agent.state.streamingMessage — it only enters
	 * `messages` once the turn finishes (message_end). Null when idle.
	 */
	streamingMessage: UiMessage | null;
	/** Server-derived current task; null before the first user prompt. */
	taskProgress?: TaskProgress | null;
	isStreaming: boolean;
	model: UiModelInfo | null;
	routedModel?: UiModelInfo & { thinkingLevel?: string };
	thinkingLevel: string;
	/**
	 * Thinking levels the CURRENT model actually supports (SDK clamps any
	 * request outside this set). The UI must only offer these — selecting an
	 * unsupported level silently snaps to a nearby one, which reads as "cannot
	 * change the level". Empty/absent → fall back to the full list.
	 */
	availableThinkingLevels: string[];
	/** Queued prompt TEXTS per conversation. steering = 插队（当前回合结算后
	 *  立即注入），followUp = 排队（整个 run 结束后才发送）。UI renders them
	 *  as pending user bubbles in the real message list. */
	queue: { steering: string[]; followUp: string[] };
	errorMessage?: string;
	tools: string[];
	/** Monotonic snapshot sequence — clients can use it to drop stale snapshots. */
	version: number;
	/**
	 * Whether the pi agent config looks ready (agentDir + auth.json with at
	 * least one provider credential). False → the client should offer the
	 * one-time setup flow.
	 */
	piConfigured: boolean;
	/**
	 * Whether the pi CLI binary is installed and runnable (`pi --version`
	 * probe). True → the setup modal skips the install step and offers the
	 * API key form directly; false → offer auto-install first.
	 */
	piAgentInstalled: boolean;
	/** Live session stats for the footer status bar. */
	stats: {
		totalMessages: number;
		tokens: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		cost: number;
		contextUsage: {
			tokens: number | null;
			contextWindow: number;
			percent: number | null;
		};
		/** Estimated allocation of the current context; providers report only totals. */
		contextParts?: { system: number; tools: number; conversation: number; attachments: number } | null;
	};
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** A user-defined command shown in the terminal command list (.pi/commands.json). */
export interface CommandDef {
	name: string;
	/** Shell command to run in the terminal. */
	command: string;
	/** Working directory; supports ${pwd} (= the agent's current workspace dir). */
	cwd?: string;
}

/** Metadata for a persistent PTY owned by one conversation. */
export interface TerminalInfo {
	id: string;
	title: string;
	cwd: string;
	cols: number;
	rows: number;
	running: boolean;
	exitCode: number | null;
	/** Command that started this terminal, when it came from the command list. */
	command?: CommandDef;
}

/** A slash command available in the chat input (the web counterpart of the
 *  pi CLI's "/" command menu). Names carry no leading slash. */
export interface SlashCommandInfo {
	/** Invokable command name without the leading slash (e.g. "new",
	 *  "skill:review", "templatename"). Extension collisions with builtin
	 *  names are suffixed by the SDK ("new:2"), like the CLI. */
	name: string;
	description?: string;
	descriptionEn?: string;
	/** Argument placeholder shown in the picker (e.g. "<路径>", "[说明]"). */
	argumentHint?: string;
	argumentHintEn?: string;
	/** Where the command comes from: web-native builtin / SDK extension /
	 *  prompt template / skill / UI plugin（registerCommand）。 */
	source: "builtin" | "extension" | "prompt" | "skill" | "plugin";
}

/** Attachment spec shared by "prompt" and "edit_message" client messages:
 *  workspace-path attachments (inline/reference/lines), raw pasted/dropped
 *  images (imageData) and raw uploaded files (fileData). */
export interface PromptAttachment {
	editorSnapshot?: { cwd: string; text: string; dirty: boolean; version?: string };
	path: string;
	mode?: "inline" | "reference" | "lines";
	/** 1-based inclusive line range (mode "lines" only). */
	lines?: { start: number; end: number };
	/**
	 * Raw image data (base64, no data: prefix) for images pasted, dropped or
	 * uploaded directly in the browser — no workspace path involved. When
	 * present the server sends it to the model as image content and ignores
	 * path/mode.
	 */
	imageData?: string;
	/**
	 * Raw uploaded file bytes (base64, no data: prefix) for files dropped/
	 * uploaded directly in the browser — no workspace path involved. The
	 * server persists them under the data dir and attaches as a path
	 * reference (or inlines small text files).
	 */
	fileData?: string;
	/**
	 * Absolute path of a previously-UPLOADED file (fileData) that was
	 * persisted under the data dir's uploads/ folder. When the browser
	 * restores an uploaded file while editing & re-asking a question it
	 * re-sends the server-generated upload path instead of the original
	 * base64 — the server re-reads the bytes from disk (no base64
	 * round-trip / snapshot bloat). Mutually exclusive with imageData /
	 * fileData / path.
	 */
	uploadPath?: string;
	mimeType?: string;
	/** Display name for the attachment card (filename, or "粘贴图片.png"). */
	name?: string;
	/** Decoded byte size, for the card's size hint. */
	size?: number;
}

export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
export interface NativeMcpServerStatus { name: string; state: string; toolCount: number; detail: string; }
export interface NativeMcpTool { name: string; exposure: string; description: string; readOnly?: boolean; destructive?: boolean; }
export interface NativeCodemodeSettings { version: string; path: string; mode: "on" | "only"; inlineBudget: number; effectiveMode: "on" | "only"; effectiveInlineBudget: number; }
export interface NativeMcpConfigState { path: string; paths?: { global: string; project: string }; scope: "global" | "project"; version: string; document: Record<string, unknown>; trusted: boolean; inheritedAutoEnableCodemode?: boolean; }

export type ClientMessage =
	| TreeRequest
	| { type: "native_mcp_request"; requestId: string; cwd: string; scope: "global" | "project"; action: "get" | "save" | "trust" | "command" | "radius" | "codemode" | "log"; codemode?: { mode: "on" | "only"; inlineBudget: number }; version?: string; document?: Record<string, unknown>; command?: "status" | "login" | "logout" | "reconnect"; name?: string }
	| { type: "node_request"; requestId: string; action: string; nodeId?: string; terminalId?: string; conversationId?: string; payload?: Record<string, unknown> }
	| { type: "hello"; clientId: string; protocolVersion?: number }
	/** Re-request the slash-command catalog (also pushed on attach / cwd change). */
	| { type: "get_commands" }
	| {
			type: "prompt";
			requestId?: string;
			text: string;
			/**
			 * While the agent is streaming: queue this prompt and deliver it after
			 * the WHOLE run finishes (followUp) instead of steering (injecting it
			 * right after the current turn settles, skipping remaining tool calls).
			 * The 补充 (supplement) button sends queue=true; plain Enter keeps the
			 * steer semantic.
			 */
			queue?: boolean;
			attachments?: PromptAttachment[];
	  }
	// -- terminal ------------------------------------------------------------
	| {
			type: "terminal_create";
			terminalId: string;
			cwd: string;
			cols: number;
			rows: number;
			/** Optional because old UI clients target the active conversation. */
			conversationId?: string;
	  }
	| { type: "terminal_input"; terminalId: string; data: string; conversationId?: string }
	| { type: "terminal_resize"; terminalId: string; cols: number; rows: number; conversationId?: string }
	| { type: "terminal_kill"; terminalId: string; conversationId?: string }
	// Runs a command in a new shell; if the terminal already exists it is
	// RESTARTED in place (current process killed, fresh shell runs it again).
	| {
			type: "run_command";
			terminalId: string;
			command: CommandDef;
			cols: number;
			rows: number;
			conversationId?: string;
	  }
	// Re-discover extensions/skills/prompt templates from disk after an
	// external change (e.g. `pi remove npm:<pkg>` finished in the terminal).
	// Streaming-safe: deferred to agent_end while a run is in flight.
	| { type: "extensions_reload" }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "list_commands" }
	| { type: "save_commands"; commands: CommandDef[] }
	| { type: "abort" }
	| { type: "retry_silent_prompt"; conversationId: string; text: string }
		// -- background tasks (AI-started servers) ------------------------------
	/** Kill ONE background server the agent started (by listening port). */
	| { type: "kill_background_server"; port?: number; taskId?: string }
	/** Kill EVERY background server the agent started (frees all ports). */
	| { type: "kill_background_servers" }
	/** Re-push the current background-server list (the server also refreshes it
	 *  on its own and prunes entries whose process exited). */
	| { type: "list_bg_servers" }

	/** Global-search recursive filename match across the active workspace.
	 *  Server-side bounded walk; reqId echoes back in search_files_result. */
	| { type: "search_files"; reqId: number; query: string }
	// -- source-control panel (read-only git queries, server-side execFile) --
	/** SCM refresh payload: status + branches + numstat (history loads
	 *  lazily via scm_history so big repos don't pay for it every refresh). */
	| { type: "scm_status"; reqId: number }
	/** Lightweight footer query: no worktree status/diff scan. */
	| { type: "get_git_branch" }
	/** Commit graph for the history tab (lazy-loaded). */
	| { type: "scm_history"; reqId: number }
	/** Staged + worktree diffs, or bounded content for an untracked file. */
	| { type: "scm_filediff"; reqId: number; path: string }
	/** Full patch of one commit. */
	| { type: "scm_commit"; reqId: number; hash: string }
	| { type: "new_chat" }
	/** Re-ask on an in-file branch by default; newSession overrides the saved UI preference. */
	| {
			type: "edit_message";
			conversationId?: string;
			entryId?: string;
			newSession?: boolean;
			messageId: string;
			text: string;
			/**
			 * Attachments to send along with the re-asked question. The editor
			 * pre-fills it with the original message's attachments (images →
			 * imageData, uploaded files → uploadPath, workspace paths →
			 * path+mode; fork drops the persisted attachment asides — they live
			 * on the old branch, past the fork point) and accepts newly
			 * pasted/dropped images and files.
			 */
			attachments?: PromptAttachment[];
	  }
	| { type: "cycle_model" }
	| { type: "cycle_thinking" }
	| { type: "get_state" }
	| { type: "list_sessions" }
	| { type: "switch_session"; path: string }
	| { type: "switch_conversation"; id: string }
	| { type: "list_projects" }
	| { type: "list_files"; path?: string }
	/** Confirm conversation file candidates against the current workspace. */
	| { type: "check_conversation_files"; cwd: string; reqId: number; paths: string[] }
	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	| { type: "read_file"; path: string; requestId?: string; cwd?: string }
	/** Save text edited in the file preview panel. */
	| { type: "write_file"; path: string; text: string; requestId?: string; cwd?: string; expectedVersion?: string; force?: boolean }
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	| { type: "set_thinking"; level: string }
	| { type: "set_cwd"; path: string; requestId?: string; source?: "ui" }
	| { type: "complete_path"; path: string }
	| { type: "cancel_recovery"; conversationId: string; operationId: string }
	| { type: "set_run_settings"; conversationId: string; autoCompaction?: boolean; autoRetry?: boolean }
	| { type: "dialog_response"; conversationId: string; id: string; value: string | boolean | null }
	// -- self-update ----------------------------------------------------------
	/** Check the npm registry for a newer pi-web-ui version. */
	| { type: "check_update" }
	| { type: "check_component_updates"; requestId: string }
	| { type: "update_component"; requestId: string; id: string }
	// -- pi agent setup ------------------------------------------------------
	/** Auto-install the pi agent (mkdir config dir + npm i -g the CLI). */
	| { type: "install_pi_agent" }
	/** Persist an api-key credential for a provider (auth.json) and apply it now. */
	| { type: "logout_provider"; provider: string }
	| { type: "login_provider"; provider: string }
	| { type: "cancel_provider_login"; requestId: string }
	| { type: "provider_auth_response"; requestId: string; promptId: string; value: string }
	| { type: "set_provider_api_key"; provider: string; apiKey: string }
	/** Clear a built-in provider's stored key (auth.json entry + runtime
	 *  override) so it returns to the unconfigured state. Only meaningful for
	 *  keys whose auth status reports source "stored". */
	| { type: "clear_provider_api_key"; provider: string }
	// -- custom model config (agentDir/models.json) ---------------------------
	| { type: "list_models_config" }
	/** Upsert one provider (api/baseUrl/apiKey + its models) into models.json. */
	| { type: "save_model_config"; providerId: string; config: UiProviderConfig }
	/** Remove a provider from models.json. */
	| { type: "delete_model_config"; providerId: string }
	/** List pi's built-in providers with their auth status (key-only config). */
	| { type: "list_providers" }
	/** Probe a custom provider's OpenAI-compatible /models endpoint and return
	 *  the advertised model ids. Runs SERVER-side (the baseUrl is often a
	 *  LAN/loopback host the browser can't reach cross-origin). reqId is echoed
	 *  back in fetch_models_result so the UI can match concurrent requests. */
	| {
			type: "fetch_models";
			reqId: number;
			baseUrl: string;
			apiKey?: string;
			authHeader?: boolean;
			/** api type: openai-completions / openai-responses / anthropic-messages / google-generative-ai. */
			api?: string;
	  }
	/** Re-probe a SAVED provider's /models endpoint and merge the result into
	 *  its models.json entry. Credentials stay server-side (the browser never
	 *  sees apiKey/headers); reqId is echoed in refresh_provider_result. */
	| { type: "refresh_provider_models"; providerId: string; reqId: number }
	/** Copy a BUILT-IN provider (baseUrl + current model catalog) into an
	 *  editable custom-provider draft — the point is running a second API key
	 *  alongside the built-in one without overwriting it. Nothing is saved
	 *  until save_model_config; the draft comes back in clone_provider_result
	 *  with a fresh provider id and an EMPTY apiKey for the user to fill. */
	| { type: "clone_provider"; provider: string; reqId: number }
	// -- display preferences and native resource views ------------
	/** Request the current settings state (also pushed automatically on attach). */
	| { type: "get_settings" }
	/** Apply a partial settings update: main-session prompt/toggles or isolated
	 *  reviewer prompt/skill toggles. Each change is persisted per client; main
	 *  session changes reload the runtime, while review changes affect the next review. */
	| {
			type: "set_settings";
			editResendNewSession?: boolean;

			/** Installed UI plugins hidden in the settings panel (UI-only toggle,
			 *  never triggers a runtime reload). */
			disabledPlugins?: string[];

			/** 思考文本是否换行（默认开）。纯 UI 偏好，不需要 reload runtime。 */
			thinkingWrap?: boolean;
			/** 工具调用是否默认展开（默认开）。纯 UI 偏好，不需要 reload runtime。 */
			toolsWrap?: boolean;

	  }
	// -- plugins (<dataDir>/plugins) -----------------------------------------
	/** App-level message from a plugin's client bundle to its server side.
	 *  Routed by pluginId; unknown/failed plugins are silently ignored. */
	| { type: "plugin_message"; pluginId: string; payload: unknown }
	/** Re-scan the plugin directory: deactivate removed entries, activate new
	 *  ones, bump the epoch and re-push the catalog. Same spirit as
	 *  extensions_reload but for pi-web-ui's own UI plugins. */
	| { type: "plugins_reload" }

	/** Save a UI plugin's declarative settings (manifest "settings" schema).
	 *  The host validates against the schema, persists to storage.json and
	 *  notifies the plugin (host.onSettingsChanged). */
	| { type: "plugin_settings"; pluginId: string; values: Record<string, unknown> }
	/** Replace the current settings with the named preset and apply it. */

	/** Remove the named preset. */

	/** Drop one workspace from this client's recent-project list (UI state
	 *  only — nothing on disk is touched). */
	| { type: "remove_project"; path: string }
	/** Permanently delete a persisted session transcript file (history list). */
	| { type: "delete_session"; path: string }
	/** Set a persisted session's display name (history list ✎). Stored as a
	 *  `session_info` entry inside the transcript; an empty name clears it and
	 *  the list falls back to the first user message. */
	| { type: "rename_session"; path: string; name: string }
	/** List the SUBDIRECTORIES of `path` for the workspace picker. Distinct
	 *  from `list_files`, which is deliberately confined to the current
	 *  workspace — picking a *new* workspace has to look outside it. Omit
	 *  `path` to start at the user's home directory. */
	| { type: "browse_dirs"; path?: string };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface SessionSummary {
	branchPoints?: number;
	parentSessionPath?: string;
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: number;
	/** When the session was created (ms epoch) — drives the fixed list order,
	 *  newest first; the position never changes afterwards. */
	created: number;
	/** Where the session lives: this UI's per-client dir, or the pi CLI/TUI dir. */
	source?: "web" | "tui";
}

/**
 * A workspace directory this client has opened before (persisted per client in
 * <dataDir>/client-state.json, merged with cwds found in the session store).
 */
export interface ProjectSummary {
	/** Absolute path of the workspace directory. */
	path: string;
	/** When the project first entered the list (ms epoch) — drives the fixed
	 *  order, newest first; the position never changes afterwards. */
	firstAdded: number;
	/** Last time this workspace was used (ms epoch) — informational only. */
	lastUsed: number;
	/** Most recently modified conversation in this project, when available. */
	lastConversationAt?: number;
	/** Number of persisted conversations in this workspace. */
	conversationCount?: number;
}

/** One directory listing for the workspace picker (see `browse_dirs`).
 *  Names only, directories only — never file contents. */
export type DirBrowse = {
	/** Absolute path that was listed. */
	path: string;
	/** Absolute parent path, or null at the filesystem root. */
	parent: string | null;
	/** Subdirectory names (not full paths), sorted. */
	dirs: string[];
	/** Listing hit the entry cap and was cut short. */
	truncated: boolean;
	/** Windows only: available drive roots ("C:\\", "D:\\", …).
	 *
	 *  Windows has no single filesystem root — walking up from C:\Users\me
	 *  stops dead at C:\, and D:\ is not reachable from it at all (POSIX
	 *  always bottoms out at "/", which contains everything). Without this
	 *  the picker can never leave the boot drive. Absent on POSIX. */
	drives?: string[];
};

/** A background server the agent left running (listening-port diff around a
 *  bash tool run). Keyed by port. Managed from the 后台任务 panel: each entry
 *  can be stopped individually or all at once, and the list persists even
 *  after the conversation that started them ends. */
export interface BgServer {
	/** Port the server listens on (the stable key for agent-started servers).
	 *  Plugin-registered tasks have no port — they carry taskId/plugin instead. */
	port?: number;
	/** Process id of the listening process (agent-started servers). */
	pid?: number;
	/** Plugin task id (host.registerBackgroundTask) — present for plugin tasks. */
	taskId?: string;
	/** Plugin id that registered this task (kill routing). */
	plugin?: string;
	/** When the server/task was first detected or registered (ms epoch). */
	since: number;
	/** Best-effort process name (tasklist / ps), undefined when unknown. */
	name?: string;
	/** Best-effort full command line (PowerShell CIM / ps -o command=) so the
	 *  panel can show WHAT is actually running, undefined when unknown. */
	command?: string;
	/** 插件任务的活动状态文案（如轮询间隔、连接数），可经 update 刷新。 */
	status?: string;
}

/** One filename match from the global-search recursive workspace walk. */
export interface FileSearchResult {
	/** Workspace-relative path ("/"-separated). */
	path: string;
	name: string;
	type: "file" | "dir";
}
/** Read-only SQLite HTTP preview; shared by server and sidebar. */
export interface SqliteCell {
	kind: "null" | "blob" | "number" | "text";
	value: string;
	truncated?: boolean;
}
export interface SqlitePreviewData {
	queryError?: string;
	tables: { name: string; type: "table" | "view" }[];
	tablesTruncated: boolean;
	table: string | null;
	schema: string;
	columns: { name: string; type: string; primaryKey: number }[];
	columnsTruncated: boolean;
	rows: SqliteCell[][];
	offset: number;
	pageSize: number;
	hasMore: boolean;
}
export interface SqlitePreviewResponse {
	requestId: string;
	cwd: string;
	path: string;
	data?: SqlitePreviewData;
	error?: string;
}

export interface FileEntry {
	name: string;
	/** Path relative to the workspace root ('' for the root itself). */
	path: string;
	type: "file" | "dir";
	/**
	 * Preview category (files only; undefined for dirs). Unknown files are
	 * sniffed on read; SQLite files use the read-only database viewer.
	 */
	kind?: "image" | "video" | "text" | "sqlite" | "none";
}

// -- source-control panel (wire shapes shared by scm_data) -------------------

export interface ScmFileEntry {
	/** Repo-relative path. */
	path: string;
	/** porcelain index (staged) status letter. */
	x: string;
	/** porcelain worktree status letter. */
	y: string;
}

export interface ScmBranchEntry {
	name: string;
	current: boolean;
	/** Remote name for remote-tracking refs ("origin/main" → "origin"). */
	remote?: string | boolean;
}

export interface ScmCommitEntry {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	subject: string;
	decorations: string;
	/** The graph prefix emitted by `git log --graph` (for example `| * `). */
	graph: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	/** Whether the model accepts image input (SDK `input` includes "image"). */
	vision: boolean;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Custom model configuration (agentDir/models.json) — browser-editable shape
// ---------------------------------------------------------------------------

/** One model definition inside a custom provider. */
export interface UiModelConfigEntry {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
}

/** A custom provider block in models.json (providers.<id>). */
export interface UiProviderConfig {
	/** Typed image/classifier entries are retained server-side by the chat editor. */
	nonChatModelCount?: number;
	providerId: string;
	name?: string;
	/** api type: openai-completions / openai-responses / anthropic-messages / google-generative-ai. */
	api?: string;
	baseUrl?: string;
	apiKey?: string;
	authHeader?: boolean;
	/** headers are NOT returned to the browser — they can contain Authorization
	 *  / API-key values; saveModelConfig preserves them server-side. */
	models: UiModelConfigEntry[];
}

// ---------------------------------------------------------------------------
// Plugins (optional UI components dropped into <dataDir>/plugins/<id>/)
// ---------------------------------------------------------------------------

/** One installed pi-web-ui plugin (see server/plugins.ts). A plugin is a
 *  directory under <dataDir>/plugins/<id>/ with a manifest.json and optional
 *  server entry (index.mjs) + client view bundle (client/entry.mjs). Not
 *  bundled with the app — users install by dropping the directory in and
 *  restarting (or reconnecting: the list is re-scanned on every attach). */

/** 一个声明式设置字段（manifest "settings" 数组里的元素）。 */
export interface UiPluginSettingField {
	/** 字段 key（storage.json settings 对象里的键；同一插件内唯一）。 */
	key: string;
	/** 控件类型：文本 / 密码 / 数字 / 开关 / 下拉。 */
	type: "text" | "password" | "number" | "boolean" | "select";
	/** 表单里的显示名。 */
	label: string;
	/** 未保存过时的默认值。 */
	default?: string | number | boolean;
	/** number 用：范围。 */
	min?: number;
	max?: number;
	/** select 用：候选值。 */
	options?: string[];
	/** 帮助文案（悬浮提示/小字）。 */
	hint?: string;
}

export interface UiPluginInfo {
	/** Directory name; must match ^[A-Za-z0-9_-]+$ (path-safety). */
	id: string;
	/** Display label from manifest.json (shown as the view tab). */
	name: string;
	version?: string;
	description?: string;
	/** A client/entry.mjs exists → the frontend should load its view bundle. */
	hasClient: boolean;
	/** Optional emoji/single-char icon from manifest.json — shown instead of
	 *  the generic puzzle glyph on the view tab. */
	icon?: string;
	/** The plugin failed to activate (bad entry / thrown error) — UI shows it
	 *  greyed out instead of a dead tab. */
	error?: string;
	/** Declared capabilities from manifest.json (e.g. "fs", "net", "tools") —
	 *  informational for now: surfaced in the settings panel so users can see
	 *  what a plugin claims to touch before trusting it. */
	permissions?: string[];
	/** Declarative settings schema from manifest.json "settings" — rendered as a
	 *  form in the main ⚙ panel (type/label/default/min/max/options). */
	settingsSchema?: UiPluginSettingField[];
	/** Current stored values (storage.json "settings" key, defaults applied). */
	settingsValues?: Record<string, unknown>;
	/** Install source recorded by `pi-web-ui install` (<dir>/.pi-source.json):
	 *  the original spec the user typed (owner/repo, URL or local path). The
	 *  settings panel offers an Update button only when this exists. */
	source?: string;
}

/** One of pi's built-in providers, with whether auth is configured. */
export interface ProviderAuthState {
	requestId: string;
	provider: string;
	phase: "pending" | "success" | "cancelled" | "error";
	url?: string;
	code?: string;
	message?: string;
	prompt?: { id: string; kind: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string }[] };
}

export interface ProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	oauth?: boolean;
	/** Where auth came from: stored / runtime / environment / models_json_key … */
	source?: string;
}
/** One RUNNING conversation of the current project (each runs its own session
 *  in parallel). The list is per project and only contains conversations that
 *  were displaced to the background while still streaming; background-finish
 *  keeps them listed, opening-and-leaving-without-continuing removes them. */
export interface ConversationSummary {
	branchPoints?: number;
	parentSessionPath?: string;
	id: string;
	createdAt?: number;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	cwd: string;
	messageCount: number;
	isStreaming: boolean;
	/** Absolute path of this conversation's transcript, when it has one.
	 *
	 *  The join key between this list and the persisted-session list: the two
	 *  are keyed differently (runtime id vs. file path), so without it the UI
	 *  cannot tell that a running conversation and a history entry are the
	 *  same conversation — and `list_sessions` does not filter open ones out,
	 *  so it lists both. Absent for a conversation with no session file yet. */
	sessionFile?: string;
}

// ---------------------------------------------------------------------------
// Settings (system prompt / skills / extensions / presets)
// ---------------------------------------------------------------------------

/** One loaded skill, with whether it is currently enabled. Disabled skills are
 *  excluded from the system prompt and from the /skill: command catalog. */
/** Native discovery and versioned skill filters for the settings page. */
export interface NativeSkillsState {
	version: string;
	paths: string[];
	skills: (UiSkillInfo & { id: string; path: string; source: "user" | "project" | "temporary" | "package"; scope: "user" | "project" | "temporary"; canToggle: boolean; promptVisible: boolean })[];
}

export interface UiSkillInfo {
	name: string;
	description: string;
	enabled: boolean;
}

/** One loaded extension, with whether it is currently enabled. Disabled
 *  extensions are unloaded from the runtime (tools/commands disappear). */
export interface ComponentUpdate {
	id: string;
	name: string;
	current: string | null;
	latest: string | null;
	kind: "bundled" | "npm" | "git" | "local";
	scope?: "user" | "project";
	status: "available" | "current" | "pinned" | "manual" | "unknown" | "error";
	canUpdate: boolean;
	error?: string;
}

export interface UiExtensionInfo {
	/** Stable identity for the toggle: the npm spec for packages, the resolved
	 *  entry path otherwise. */
	id: string;
	/** Human-readable package, directory or standalone extension name. */
	name: string;
	/** Bundled functionality, labeled by the browser in the active language. */

	/** Resolved entry path. */
	path: string;
	enabled: boolean;
}

/** A named combination of prompt mode/text + disabled skills/extensions that
 *  the user can re-apply in one click. Persisted per client. */

/** One vision-capable model the vision bridge can use (picker option). */

/** Full settings state pushed to the browser (settings_state). */
export interface UiSettingsState {
	editResendNewSession?: boolean;
	thinkingWrap: boolean;
	toolsWrap: boolean;
	disabledPlugins: string[];
	effectiveSystemPrompt: string;
	skills: UiSkillInfo[];
	extensions: UiExtensionInfo[];
}
export type ServerMessage =
	| TreeResponse
	| { type: "native_mcp_result"; requestId: string; cwd: string; state?: NativeMcpConfigState; error?: string; pending?: boolean; tools?: string[]; toolInfo?: NativeMcpTool[]; servers?: NativeMcpServerStatus[]; statusText?: string; codemode?: NativeCodemodeSettings; log?: string }
	| { type: "node_event"; requestId?: string; event: string; nodeId?: string; terminalId?: string; conversationId?: string; data?: Record<string, unknown>; error?: string }
	| {
			type: "ready";
			clientId: string;
			/** Running pi-web-ui package version, independent of the pi SDK version. */
			serverVersion: string;
			/** Wire-protocol version (server/protocol-version.ts). The client
			 *  compares it against its own copy — a mismatch means the page was
			 *  loaded before an app update and must be refreshed. */
			protocolVersion?: number;
	  }
	| { type: "snapshot"; state: UiState }
	| { type: "agent_silence"; conversationId: string; phase: "silent" | "active"; since: number; activity: "model" | "tool" }
	| {
			/** Incremental snapshot: everything EXCEPT `messages` travels in
			 *  `state`, and only messages appended since baseRev ride in
			 *  `appended`. Persisted messages are content-immutable with stable
			 *  ids, so any mid-array change/truncation (switch session, fork,
			 *  compaction) makes the server fall back to a full snapshot instead.
			 *
			 *  Droppable under backpressure exactly like `snapshot`: a dropped
			 *  delta breaks the client's rev chain, and the next surviving full
			 *  snapshot (or the client's get_state after detecting the gap)
			 *  reconciles — memory stays bounded, correctness self-heals. */
			type: "snapshot_delta";
			conversationId: string;
			rev: number;
			baseRev: number;
			appended: UiMessage[];
			state: Omit<UiState, "messages" | "rev"> & { rev: number };
	  }
	| {
			// Per-project running-conversation list (see ConversationSummary):
			// only conversations of the CURRENT cwd that are listed. activeId is
			// the active conversation even when it isn't listed (fresh chat).
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
	  }
	| {
			type: "tool_delta";
			codemode?: UiCodemodeDetails;
			parentToolCallId?: string;
			conversationId: string;
			/** Per-conversation monotonic sequence, shared with message_delta —
			 *  a gap tells the client to resync via get_state. */
			seq: number;
			toolCallId: string;
			toolName: string;
			delta: string;
			/** SDK partial results replace output; user_bash chunks append. */
			replace?: boolean;
	  }
	/** Live assistant-message increment (thinking/text deltas + usage) that
	 *  deliberately BYPASSES the snapshot channel: send() drops snapshots under
	 *  backpressure, but this message is small and must always get through, so
	 *  big sessions keep rendering live even when full snapshots are dropped.
	 *  seq is per-conversation monotonic — a gap tells the client to resync via
	 *  get_state. The next snapshot remains authoritative and reconciles any
	 *  drift (deltas only patch streamingMessage + stats.tokens). */
	| {
			type: "message_delta";
			conversationId: string;
			seq: number;
			messageId: string;
			usage: { input: number; output: number; total: number } | null;
			assistantMessageEvent: { type: string; contentIndex?: number; delta?: string };
	  }
	/** A tool FINISHED executing (SDK tool_execution_end). Unlike toolResult
	 *  snapshot messages, this arrives the moment the command exits — before
	 *  the model's next response starts — so the UI can show "done, waiting
	 *  for the model" instead of an indefinite "running". */
	| {
			type: "tool_status";
			conversationId?: string;
			/** Nested calls also send a start status before their eventual end. */
			running?: boolean;
			argumentsText?: string;
			parentToolCallId?: string;
			toolCallId: string;
			toolName: string;
			isError: boolean;
			/** Exit code when the tool result carries one (bash returns it in details). */
			exitCode?: number;
			/** tool_execution_start → tool_execution_end, in ms. */
			durationMs?: number;
	  }
	// -- terminal ------------------------------------------------------------
	| { type: "terminal_output"; conversationId?: string; terminalId: string; data: string }
	| { type: "terminal_exit"; conversationId?: string; terminalId: string; exitCode: number | null }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "commands"; cwd: string; commands: CommandDef[]; path: string }
	/** The slash-command catalog for the chat input (builtin + extension +
	 *  prompt template + skill commands). Pushed on attach, on project switch
	 *  and on request (get_commands). */
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "reload_status"; conversationId: string; requestId: string; phase: "running" | "done"; timestamp: number; durationMs?: number; extensions?: number; skills?: number; prompts?: number; resources?: { extensions: string[]; skills: string[]; prompts: string[] }; errors?: { path: string; message: string }[] }
	| { type: "notice"; conversationId?: string; level: "info" | "warning" | "error"; text: string }
	/** The watched git dir changed outside the panel (terminal commit,
	 *  CLI, IDE) — the client should re-run its scm_status query. */
	| { type: "scm_changed" }
	/** Sent every ~10s so clients can detect half-open connections. */
	| { type: "heartbeat" }
	| { type: "cwd_result"; requestId: string; cwd: string; ok: boolean; error?: string; timing?: { startedAt: number; preparedAt: number; snapshotAt: number } }
	| { type: "sessions"; cwd: string; sessions: SessionSummary[] }
	/** Filename matches for the global search panel (reqId echo). Always sent
	 *  in reply to a search_files request — ok:false means the walk failed. */
	| {
			type: "search_files_result";
			cwd: string;
			reqId: number;
			ok: boolean;
			results: FileSearchResult[];
			/** Walk stopped early (result/time/entry budget hit). */
			truncated?: boolean;
	  }
	| { type: "projects"; projects: ProjectSummary[] }
	| { type: "conversation_files_checked"; cwd: string; reqId: number; paths: string[] }
	| { type: "git_branch"; cwd: string; branch: string | null; detached: boolean; notRepo?: boolean }
	/** Directory listing for the workspace picker (see `browse_dirs`). */
	| ({ type: "dir_browse" } & DirBrowse)
	| {
			type: "files";
			cwd: string;
			path: string;
			parent: string | null;
			entries: FileEntry[];
			/**
			 * The directory had more entries than the platform cap (win32: 2000,
			 * posix: 500) — the list was cut short. UI shows a hint when true.
			 */
			truncated: boolean;
	  }
	/** Content of a workspace file for the preview panel. */
	/** The server fs.watches the currently-listed directory and pushes this on
	 *  any file change so the client can refresh the listing instantly
	 *  (path = the listed directory; unknown/unsupported fs falls back to the
	 *  10s polling). */
	| { type: "file_changed"; path: string }
	| { type: "prompt_result"; requestId: string; ok: boolean }
	| { type: "file_result"; operation: "read" | "write"; requestId?: string; cwd: string; path: string; ok: boolean; version?: string; error?: string; conflict?: boolean }
	| {
			type: "file_content";
			requestId?: string;
			version?: string;
			cwd: string;
			path: string;
			name: string;
			/**
			 * Preview category: media kinds render via the /api/file HTTP
			 * endpoint (text stays empty); "none" means not previewable.
			 */
			kind: "image" | "video" | "text" | "sqlite" | "none";
			text: string;
			truncated: boolean;
			binary: boolean;
			/** Total line count of the *read* portion (equal to lines in text). */
			lines: number;
			/** Total file size in bytes. */
			size: number;
	  }
	| { type: "models"; models: ModelInfo[] }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "provider_auth"; state: ProviderAuthState }
	| { type: "providers_status"; providers: ProviderStatus[] }
	/** Result of a fetch_models probe: ok + the advertised models (id plus
	 *  whatever metadata the endpoint provided — contextWindow / vision input /
	 *  reasoning / name / maxTokens — same shape as models.json rows), or an
	 *  error string. */
	| {
			type: "fetch_models_result";
			reqId: number;
			ok: boolean;
			models?: UiModelConfigEntry[];
			error?: string;
	  }
	/** Result of refresh_provider_models: merged into the saved entry; added =
	 *  newly-discovered model ids, total = models now in the saved config. */
	| {
			type: "refresh_provider_result";
			reqId: number;
			ok: boolean;
			added?: number;
			total?: number;
			error?: string;
	  }
	/** Result of clone_provider: a ready-to-edit custom-provider draft
	 *  (baseUrl + model catalog copied from the built-in provider; apiKey
	 *  intentionally empty). Not persisted until save_model_config. */
	| {
			type: "clone_provider_result";
			reqId: number;
			ok: boolean;
			config?: UiProviderConfig;
			error?: string;
	  }
	/** Result of an install_pi_agent run (npm i -g finished or failed). */
	| { type: "install_result"; ok: boolean; detail: string }
	// -- source-control panel results (see scm_status / scm_filediff / scm_commit) --
	| {
			type: "scm_data";
			cwd: string;
			reqId: number;
			kind: "status" | "history" | "filediff" | "commit";
			ok: boolean;
			error?: string;
			/** status payload — fields optional so one wire type carries every
			 *  kind; the client reads the ones matching `kind`. */
			notRepo?: boolean;
			branch?: string;
			detached?: boolean;
			upstream?: string | null;
			ahead?: number;
			behind?: number;
			upstreamGone?: boolean;
			files?: ScmFileEntry[];
			branches?: ScmBranchEntry[];
			stats?: Record<string, [number, number]>;
			history?: ScmCommitEntry[];
			/** filediff payload */
			stagedText?: string;
			worktreeText?: string;
			untracked?: boolean;
			untrackedText?: string;
			untrackedKind?: "text" | "binary" | "directory";
			untrackedTruncated?: boolean;
			/** commit payload */
			text?: string;
  }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| { type: "widgets"; conversationId: string; widgets: { key: string; lines: string[] }[] }
	| { type: "statuses"; conversationId: string; statuses: { key: string; text: string | undefined }[] }
	| {
			type: "dialog";
			conversationId: string;
			source: string;
			id: string;
			kind: "select" | "confirm" | "input" | "editor";
			title: string;
			args: unknown[];
	  }
	/** The server resolved (or abandoned) a dialog — the client must close it. */
	| { type: "extension_ui_reset"; conversationId: string }
	| { type: "extension_editor"; conversationId: string; id: string; text: string }
	| { type: "extension_title"; conversationId: string; title: string }
	| { type: "dialog_closed"; conversationId: string; id: string }
	// -- self-update ----------------------------------------------------------
	/** Result of a check_update run (current/latest from the npm registry). */
	| {
			type: "update_status";
			/** Version of the RUNNING process (from its own package.json). */
			current: string;
			latest: string | null;
			/** Publish timestamp (ISO) of the latest version — lets the UI hint
			 * when it was just published and registry caches may lag. */
			latestPublishedAt: string | null;
			upToDate: boolean;
			error?: string;
	  }
	// -- goal / review -------------------------------------------------------
	/** Goal status pushed whenever it changes (set / review start-end / verdict).
	 *  Review result CARDS are inserted into the main conversation flow as real
	 *  custom messages (rendered like an attachment card), so they persist across
	 *  snapshots/reconnects — this only drives the goal bar status. */

	/** Current settings state (system prompt mode/text, enabled skills &
	 *  extensions, saved presets). Pushed on attach and after every settings
	 *  change. */
	| { type: "settings_state"; settings: UiSettingsState }
	| { type: "component_updates"; requestId: string; cwd: string; phase: "checking" | "ready" | "updating" | "updated" | "error"; items: ComponentUpdate[]; restartRequired?: boolean; error?: string }
	// -- plugins (<dataDir>/plugins) -----------------------------------------
	/** Installed-plugin catalog. Pushed on attach (the dir is re-scanned each
	 *  time so freshly dropped plugins appear without a server restart) and
	 *  after every plugins_reload. `epoch` increments on every server-side
	 *  reload; the frontend uses it as an import-cache buster so changed
	 *  bundles are actually re-fetched. */
	| { type: "plugins"; plugins: UiPluginInfo[]; epoch: number }
	/** App-level message from a plugin's server side to its client bundles.
	 *  Broadcast to every connected socket (plugins have no per-client state
	 *  in v1); the frontend fans it out to the matching loaded view. */
	| { type: "plugin_data"; pluginId: string; payload: unknown }
	// -- background tasks ---------------------------------------------------
	/** The background-server list (servers the agent left running, detected via
	 *  listening-port diffs around bash tool runs). Per CLIENT, not per
	 *  conversation — the list survives conversation switches/ends and only
	 *  empties when the tasks are stopped (individually or all at once) or the
	 *  process exits on its own. Pushed on change, on attach and on request. */
	| { type: "bg_servers"; servers: BgServer[] }

/** Node workbench profiles contain metadata only; credentials never enter state snapshots. */
export type NodePolicy = "readonly" | "confirm" | "auto" | "off";
export interface NodeProfile {
	id: string; name: string; group: string; host: string; port: number; username: string;
	auth: "password" | "key" | "agent"; keyPath?: string; localKeyPath?: string; localAuth?: "password" | "key" | "agent"; defaultDir: string; fingerprint?: string;
	hasSecret?: boolean; sourceId?: string; sourceKey?: string; sourceMissing?: boolean;
	unsupported?: string[]; policy?: NodePolicy; lastConnected?: number;
}
export interface NodeSource {
	id: string; kind: "xshell" | "ssh"; path: string; enabled: boolean;
	lastSync?: number; error?: string; count: number; groups: number; changes?: string[];
}

/** Wiki HTTP API. Workspace and request identity are checked at the boundary. */
export interface WikiConversationResult { conversationId: string }
export interface WikiEntry {
	path: string;
	name: string;
	kind: "directory" | "document" | "code" | "pdf" | "image" | "other";
	size: number;
	modified: number;
	tags: string[];
	title?: string;
	symlink?: boolean;
}
export interface WikiLink { path: string; snippet: string; line: number }
/** Responses for document-content and write; references load independently. */
export interface WikiDocumentContent {
	entry: WikiEntry;
	text?: string;
	version: string;
	editable: boolean;
}
export interface WikiDocumentReferences { backlinks: WikiLink[] }
export interface WikiDocument extends WikiDocumentContent, WikiDocumentReferences {}
export interface WikiSearchResult extends WikiLink { kind: WikiEntry["kind"]; page?: number }
export interface WikiChange {
	path: string;
	before: string | null;
	after: string | null;
	binary: boolean;
	undone: boolean;
	additions: number;
	deletions: number;
	truncated?: boolean;
}
export interface WikiApiError { error: string; code?: "version_conflict"; }
export interface WikiRevision {
	/** Attribution is absent on legacy records; never attach those to a new chat. */
	conversationId?: string;
	requestId?: string;
	assistantTimestamp?: number;
	id: string;
	at: number;
	author: "pi" | "user";
	title: string;
	changes: WikiChange[];
	skipped: string[];
}
export interface WikiIndexIssue {
	path: string;
	size?: number;
	reason: "file-size" | "byte-budget" | "entry-limit" | "depth-limit" | "unreadable";
	/** A whole directory has not been scanned; its descendants are not counted. */
	subtree?: boolean;
}
export interface WikiIndexStatus {
	indexed: number;
	total: number;
	/** Scanning stopped before all files could be counted. Display the total as a lower bound. */
	totalIsLowerBound: boolean;
	issues: WikiIndexIssue[];
}
export interface WikiState {
	entries: WikiEntry[];
	index?: WikiIndexStatus;
	tags: { name: string; count: number }[];
	revisions: WikiRevision[];
	running: boolean;
	limited: boolean;
}
export interface WikiDirectory {
	path: string;
	entries: WikiEntry[];
	nextOffset?: number;
}

// Extensions HTTP API: native Pi package management, separate from agent messages.
export type ExtensionScope = "user" | "project";
export interface ExtensionPackage {
	id: string; source: string; name: string; scope: ExtensionScope; kind: "npm" | "git" | "local" | "file";
	path?: string; version?: string; description?: string; enabled: boolean; pinned: boolean; trusted: boolean;
	resources: Record<"extensions" | "skills" | "prompts" | "themes", string[]>;
	latest?: string; update?: boolean; checkError?: string; protected?: boolean;
}
export interface ExtensionsState { packages: ExtensionPackage[]; version: string; trusted: boolean; checkedAt?: number; autoCheck?: boolean; }
export interface ExtensionCatalogItem { name: string; description: string; descriptionZh?: string; version?: string; author?: string; downloads?: number; date?: number; types: string[]; image?: string; url: string; repository?: string; }
export interface ExtensionCatalog { items: ExtensionCatalogItem[]; page: number; pages: number; total?: number; }
export interface ExtensionPackageDetails { source: string; name: string; version?: string; description?: string; author?: string; repository?: string; license?: string; resources: Record<string, string[]>; canPin: boolean; }
export interface ExtensionPreview extends ExtensionPackageDetails { ticket: string; }
export interface ExtensionOperation { action: "install" | "remove" | "toggle" | "update" | "update-all" | "unpin" | "move"; id?: string; scope?: ExtensionScope; enabled?: boolean; ticket?: string; pin?: boolean; }
export interface ExtensionJob { id: string; phase: "running" | "done" | "error"; log: string; error?: string; }

// Native system prompt inspection/file editing HTTP API.
export interface PromptSectionView { name: string; text: string; }
export interface PromptRuleView { text: string; kind: "builtin" | "tool" | "extension" | "unknown"; name?: string; path?: string; }
export interface PromptFileView {
	id: string; path: string; kind: "system" | "append" | "context"; scope: "user" | "project" | "context";
	content: string; version: string; exists: boolean; active: boolean; editable: boolean; tokens: number; changedOnDisk?: boolean; error?: string;
}
export interface SystemPromptState {
	raw: string; tokens: number; defaultPreamble: string; sections: PromptSectionView[]; rules: PromptRuleView[];
	tools: {name:string;custom:boolean;path?:string}[]; files: PromptFileView[]; opaque: boolean; forced: boolean;
	custom: boolean; trusted: boolean; pending: boolean; reloadError?: string; busy: boolean;
}
