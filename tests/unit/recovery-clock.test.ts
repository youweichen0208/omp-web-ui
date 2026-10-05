import { expect, test } from "vitest";
import { recoveryEvent, recoverySnapshot } from "../../server/recovery-state.js";
import { localRecoveryClock } from "../../web/src/recovery-clock.js";
test("retry and summary countdowns survive clock skew, reconnect and repeated snapshots", () => {
	for (const event of [
		{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10000, errorMessage: "busy" },
		{ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 10000, errorMessage: "busy" },
	] as const) {
		const state = recoveryEvent({}, event, 2_000_000);
		const wire = recoverySnapshot(state, 2_003_000);
		expect(JSON.stringify(wire)).not.toContain("deadline");
		const local = localRecoveryClock(wire, 100)!;
		expect((local.retry ?? local.summary)?.deadline).toBe(7100);
		const reconnected = localRecoveryClock(recoverySnapshot(state, 2_008_000), 400)!;
		expect((reconnected.retry ?? reconnected.summary)?.deadline).toBe(2400);
		expect((recoverySnapshot(state, 2_020_000).retry ?? recoverySnapshot(state, 2_020_000).summary)?.remainingMs).toBe(0);
	}
});
