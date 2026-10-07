import type { PlanSnapshot, PlanChange, UiMessage } from "../../server/protocol.js";
type Target = { messageId: string; toolCallId: string };
export type PlanPresentation =
	| { kind: "card"; target: Target; snapshot: PlanSnapshot; changes: PlanChange[] }
	| { kind: "update"; target: Target; changes: PlanChange[] };

/** Invoked separately for each conversation. Never coalesce different plan IDs. */
export function planPresentation(messages: UiMessage[], results: ReadonlyMap<string, UiMessage>, conversationId: string): Map<string, PlanPresentation> {
	const views = new Map<string, PlanPresentation>();
	const cards = new Map<string, Extract<PlanPresentation, { kind: "card" }>>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "plan" || typeof block.id !== "string") continue;
			const result = results.get(block.id), snapshot = result?.planSnapshot;
			if (!snapshot || result?.isError) continue;
			for (const change of snapshot.changes) if (change.kind === "replaced") {
				const previous = cards.get(`${conversationId}:${change.planId}`);
				if (previous) previous.snapshot = { ...previous.snapshot, status: "cancelled", currentStepId: null };
			}
			let card = cards.get(`${conversationId}:${snapshot.planId}`);
			if (!card) {
				card = { kind: "card", target: { messageId: message.id, toolCallId: block.id }, snapshot, changes: snapshot.changes.filter(change => change.kind === "replaced") };
				cards.set(`${conversationId}:${snapshot.planId}`, card); views.set(block.id, card);
			} else {
				card.snapshot = snapshot;
				views.set(block.id, { kind: "update", target: card.target, changes: snapshot.changes });
			}
		}
	}
	return views;
}
