import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ToolCallRecoveryDetails } from "./protocol.js";
import { todoSnapshot } from "./todo-progress.js";

interface Reply { role: string; stopReason?: string; content?: unknown; customType?: string; details?: unknown; timestamp?: number }

function textOf(message: Reply): string {
	if (typeof message.content === "string") return message.content;
	return Array.isArray(message.content) ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";
}

/** A narrow detector, not an XML interpreter. Keep Markdown boundaries intact. */
export function malformedToolCall(message: Reply, tools: readonly string[]): string | undefined {
	if (message.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content)) return;
	if (message.content.some((part) => part?.type === "toolCall")) return;
	const text = textOf(message);
	const call = /(?:^|\n) {0,3}<invoke\s+name=["']([\w.-]+)["']\s*>\s*(?:<parameter\s+name=["'][\w.-]+["']\s*>[\s\S]*?<\/parameter>\s*)+<\/invoke>\s*$/.exec(text);
	if (!call || !tools.includes(call[1])) return;
	const prefix = text.slice(0, call.index + (text[call.index] === "\n" ? 1 : 0));
	let fence: { char: string; length: number } | undefined;
	for (const line of prefix.split("\n")) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (!marker) continue;
		if (!fence) fence = { char: marker[1][0], length: marker[1].length };
		else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
	}
	// A multiline inline-code span or a lazy quote/list continuation is also an
	// example. Ambiguous Markdown is deliberately left for the user to continue.
	const paragraph = prefix.split(/\n\s*\n/).at(-1) ?? "";
	if (fence || /`|^\s*(?:>|[-*+]\s|\d+[.)]\s)/m.test(paragraph)) return;
	return call[1];
}

/** Only explicit short continuation requests, never arbitrary new instructions. */
export function recoveryContinuation(message: Reply): boolean {
	if (message.role !== "user") return false;
	if (Array.isArray(message.content) && message.content.some((part) => part?.type !== "text")) return false;
	return /^(?:(?:怎么|为什么)(?:又)?卡住了[\s，。！!？?]*)?(?:(?:可以|能)?(?:帮我)?继续(?:吗|吧)?|请继续|接着(?:做|核实)?|(?:please )?(?:continue|resume))[\s，。！!？?]*$/i.test(textOf(message).trim());
}

/** A narrow acknowledgement of imminent work, not a generic unfinished-task detector. */
export function continuationPromise(message: Reply): boolean {
	if (message.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content)) return false;
	if (message.content.some((part) => part?.type === "toolCall")) return false;
	const text = textOf(message).trim();
	if (!text || text.length > 240 || /[?？`<>]|等待|确认|批准|授权|不能|无法|完成|暂停|不要|\b(?:wait|confirm|approval|cannot|can't|done|completed|stop)\b/i.test(text)) return false;
	return /(?:让我|我会|我将|现在)(?:继续)?(?:核实|检查|读取|查看|处理|执行|推进|验证|继续)(?:一下)?[。.!！]*$/.test(text)
		|| /\b(?:I(?:'ll| will)|let me) (?:continue|resume|check|verify|read)(?: now)?[.!]*$/i.test(text);
}

/** Stay within the immediately unresolved exchange, including restored transcripts. */
export function unresolvedRecoveryTool(messages: readonly Reply[], tools: readonly string[]): string | undefined {
	for (const message of messages.slice(-16).toReversed()) {
		if (message.role === "custom" && message.customType === "tool-call-recovery") {
			const status = (message.details as ToolCallRecoveryDetails | undefined)?.status;
			if (!["retrying", "failed", "unverified", "deferred", "exhausted"].includes(status ?? "")) return;
			continue;
		}
		const tool = malformedToolCall(message, tools);
		if (tool) return tool;
		if (continuationPromise(message) || recoveryContinuation(message)) continue;
		return;
	}
}

type Status = ToolCallRecoveryDetails["status"];
type Session = Pick<AgentSession, "agent" | "messages" | "getActiveToolNames" | "sendCustomMessage">;
const MAX_CORRECTIONS_PER_RUN = 3;
interface Recovery {
	attempts: number;
	progressSinceCorrection: boolean;
	candidate?: string;
	resumeTool?: string;
	pending?: { toolName: string; started: boolean; result?: boolean };
}
const states = new WeakMap<Session, Recovery>();
const content: Record<Status, string> = {
	retrying: "A prior reply printed an XML tool invocation as text. That invocation was NOT executed. A promise to continue is not tool execution. Use the native tool-call interface if continuing the current authorized task is appropriate. Respect all user and skill stop, confirmation, and waiting requirements. Do not repeat successful operations or print another <invoke> block. If you cannot continue, explain why. This is one bounded formatting correction. A failed or timed-out command may already have taken effect: inspect its actual state before repeating an operation. If tools keep failing, report the blocker rather than retrying blindly.",
	resumed: "A native call to the indicated tool returned successfully after correction. This confirms tool execution, not completion of the task or correctness of the arguments.",
	failed: "The model printed another unexecuted invocation without intervening successful tool execution. This correction will not be repeated without progress. Check the unfinished task before continuing manually.",
	"tool-error": "The tool-call format was corrected, but the native tool returned an error or timeout. A timeout does not prove the operation had no effect. Inspect actual state before repeating an operation; do not treat this as task completion.",
	exhausted: "The automatic formatting correction budget for this run is exhausted. The latest invocation printed as text was not executed. Check the unfinished task before continuing manually.",
	unverified: "Correction ended without a successful native call to the indicated tool. Task completion has not been verified. Check the unfinished task before continuing manually.",
	deferred: "No automatic tool-call correction because a new user or extension message takes priority. Follow that message; no invocation printed as text was executed.",
	cancelled: "Tool-call correction stopped because the run was cancelled. No automatic continuation will be requested.",
};

function publish(session: Session, status: Status, toolName: string, triggerTurn = false, reason?: ToolCallRecoveryDetails["reason"]): void {
	const details: ToolCallRecoveryDetails = { status, toolName, ...(reason ? { reason } : {}) };
	// The SDK enqueues synchronously; there is no await between checking its
	// actual queues and appending our one follow-up. Never run parsed arguments.
	void session.sendCustomMessage({ customType: "tool-call-recovery", display: true, content: content[status], details }, { deliverAs: "followUp", triggerTurn }).catch((error) => {
		console.warn("[tool-call-recovery] Could not record recovery status:", error);
	});
}

/** Install before a run starts: the SDK captures this hook in its loop config. */
export function installToolCallRecovery(session: Session): () => void {
	const previous = session.agent.shouldStopAfterTurn;
	let active = true;
	const check: NonNullable<typeof previous> = async (context, signal) => {
		const stop = await previous?.(context, signal) ?? false;
		if (!active) return stop;
		const state = states.get(session);
		const name = state?.candidate;
		if (!state || !name) return stop;
		state.candidate = undefined;
		// prepareNextTurn and the previous stop hook may await I/O. Only commit
		// after both have settled, immediately before the SDK drains its queues.
		// An already queued follow-up cannot be selectively removed by the SDK.
		if (stop || signal?.aborted) publish(session, "cancelled", name);
		else if (session.agent.hasQueuedMessages()) publish(session, "deferred", name, false, "queued-message");
		else if (!session.getActiveToolNames().includes(name)) publish(session, "unverified", name);
		else if (state.attempts >= MAX_CORRECTIONS_PER_RUN) publish(session, "exhausted", name);
		else if (!state.progressSinceCorrection) publish(session, "failed", name);
		else {
			state.attempts++;
			state.progressSinceCorrection = false;
			state.resumeTool = undefined;
			state.pending = { toolName: name, started: false };
			publish(session, "retrying", name, true);
		}
		return stop;
	};
	session.agent.shouldStopAfterTurn = check;
	return () => {
		active = false;
		if (session.agent.shouldStopAfterTurn === check) session.agent.shouldStopAfterTurn = previous;
	};
}

/** Called by the host subscriber AFTER SDK extension handlers, once per event. */
export function handleToolCallRecovery(session: Session, event: AgentSessionEvent): void {
	if (event.type === "agent_start") {
		states.set(session, { attempts: 0, progressSinceCorrection: true });
		return;
	}
	const state = states.get(session);
	if (!state) return;
	const finish = (status: Status) => {
		const pending = state.pending;
		state.pending = undefined;
		if (pending) publish(session, status, pending.toolName, false, status === "deferred" ? "new-instruction" : undefined);
	};
	if (event.type === "message_start") {
		const message = event.message;
		if (message.role === "custom" && message.customType === "tool-call-recovery") {
			if ((message.details as ToolCallRecoveryDetails | undefined)?.status === "retrying" && state.pending) state.pending.started = true;
		} else if (message.role === "user" || message.role === "custom") {
			const candidate = state.candidate;
			state.candidate = undefined;
			if (candidate) publish(session, "deferred", candidate, false, "new-instruction");
			state.resumeTool = undefined;
			if (recoveryContinuation(message)) {
				const messages = session.messages;
				const last = messages.at(-1);
				const history = last?.role === "user" && last.timestamp === message.timestamp ? messages.slice(0, -1) : messages;
				state.resumeTool = unresolvedRecoveryTool(history, session.getActiveToolNames());
			}
			// New instructions take priority and cannot replenish the per-run budget.
			state.progressSinceCorrection = state.attempts === 0;
			finish("deferred");
		}
		return;
	}
	if (event.type === "tool_execution_start") {
		// Any real tool call means this continuation did more than acknowledge.
		state.resumeTool = undefined;
		return;
	}
	if (event.type === "tool_execution_end") {
		// rpiv-todo can report a domain failure without setting isError.
		const failed = event.isError || (event.toolName === "todo" && !!todoSnapshot(event.result?.details)?.error);
		if (!failed) state.progressSinceCorrection = true;
		if (state.pending?.started && event.toolName === state.pending.toolName) {
			// A later success in the same batch must not hide an earlier failure.
			state.pending.result = (state.pending.result ?? true) && !failed;
		}
		return;
	}
	if (event.type === "agent_end") {
		state.candidate = undefined;
		finish(session.agent.signal?.aborted ? "cancelled" : "unverified");
		return;
	}
	if (event.type !== "turn_end") return;
	const message = event.message;
	if (session.agent.signal?.aborted || (message.role === "assistant" && message.stopReason === "aborted")) {
		finish("cancelled");
		return;
	}
	const tools = session.getActiveToolNames();
	const name = malformedToolCall(message, tools) ?? (state.resumeTool && tools.includes(state.resumeTool) && continuationPromise(message) ? state.resumeTool : undefined);
	if (state.pending?.started) {
		if (state.pending.result !== undefined) finish(state.pending.result ? "resumed" : "tool-error");
		else if (name || (message.role === "assistant" && ["stop", "error", "length"].includes(message.stopReason))) {
			finish(name && !state.progressSinceCorrection ? "failed" : "unverified");
			if (!name || !state.progressSinceCorrection) return;
		}
	}
	state.candidate = name;
}
