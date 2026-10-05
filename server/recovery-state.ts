import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { UiRecovery } from "./protocol.js";

/** Compaction and its summary retry have independent lifetimes. */
export function recoveryEvent(state: UiRecovery, event: AgentSessionEvent, now = Date.now()): UiRecovery {
	switch (event.type) {
		case "compaction_start": return { ...state, compaction: { id: randomUUID(), reason: event.reason } };
		case "compaction_end": return { ...state, compaction: undefined };
		case "auto_retry_start": return { ...state, retry: { id: randomUUID(), phase: "waiting", attempt: event.attempt, maxAttempts: event.maxAttempts, deadline: now + event.delayMs, error: event.errorMessage.slice(0, 500) } };
		case "agent_start": return state.retry ? { ...state, retry: { ...state.retry, phase: "running" } } : state;
		case "auto_retry_end": return { ...state, retry: undefined };
		case "summarization_retry_scheduled": return { ...state, summary: { id: randomUUID(), source: state.compaction ? "compaction" : "branchSummary", phase: "waiting", attempt: event.attempt, maxAttempts: event.maxAttempts, deadline: now + event.delayMs, error: event.errorMessage.slice(0, 500) } };
		case "summarization_retry_attempt_start": return { ...state, summary: { ...state.summary, id: state.summary?.id ?? randomUUID(), source: event.source, phase: "running", deadline: undefined } };
		case "summarization_retry_finished": return { ...state, summary: undefined };
		case "agent_settled": return {};
		default: return state;
	}
}
export function isRecovering(state: UiRecovery): boolean { return !!(state.compaction || state.retry || state.summary); }
