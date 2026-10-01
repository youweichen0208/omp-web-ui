import { projectPrompt } from "./omp/prompt-content.js";
import type { SessionManager } from "./omp/index.js";
import type { TaskProgress, UiMessage, UiToolCallBlock } from "./protocol.js";
import type { AgentMessage } from "./serialize.js";

type Todo = { id: number; subject: string; phase?: string; blocker?: string; description?: string; status: "pending" | "in_progress" | "completed" | "deleted" | "blocked"; blockedBy?: number[]; metadata?: Record<string, unknown> };
type Snapshot = { tasks: Todo[]; nextId: number; action?: string; error?: string };
export function todoSnapshot(value: unknown): Snapshot | undefined {
	if (!value || typeof value !== "object") return;
	if ("phases" in value) {
		const native = value as { phases: unknown; op?: unknown };
		if (!Array.isArray(native.phases)) return;
		const tasks: Todo[] = [];
		const ids = new Set<number>();
		for (const phase of native.phases) {
			if (!phase || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return;
			for (const task of phase.tasks) {
				if (!task || typeof task.content !== "string" || !["pending", "in_progress", "completed", "abandoned", "blocked"].includes(task.status)) return;
				// Native tasks have no IDs. Content-based display IDs survive insertions;
				// collisions and repeated content are disambiguated within this snapshot.
				let id = 2166136261;
				for (const char of `${phase.name}\0${task.content}`) id = Math.imul(id ^ char.charCodeAt(0), 16777619) >>> 0;
				while (ids.has(id)) id = (id + 1) >>> 0;
				ids.add(id);
				tasks.push({ id, subject: task.content, phase: phase.name, status: task.status === "abandoned" ? "deleted" : task.status, ...(typeof task.blocker === "string" ? { blocker: task.blocker, description: task.blocker } : {}) });
			}
		}
		return { tasks, nextId: tasks.length + 1, action: native.op === "init" ? "init" : !tasks.length && native.op !== "view" ? "clear" : typeof native.op === "string" ? native.op : undefined };
	}
	const data = value as Snapshot;
	if (!Array.isArray(data.tasks) || !Number.isInteger(data.nextId) || !data.tasks.every((task) => task && Number.isInteger(task.id) && typeof task.subject === "string" && ["pending", "in_progress", "completed", "deleted"].includes(task.status))) return;
	if (data.tasks.some((task) => task.blockedBy !== undefined && (!Array.isArray(task.blockedBy) || !task.blockedBy.every(Number.isInteger)))) return;
	if (new Set(data.tasks.map((task) => task.id)).size !== data.tasks.length) return;
	return data;
}

// Cache by branch leaf, not model context: compaction drops old tool results from
// model context but the session branch still contains the authoritative snapshots.
const histories = new WeakMap<SessionManager, { leaf: string | undefined; messages?: UiMessage[] }>();
export function taskHistoryFromSession(manager: SessionManager, serialize: (message: AgentMessage) => UiMessage | null): UiMessage[] | undefined {
	const leaf = manager.getLeafId() ?? undefined;
	const previous = histories.get(manager);
	if (previous && previous.leaf === leaf) return previous.messages;
	const entries = manager.getBranch();
	const hasTodo = entries.some(entry => entry.type === "custom" && entry.customType === "user_todo_edit" || entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo" && todoSnapshot(entry.message.details));
	const messages = hasTodo ? entries.flatMap((entry) => {
		if (entry.type === "custom" && entry.customType === "user_todo_edit") return [{ id: `omp-todo-${entry.id}`, role: "custom", customType: "omp-todo-snapshot", content: [], details: entry.data, timestamp: Date.parse(entry.timestamp) } satisfies UiMessage];
		if (entry.type !== "message") return [];
		const serialized = serialize(projectPrompt(entry.message).at(-1)!);
		const message = serialized ? { ...serialized } : null;
		if (!message) return [];
		if (entry.message.role === "toolResult" && entry.message.toolName === "todo") message.details = entry.message.details;
		return [message];
	}) : undefined;
	histories.set(manager, { leaf, messages });
	return messages;
}

export function todoPlanFromTranscript(messages: UiMessage[]): { plan: NonNullable<TaskProgress["plan"]>; startIndex: number; lastUpdated: number; lastMutationIndex: number; cleared: boolean } | undefined {
	let latest: Snapshot | undefined;
	let startIndex = 0;
	let userIndex = 0;
	let revision = 0;
	let lastUpdated = 0;
	let lastMutationIndex = -1;
	let changeSummary: string | undefined;
	let origin = "";
	const tools = new Map<string, string[]>();
	const results = new Map(messages.filter((message) => message.role === "toolResult" && message.toolCallId).map((message) => [message.toolCallId!, message]));
	const emitted = new Set<string>();
	const ordered = messages.flatMap((message, index) => {
		if (message.role === "toolResult" && emitted.has(message.id)) return [];
		if (message.role !== "assistant") return [{ message, index }];
		return message.content.flatMap((part) => {
			const entries = [{ message: { ...message, content: [part] }, index }];
			if (part.type === "toolCall" && (part as UiToolCallBlock).name === "todo") {
				const result = results.get((part as UiToolCallBlock).id);
				if (result) { emitted.add(result.id); entries.push({ message: result, index }); }
			}
			return entries;
		});
	});
	const times = new Map<number, { startedAt?: number; endedAt?: number }>();
	let active: number | undefined;
	for (const { index, message } of ordered) {
		if (message.role === "user") userIndex = index;
		if (message.role === "assistant" && active !== undefined) for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const call = block as UiToolCallBlock;
			if (["todo", "task_plan"].includes(call.name)) continue;
			const key = String(active);
			tools.set(key, [...(tools.get(key) ?? []), call.id]);
		}
		if (!(message.role === "custom" && message.customType === "omp-todo-snapshot") && (message.role !== "toolResult" || message.toolName !== "todo" || message.isError)) continue;
		const snapshot = todoSnapshot(message.details);
		if (!snapshot || snapshot.error) continue;
		if (!latest || snapshot.action === "clear" || snapshot.action === "init") {
			startIndex = userIndex;
			origin = message.id;
			tools.clear(); times.clear(); revision = 0; changeSummary = undefined;
		}
		if (!latest?.tasks.length && snapshot.tasks.length) { startIndex = userIndex; origin = message.id; }
		if (JSON.stringify(latest?.tasks) !== JSON.stringify(snapshot.tasks)) {
			revision++;
			lastUpdated = message.timestamp ?? 0;
			lastMutationIndex = index;
		}
		for (const task of snapshot.tasks) {
			const time = times.get(task.id) ?? {};
			if (task.status === "in_progress" && time.startedAt === undefined) time.startedAt = message.timestamp;
			if (task.status === "completed" && time.endedAt === undefined) time.endedAt = message.timestamp;
			times.set(task.id, time);
			const before = latest?.tasks.find((old) => old.id === task.id);
			if (typeof task.metadata?.changeSummary === "string" && task.metadata.changeSummary !== before?.metadata?.changeSummary) changeSummary = task.metadata.changeSummary;
		}
		latest = snapshot;
		active = snapshot.tasks.find((task) => task.status === "in_progress")?.id;
	}
	if (!latest) return;
	const meta = latest.tasks.find((task) => typeof task.metadata?.title === "string" || typeof task.metadata?.completionCriteria === "string")?.metadata;
	return {
		startIndex, lastUpdated, lastMutationIndex, cleared: !latest.tasks.some((task) => task.status !== "deleted"),
		plan: {
			source: "todo", origin, revision, added: 0, removed: latest.tasks.filter((task) => task.status === "deleted").length,
			title: typeof meta?.title === "string" ? meta.title.slice(0, 80) : undefined,
			completionCriteria: typeof meta?.completionCriteria === "string" ? meta.completionCriteria.slice(0, 240) : undefined,
			changeSummary,
			items: latest.tasks.map((task) => ({
				id: String(task.id), title: task.subject, detail: task.description,
				status: task.status === "completed" ? "done" : task.status === "deleted" ? "removed" : task.status === "in_progress" ? "running" : "pending",
				blockedBy: (task.blockedBy ?? []).filter((id) => latest!.tasks.some((other) => other.id === id && other.status !== "completed" && other.status !== "deleted")).map(String),
				toolCallIds: tools.get(String(task.id)) ?? [], ...times.get(task.id),
			})),
		},
	};
}
