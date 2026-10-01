import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Aside = { message: Parameters<AgentSession["sendCustomMessage"]>[0] };
const groupedSessions = new WeakSet<AgentSession>();

/** nextTurn is not consumed by steer/followUp. Queue file cards only after
 * SDK preflight succeeds, alongside their question, and drain them together. */
export async function deliverPrompt(
	session: AgentSession, text: string, asides: Aside[], queue: boolean,
	acknowledge: (ok: boolean) => void,
): Promise<void> {
	let unsubscribeStart: (() => void) | undefined;
	const enqueue = (followUp: boolean) => {
		if (!asides.length) return;
		if (!groupedSessions.has(session)) {
			groupedSessions.add(session);
			const { steeringMode, followUpMode } = session.agent;
			session.agent.steeringMode = "all";
			session.agent.followUpMode = "all";
			const unsubscribe = session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				session.agent.steeringMode = steeringMode;
				session.agent.followUpMode = followUpMode;
				groupedSessions.delete(session);
				unsubscribe();
			});
		}
		for (const aside of asides) {
			const message = { ...aside.message, role: "custom" as const, timestamp: Date.now() };
			if (followUp) session.agent.followUp(message);
			else session.agent.steer(message);
		}
	};
	try {
		await session.prompt(text, {
			streamingBehavior: queue ? "followUp" : "steer",
			preflightResult: (ok) => {
				if (ok && asides.length) {
					if (session.isStreaming) enqueue(queue);
					else {
						// Normal prompts start the loop after preflight. The first queue
						// poll is after their user message; extension-only commands do
						// not start a loop and must not leave stale file context behind.
						unsubscribeStart = session.subscribe((event) => {
							if (event.type !== "agent_start") return;
							unsubscribeStart?.();
							enqueue(false);
						});
					}
				}
				acknowledge(ok);
			},
		});
	} finally { unsubscribeStart?.(); }
}
