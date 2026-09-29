import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ToolCallRecoveryDetails } from "./protocol.js";
import { todoSnapshot } from "./todo-progress.js";

interface Reply { role: string; stopReason?: string; content?: unknown }

/** A narrow detector, not an XML interpreter. Keep Markdown boundaries intact. */
export function malformedToolCall(message: Reply, tools: readonly string[]): string | undefined {
	if (message.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content)) return;
	if (message.content.some((part) => part?.type === "toolCall")) return;
	const text = message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
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

type Status = ToolCallRecoveryDetails["status"];
type Session = Pick<AgentSession, "agent" | "getActiveToolNames" | "sendCustomMessage">;
interface Recovery {
	attempted: boolean;
	activeTask?: number;
	todoStarts: Map<string, number>;
	pending?: { toolName: string; started: boolean; result?: boolean };
}
const states = new WeakMap<Session, Recovery>();
const content: Record<Status, string> = {
	retrying: "The previous reply printed an XML tool invocation as text. That invocation was NOT executed. Use the native tool-call interface if continuing the current authorized task is appropriate. Respect all user and skill stop, confirmation, and waiting requirements. Do not repeat successful operations or print another <invoke> block. If you cannot continue, explain why. This is the only automatic correction for this run.",
	resumed: "A native call to the indicated tool returned successfully after correction. This confirms tool execution, not completion of the task or correctness of the arguments.",
	failed: "Tool-call correction failed or the native tool returned an error. No further automatic correction will be requested in this run. Check the unfinished task before continuing manually.",
	unverified: "Correction ended without a successful native call to the indicated tool. Task completion has not been verified. Check the unfinished task before continuing manually.",
	deferred: "No automatic tool-call correction: a new message is pending, or this turn has not explicitly started a todo step. Follow the current user or extension instructions.",
	cancelled: "Tool-call correction stopped because the run was cancelled. No automatic continuation will be requested.",
};

function publish(session: Session, status: Status, toolName: string, triggerTurn = false): void {
	const details: ToolCallRecoveryDetails = { status, toolName };
	// The SDK enqueues synchronously; there is no await between checking its
	// actual queues and appending our one follow-up. Never run parsed arguments.
	void session.sendCustomMessage({ customType: "tool-call-recovery", display: true, content: content[status], details }, { deliverAs: "followUp", triggerTurn }).catch((error) => {
		console.warn("[tool-call-recovery] Could not record recovery status:", error);
	});
}

/** Called by the host subscriber AFTER SDK extension handlers, once per event. */
export function handleToolCallRecovery(session: Session, event: AgentSessionEvent): void {
	if (event.type === "agent_start") {
		states.set(session, { attempted: false, todoStarts: new Map() });
		return;
	}
	const state = states.get(session);
	if (!state) return;
	const finish = (status: Status) => {
		const pending = state.pending;
		state.pending = undefined;
		if (pending) publish(session, status, pending.toolName);
	};
	if (event.type === "message_start") {
		const message = event.message;
		if (message.role === "custom" && message.customType === "tool-call-recovery") {
			if ((message.details as ToolCallRecoveryDetails | undefined)?.status === "retrying" && state.pending) state.pending.started = true;
		} else if (message.role === "user" || message.role === "custom") {
			// Neither old transcript tasks nor an earlier queued request authorize
			// resuming work for this new instruction. Preserve the run retry cap.
			state.activeTask = undefined;
			state.todoStarts.clear();
			finish("deferred");
		}
		return;
	}
	if (event.type === "tool_execution_start" && event.toolName === "todo") {
		const args = event.args;
		if (args?.action === "update" && args.status === "in_progress" && Number.isInteger(args.id)) state.todoStarts.set(event.toolCallId, args.id);
		return;
	}
	if (event.type === "tool_execution_end") {
		if (event.toolName === "todo") {
			const id = state.todoStarts.get(event.toolCallId);
			state.todoStarts.delete(event.toolCallId);
			const snapshot = !event.isError && todoSnapshot(event.result?.details);
			if (snapshot && !snapshot.error) {
				if (id !== undefined && snapshot.tasks.some((task) => task.id === id && task.status === "in_progress")) state.activeTask = id;
				if (!snapshot.tasks.some((task) => task.id === state.activeTask && task.status === "in_progress")) state.activeTask = undefined;
			}
		}
		if (state.pending?.started && event.toolName === state.pending.toolName) {
			// rpiv-todo reports domain failures in details.error without isError.
			// A later success in the same batch must not hide an earlier failure.
			const failed = event.isError || (event.toolName === "todo" && !!todoSnapshot(event.result?.details)?.error);
			state.pending.result = (state.pending.result ?? true) && !failed;
		}
		return;
	}
	if (event.type === "agent_end") {
		finish(session.agent.signal?.aborted ? "cancelled" : "unverified");
		return;
	}
	if (event.type !== "turn_end") return;
	const message = event.message;
	if (session.agent.signal?.aborted || (message.role === "assistant" && message.stopReason === "aborted")) {
		finish("cancelled");
		return;
	}
	const name = malformedToolCall(message, session.getActiveToolNames());
	if (state.pending?.started) {
		if (state.pending.result !== undefined) finish(state.pending.result ? "resumed" : "failed");
		else if (name || (message.role === "assistant" && ["stop", "error", "length"].includes(message.stopReason))) {
			finish(name ? "failed" : "unverified");
			return;
		}
	}
	if (!name) return;
	if (state.attempted) { publish(session, "failed", name); return; }
	// hasPendingMessages() omits custom extension follow-ups. Inspect the core
	// queues only after every turn_end extension has had a chance to enqueue.
	if (session.agent.hasQueuedMessages() || state.activeTask === undefined) {
		publish(session, "deferred", name);
		return;
	}
	state.attempted = true;
	state.pending = { toolName: name, started: false };
	publish(session, "retrying", name, true);
}
