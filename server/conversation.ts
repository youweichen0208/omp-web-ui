import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { UiMessage } from "./protocol.js";
import type { RecoveryState } from "./recovery-state.js";
import type { SessionTreeController } from "./session-tree-controller.js";
import type { TerminalManager } from "./terminals.js";
import type { ThinkingTimings } from "./thinking-timing.js";
import type { WebUIContext } from "./webui-context.js";

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

/**
 * One open conversation (chat thread) of a client. Each conversation owns its
 * OWN AgentSessionRuntime, so starting a new chat or switching between chats
 * never interrupts another conversation's in-flight run.
 */
export interface Conversation {
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
	/** Automatic requests to re-issue a tool call written as text, for the current
	 *  user prompt. Cleared by the next prompt from the user. */
	toolTextContinues: number;
	/** A real tool ran since the last automatic request (the model is making progress). */
	toolRanSinceContinue: boolean;

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
	/** The seq assigned to each user message, so a cache miss never renumbers it. */
	userSeqByKey: Map<string, number>;
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

/** Cap on simultaneously open conversations of ONE project (each keeps a full
 *  runtime alive; conversations of other projects keep their own lists). */
export const MAX_OPEN_CONVERSATIONS = 8;
export const DEFAULT_CONV_TITLE = "新对话";

// Mirrors web/src/skill-block.ts's parseSkillBlock (which itself mirrors the
// pi SDK's dist/core/agent-session.js) — kept in sync by hand, server and
// web can't share a module across the tsconfig split. When the user sends
// /skill:name args, the SDK expands the prompt into
// `<skill name="..." location="...">\n...SKILL.md body...\n</skill>\n\n<args>`;
// using that raw text as a conversation title would dump (and mid-sentence
// truncate) the entire skill body instead of something readable.
const SKILL_BLOCK_TITLE_RE =
	/^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

export function skillAwareTitleText(text: string): string {
	const m = text.match(SKILL_BLOCK_TITLE_RE);
	if (!m) return text;
	const name = m[1];
	const args = m[2]?.trim();
	return `skill:${name}` + (args ? ` · ${args}` : "");
}

/** First user text in a session, truncated for the conversation list. */
export function conversationTitle(session: AgentSession): string {
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
