import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PlanSnapshot, TaskProgress, UiMessage, UiToolCallBlock } from "../protocol.js";
import type { AgentMessage } from "../serialize.js";
import { latestPlan } from "./state.js";

const histories = new WeakMap<SessionManager, { leaf: string | null; messages?: UiMessage[] }>();
export function taskHistoryFromSession(manager: SessionManager, serialize: (message: AgentMessage) => UiMessage | null): UiMessage[] | undefined {
	const leaf = manager.getLeafId();
	const previous = histories.get(manager);
	if (previous?.leaf === leaf) return previous.messages;
	const branch = manager.getBranch();
	const messages = latestPlan(branch) ? branch.flatMap(entry => {
		if (entry.type !== "message") return [];
		const message = serialize(entry.message);
		return message ? [{ ...message, entryId: entry.id }] : [];
	}) : undefined;
	histories.set(manager, { leaf, messages });
	return messages;
}

/** Replay assistant call order, pairing results before the following call. */
export function planFromTranscript(messages: UiMessage[]): { plan?: NonNullable<TaskProgress["plan"]>; known: boolean } {
	const results = new Map(messages.filter(message => message.role === "toolResult" && message.toolCallId).map(message => [message.toolCallId!, message]));
	let latest: PlanSnapshot | undefined;
	let confirmed = false;
	let changes: NonNullable<TaskProgress["plan"]>["changes"] = [];
	let changeSummary: string | undefined;
	const tools = new Map<string, string[]>();
	const removed = new Map<string, { id: string; title: string; detail?: string }>();
	const times = new Map<string, { startedAt?: number; endedAt?: number }>();
	for (const message of messages) {
		if (message.role === "user") { confirmed = false; continue; }
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const call = part as UiToolCallBlock;
			if (call.name !== "plan") {
				if (confirmed && latest?.status === "active" && latest.currentStepId) tools.set(latest.currentStepId, [...(tools.get(latest.currentStepId) ?? []), call.id]);
				continue;
			}
			const result = results.get(call.id);
			const next = !result?.isError ? result?.planSnapshot : undefined;
			if (!next) continue;
			if (next.planId !== latest?.planId) { tools.clear(); removed.clear(); times.clear(); changes = []; changeSummary = undefined; }
			else for (const step of latest.steps) if (!next.steps.some(item => item.id === step.id)) removed.set(step.id, step);
			for (const step of next.steps) {
				removed.delete(step.id);
				const time = times.get(step.id) ?? {};
				if (next.currentStepId === step.id && time.startedAt === undefined) time.startedAt = result?.timestamp;
				if (next.completedStepIds.includes(step.id) && time.endedAt === undefined) time.endedAt = result?.timestamp;
				times.set(step.id, time);
			}
			const structuralChanges = next.changes.flatMap(change => ["added", "removed", "updated"].includes(change.kind) && "title" in change ? [{ kind: change.kind as "added" | "removed" | "updated", title: change.title, position: change.position }] : []);
			if (structuralChanges.length) changes = structuralChanges;
			if (next.changeSummary) changeSummary = next.changeSummary;
			latest = next; confirmed = true;
		}
	}
	if (!latest) return { known: false };
	if (!confirmed && latest.status !== "active") return { known: true };
	return { known: true, plan: {
		source: "plan", origin: latest.planId, revision: latest.revision, status: latest.status, awaitingConfirmation: !confirmed,
		title: latest.title, completionCriteria: latest.completionCriteria, changeSummary,
		added: latest.changes.filter(change => change.kind === "added").length, removed: removed.size,
		changes,
		items: [...latest.steps.map(step => ({ ...step, status: latest.completedStepIds.includes(step.id) ? "done" as const : step.id === latest.currentStepId ? "running" as const : "pending" as const, toolCallIds: tools.get(step.id) ?? [], ...times.get(step.id) })), ...[...removed.values()].map(step => ({ ...step, status: "removed" as const, toolCallIds: tools.get(step.id) ?? [], ...times.get(step.id) }))],
	} };
}
