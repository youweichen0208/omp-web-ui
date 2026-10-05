import type { UiRecovery } from "../../server/protocol.js";
/** Anchor received durations to a monotonic browser clock, including reconnect snapshots. */
export function localRecoveryClock(recovery: UiRecovery | undefined, now = performance.now()): UiRecovery | undefined {
	if (!recovery) return recovery;
	return { ...recovery,
		retry: recovery.retry ? { ...recovery.retry, deadline: now + Math.max(0, recovery.retry.remainingMs ?? 0) } : undefined,
		summary: recovery.summary ? { ...recovery.summary, deadline: now + Math.max(0, recovery.summary.remainingMs ?? 0) } : undefined,
	};
}
