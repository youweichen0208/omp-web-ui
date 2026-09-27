export type WaitingPhase = "analyzing" | "thinking" | "slow" | "handoff";

/** Before the server's three-minute silence notice, the assistant header
 * gives lightweight feedback about a request with no visible response yet. */
export function waitingPhase(elapsedSeconds: number): WaitingPhase {
	if (elapsedSeconds >= 180) return "handoff";
	if (elapsedSeconds >= 60) return "slow";
	if (elapsedSeconds >= 15) return "thinking";
	return "analyzing";
}
