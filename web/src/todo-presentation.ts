import type { UiMessage, UiTodoSnapshot } from "../../server/protocol.js";

type Todo = UiTodoSnapshot["tasks"][number];
export type TodoChange = { id: number; position: number; kind: "added" | "updated" | Todo["status"] };
type Target = { messageId: string; toolCallId: string };
export type TodoPresentation =
	| { kind: "card"; target: Target; tasks: Todo[] }
	| { kind: "update"; target?: Target; changes: TodoChange[]; cleared?: boolean }
	| { kind: "hidden"; target?: Target };

function changesBetween(before: Todo[], after: Todo[]): TodoChange[] {
	const previous = new Map(before.map((task) => [task.id, task]));
	return after.flatMap((task, index) => {
		const old = previous.get(task.id);
		const kind = !old ? "added" : old.status !== task.status ? task.status : old.subject !== task.subject ? "updated" : undefined;
		return kind ? [{ id: task.id, position: index + 1, kind }] : [];
	});
}

/** Read-only transcript projection. Group across SDK assistant/result boundaries,
 * but never across visible prose, other tools, failed or unfinished calls.
 * One live card per list; chronological updates retain their original changes.
 */
export function todoPresentation(messages: UiMessage[], results: ReadonlyMap<string, UiMessage>): Map<string, TodoPresentation> {
	const views = new Map<string, TodoPresentation>();
	let card: Extract<TodoPresentation, { kind: "card" }> | undefined;
	let previous: Todo[] = [];
	let run: { firstId: string; before: Todo[]; initial: boolean } | undefined;
	for (const message of messages) {
		if (message.role === "toolResult") continue;
		if (message.role !== "assistant") { run = undefined; continue; }
		for (const block of message.content) {
			if (block.type === "thinking") continue;
			if (block.type === "text" && typeof block.text === "string" && !block.text.trim() && !block.truncated) continue;
			if (block.type !== "toolCall" || block.name !== "todo" || typeof block.id !== "string") { run = undefined; continue; }
			const result = results.get(block.id);
			const snapshot = result?.todoSnapshot;
			if (!snapshot || result?.isError || snapshot.error) { run = undefined; continue; }
			if (snapshot.action === "clear") {
				views.set(block.id, { kind: "update", cleared: true, changes: [] });
				card = undefined; previous = []; run = undefined;
				continue;
			}
			if (snapshot.action === "init") { card = undefined; previous = []; run = undefined; }
			if (!card && !snapshot.tasks.length) {
				// An empty inspection has no checklist to show; retain the ordinary tool row.
				run = undefined;
				continue;
			}
			if (!card) {
				card = { kind: "card", target: { messageId: message.id, toolCallId: block.id }, tasks: snapshot.tasks };
				views.set(block.id, card);
				run = { firstId: block.id, before: [], initial: true };
			} else {
				const changes = changesBetween(previous, snapshot.tasks);
				if (!run && changes.length) run = { firstId: block.id, before: previous, initial: false };
				views.set(block.id, { kind: "hidden", target: card.target });
				if (run && !run.initial) {
					const merged = changesBetween(run.before, snapshot.tasks);
					views.set(run.firstId, merged.length ? { kind: "update", target: card.target, changes: merged } : { kind: "hidden", target: card.target });
				}
			}
			card.tasks = snapshot.tasks;
			previous = snapshot.tasks;
		}
	}
	return views;
}

/** Suppress empty assistant wrappers left behind by merged calls. */
export function isAbsorbedTodoMessage(message: UiMessage, views: ReadonlyMap<string, TodoPresentation>): boolean {
	return message.role === "assistant" && message.content.length > 0 && message.content.every((block) =>
		block.type === "text" && typeof block.text === "string" && !block.text.trim() && !block.truncated ||
		block.type === "toolCall" && typeof block.id === "string" && views.get(block.id)?.kind === "hidden",
	);
}
