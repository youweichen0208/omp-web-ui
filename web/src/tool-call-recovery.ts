import type { ToolCallRecoveryDetails, UiMessage } from "../../server/protocol.js";

const keys = {
	retrying: "toolRecoveryRetrying",
	resumed: "toolRecoveryResumed",
	failed: "toolRecoveryFailed",
	"tool-error": "toolRecoveryToolError",
	exhausted: "toolRecoveryExhausted",
	unverified: "toolRecoveryUnverified",
	deferred: "toolRecoveryDeferred",
	cancelled: "toolRecoveryCancelled",
} as const satisfies Record<ToolCallRecoveryDetails["status"], string>;

/** Persisted details drive both full messages and collapsed previews. */
export function toolRecoveryKey(message: Pick<UiMessage, "role" | "customType" | "details">) {
	if (message.role !== "custom" || message.customType !== "tool-call-recovery" || !message.details || typeof message.details !== "object") return;
	const status = (message.details as { status?: unknown }).status;
	if (status === "deferred") {
		const reason = (message.details as { reason?: unknown }).reason;
		if (reason === "queued-message") return "toolRecoveryQueued";
		if (reason === "new-instruction") return "toolRecoveryInterrupted";
	}
	if (typeof status === "string" && Object.hasOwn(keys, status)) return keys[status as keyof typeof keys];
}
