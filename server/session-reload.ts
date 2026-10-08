import type { AgentSession } from "@earendil-works/pi-coding-agent";

const pending = new WeakMap<AgentSession, Promise<void>>();

/** Host reload entry points share one queue per native session. A failed
 * reload is reported to its caller without poisoning later retries. */
export function reloadSession(session: AgentSession): Promise<void> {
	const previous = pending.get(session) ?? Promise.resolve();
	const operation = previous.catch(() => {}).then(() => session.reload());
	pending.set(session, operation);
	void operation.finally(() => {
		if (pending.get(session) === operation) pending.delete(session);
	}).catch(() => {});
	return operation;
}
