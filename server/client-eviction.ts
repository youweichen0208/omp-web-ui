/**
 * Idle client eviction policy.
 *
 * Every browser tab is a new clientId and the server used to keep its session
 * (runtime, timers, watchers) until shutdown. Per-client state that matters is
 * persisted (client-state.json + the SDK session files), so a client with no
 * socket and nothing running can be disposed and recreated on reconnect.
 */
export interface ClientIdleFacts {
	socketCount: number;
	/** ms epoch of the last detach; 0 while a socket is (or was never) detached. */
	idleSince: number;
	streamingConversations: number;
	queuedMessages: number;
	liveTerminals: number;
	backgroundTasks: number;
	switchingWorkspace: boolean;
	disposed: boolean;
}

export const DEFAULT_CLIENT_IDLE_MS = 30 * 60_000;

export function clientIdleMsFromEnv(value: string | undefined): number {
	if (value === undefined || value.trim() === "") return DEFAULT_CLIENT_IDLE_MS;
	const minutes = Number(value);
	return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : DEFAULT_CLIENT_IDLE_MS;
}

/** idleMs <= 0 disables eviction. */
export function isClientEvictable(facts: ClientIdleFacts, now: number, idleMs: number): boolean {
	if (idleMs <= 0 || facts.disposed || facts.switchingWorkspace) return false;
	if (facts.socketCount > 0 || facts.idleSince <= 0) return false;
	if (facts.streamingConversations > 0 || facts.queuedMessages > 0) return false;
	if (facts.liveTerminals > 0 || facts.backgroundTasks > 0) return false;
	return now - facts.idleSince >= idleMs;
}
