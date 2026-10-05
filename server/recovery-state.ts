import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { UiRecovery } from "./protocol.js";

export type RecoveryState = Omit<UiRecovery, "retry"> & { retry?: NonNullable<UiRecovery["retry"]> & { deadline: number } };

/** Compaction and its summary retry have independent lifetimes. */
export function recoveryEvent(state: RecoveryState, event: AgentSessionEvent, now = Date.now()): RecoveryState {
	switch (event.type) {
		case "compaction_start": return { ...state, compaction: { id: randomUUID(), reason: event.reason } };
		case "compaction_end": return { ...state, compaction: undefined };
		case "auto_retry_start": return { ...state, retry: { id: randomUUID(), phase: "waiting", attempt: event.attempt, maxAttempts: event.maxAttempts, deadline: now + event.delayMs, error: event.errorMessage.slice(0, 500) } };
		case "agent_start": return state.retry ? { ...state, retry: { ...state.retry, phase: "running" } } : state;
		case "auto_retry_end": return { ...state, retry: undefined };
		case "summarization_retry_scheduled": return { ...state, summary: { id: randomUUID(), source: state.compaction ? "compaction" : "branchSummary", phase: "waiting", attempt: event.attempt, maxAttempts: event.maxAttempts, deadline: now + event.delayMs, error: event.errorMessage.slice(0, 500) } };
		case "summarization_retry_attempt_start": return { ...state, summary: { ...state.summary, id: state.summary?.id ?? randomUUID(), source: event.source, phase: "running", deadline: undefined } };
		case "summarization_retry_finished": return { ...state, summary: undefined };
		case "agent_settled": return state.branch ? { branch: state.branch } : {};
		default: return state;
	}
}
export function isRecovering(state: UiRecovery): boolean { return !!(state.compaction || state.retry || state.summary || state.branch); }

/** Send durations, never compare clocks on different machines. Reconnection resamples the duration. */
export function recoverySnapshot(state: RecoveryState, now = Date.now()): UiRecovery {
	const { retry, summary, ...rest } = state;
	const snapshot: UiRecovery = { ...rest };
	if (retry) {
		const { deadline, ...operation } = retry;
		snapshot.retry = { ...operation, remainingMs: retry.phase === "waiting" ? Math.max(0, deadline - now) : 0 };
	}
	if (summary) {
		const { deadline, ...operation } = summary;
		snapshot.summary = { ...operation, remainingMs: summary.phase === "waiting" && deadline !== undefined ? Math.max(0, deadline - now) : 0 };
	}
	return snapshot;
}
