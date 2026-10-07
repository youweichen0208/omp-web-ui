import { planFromTranscript as nativePlanFromTranscript } from "./plan/progress.js";
import type { TaskProgress, TaskStep, UiMessage, UiToolCallBlock } from "./protocol.js";

const short = (text: string, limit: number) => {
	const first = text.trim().replace(/\s+/g, " ").split(/[。！？\n]/)[0]?.trim() ?? "";
	return first.length > limit ? `${first.slice(0, limit)}…` : first;
};

const continuation = /^(?:继续(?:吧|吗)?|可以(?:的|吧|了)?|好的?|开始|接着|可以(?:帮我)?继续(?:吗|吧)?|帮我继续(?:吗|吧)?|please continue|continue)[\s，。！!？?]*$/i;
const nextStep = /^(?:(?:可以|能)?(?:帮我)?(?:开始|继续|接着|进行)(?:下一步|下个阶段|后续工作)?(?:吗|吧|了)?|下一步(?:呢|是什么)?)[\s，。！!？?]*$/i;
const optionReply = /^(?:[1-9]\d?|[A-D])(?:[.、)）])?[\s。！!]*$/i;
const vagueRequest = (text: string) => continuation.test(text.trim()) || nextStep.test(text.trim()) || optionReply.test(text.trim());
const greeting = /^(?:hi|hello|hey|你好|嗨|在吗|谢谢)[\s，。！!？?]*$/i;

function taskTitle(messages: UiMessage[], userIndex: number, steps: TaskStep[]): string {
	const textOf = (message: UiMessage) => message.content.map((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join(" ");
	const current = textOf(messages[userIndex]);
	if (vagueRequest(current)) {
		for (let index = userIndex - 1; index >= 0; index--) {
			if (messages[index].role !== "user") continue;
			const previous = textOf(messages[index]);
			if (!vagueRequest(previous) && !greeting.test(previous.trim()) && previous.trim()) return short(previous, 56);
		}
		const firstAction = steps.find((step) => step.title && step.title !== "正在分析请求");
		if (firstAction) return short(firstAction.title, 56);
	}
	return short(current, 56) || "当前任务";
}

function artifact(call: UiToolCallBlock): TaskStep["artifacts"][number] {
	let args: Record<string, unknown> = {};
	try { args = JSON.parse(call.argumentsText ?? "{}") as Record<string, unknown>; } catch { /* keep tool name */ }
	const path = typeof args.path === "string" ? args.path : undefined;
	const command = typeof args.command === "string" ? args.command : undefined;
	return { toolCallId: call.id, kind: call.name, label: path ?? (command ? short(command, 78) : call.name), ...(path ? { path } : {}) };
}

function defaultTitle(calls: UiToolCallBlock[]): string {
	if (calls.length === 1) {
		const item = artifact(calls[0]);
		return item.kind === "bash" ? `运行 ${item.label}` : item.path ? `${item.kind} ${item.label}` : item.label;
	}
	const name = calls.every((call) => call.name === calls[0].name) ? calls[0].name : "工具";
	return `${name === "read" ? "读取" : name === "write" ? "写入" : name === "bash" ? "运行" : name} ${calls.length} 项`;
}

function planFromTranscript(tail: UiMessage[], results: Map<string, UiMessage>, actualSteps: TaskStep[], finished: boolean, finishedAt?: number): TaskProgress["plan"] {
	const revisions: { steps: { id: string; title: string; detail?: string }[]; title?: string; completionCriteria?: string; changeSummary?: string; currentStepId?: string; completedStepIds: string[]; timestamp: number }[] = [];
	const toolCallIds = new Map<string, string[]>();
	let activeStepId: string | undefined;
	for (const message of tail) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			if ((part as UiToolCallBlock).name !== "task_plan") {
				if (activeStepId) toolCallIds.set(activeStepId, [...(toolCallIds.get(activeStepId) ?? []), (part as UiToolCallBlock).id]);
				continue;
			}
			if (results.get((part as UiToolCallBlock).id)?.isError) continue;
			try {
				const data = JSON.parse((part as UiToolCallBlock).argumentsText ?? "{}");
				if (!Array.isArray(data.steps) || !data.steps.length || data.steps.length > 16 || !data.steps.every((step: unknown) => typeof step === "object" && step !== null && typeof (step as { id?: unknown }).id === "string" && typeof (step as { title?: unknown }).title === "string")) continue;
				const steps = (data.steps as { id: string; title: string; detail?: unknown }[]).map((step) => ({ id: step.id.trim(), title: short(step.title, 80), ...(typeof step.detail === "string" ? { detail: step.detail.slice(0, 500) } : {}) }));
				if (steps.some((step) => !step.id || !step.title) || new Set(steps.map((step) => step.id)).size !== steps.length) continue;
				const ids = new Set(steps.map((step) => step.id));
				if (data.currentStepId && !ids.has(data.currentStepId) || Array.isArray(data.completedStepIds) && data.completedStepIds.some((id: unknown) => typeof id !== "string" || !ids.has(id))) continue;
				revisions.push({ steps, title: typeof data.title === "string" ? short(data.title, 80) : undefined, completionCriteria: typeof data.completionCriteria === "string" ? data.completionCriteria.trim().slice(0, 240) : undefined, changeSummary: typeof data.changeSummary === "string" ? data.changeSummary.trim().slice(0, 240) : undefined, currentStepId: typeof data.currentStepId === "string" ? data.currentStepId : undefined, completedStepIds: Array.isArray(data.completedStepIds) ? data.completedStepIds.filter((id: unknown): id is string => typeof id === "string") : [], timestamp: message.timestamp ?? 0 });
				activeStepId = data.currentStepId || steps.find((step) => !revisions.at(-1)!.completedStepIds.includes(step.id))?.id;
			} catch { /* incomplete streamed tool arguments */ }
		}
	}
	if (!revisions.length) return undefined;
	const latest = revisions.at(-1)!;
	const previous = revisions.at(-2);
	const before = new Set(previous?.steps.map((step) => step.id));
	const current = new Set(latest.steps.map((step) => step.id));
	const history = new Map<string, { title: string; revision: number }>();
	for (const [revision, entry] of revisions.entries()) for (const step of entry.steps) if (!history.has(step.id)) history.set(step.id, { title: step.title, revision });
	const timings = new Map<string, { startedAt?: number; endedAt?: number }>();
	for (const entry of revisions) {
		if (entry.currentStepId && entry.timestamp) {
			const timing = timings.get(entry.currentStepId) ?? {};
			if (!timing.startedAt) timing.startedAt = entry.timestamp;
			timings.set(entry.currentStepId, timing);
		}
		for (const id of entry.completedStepIds) {
			const timing = timings.get(id) ?? {};
			if (entry.timestamp && !timing.endedAt) timing.endedAt = entry.timestamp;
			timings.set(id, timing);
		}
	}
	const completed = new Set(latest.completedStepIds);
	const items: NonNullable<TaskProgress["plan"]>["items"] = latest.steps.map((step) => ({ id: step.id, title: step.title, detail: step.detail, toolCallIds: toolCallIds.get(step.id) ?? [], status: finished || completed.has(step.id) ? "done" : step.id === latest.currentStepId || !latest.currentStepId && step.id === latest.steps.find((item) => !completed.has(item.id))?.id ? "running" : "pending", ...(history.get(step.id)!.revision > 0 ? { added: true } : {}), ...timings.get(step.id), ...(finishedAt && timings.get(step.id)?.startedAt && !timings.get(step.id)?.endedAt ? { endedAt: finishedAt } : {}) }));
	for (const item of items) {
		const actions = { read: 0, write: 0, edit: 0, command: 0 };
		for (const step of actualSteps) {
			for (const artifact of step.artifacts) {
				if (!item.toolCallIds?.includes(artifact.toolCallId)) continue;
				if (artifact.kind === "read") actions.read++;
				else if (artifact.kind === "write") actions.write++;
				else if (artifact.kind === "edit") actions.edit++;
				else if (["bash", "terminal"].includes(artifact.kind)) actions.command++;
			}
		}
		if (Object.values(actions).some(Boolean)) item.actions = actions;
	}
	for (const [id, entry] of history) if (!current.has(id)) items.push({ id, title: entry.title, status: "removed", toolCallIds: toolCallIds.get(id) ?? [], ...timings.get(id) });
	let changes: NonNullable<TaskProgress["plan"]>["changes"] = [];
	let changeSummary: string | undefined;
	for (let index = 1; index < revisions.length; index++) {
		const oldSteps = revisions[index - 1].steps;
		const newSteps = revisions[index].steps;
		const delta: NonNullable<typeof changes> = [];
		for (const [position, step] of newSteps.entries()) {
			const oldIndex = oldSteps.findIndex((old) => old.id === step.id);
			if (oldIndex < 0) delta.push({ kind: "added", title: step.title, position: position + 1 });
			else if (oldSteps[oldIndex].title !== step.title || oldIndex !== position && oldSteps.length === newSteps.length) delta.push({ kind: "updated", title: step.title, position: position + 1 });
		}
		for (const step of oldSteps) if (!newSteps.some((next) => next.id === step.id)) delta.push({ kind: "removed", title: step.title });
		if (delta.length) { changes = delta; changeSummary = revisions[index].changeSummary; }
	}
	return { revision: revisions.length, title: [...revisions].reverse().find((entry) => entry.title)?.title, completionCriteria: [...revisions].reverse().find((entry) => entry.completionCriteria)?.completionCriteria, changeSummary, changes, added: previous ? latest.steps.filter((step) => !before.has(step.id)).length : 0, removed: previous ? previous.steps.filter((step) => !current.has(step.id)).length : 0, items };
}

/** P0: infer the current task from the server's serialized transcript. The
 * transcript remains authoritative; no browser heuristic decides completion. */
export function deriveTaskProgress(conversationId: string, messages: UiMessage[], streamingMessage: UiMessage | null, isStreaming: boolean, turnEndedAt?: number): TaskProgress | null {
	const recorded = nativePlanFromTranscript([...messages, ...(streamingMessage ? [streamingMessage] : [])]);
	const latestUserIndex = messages.findLastIndex((message) => message.role === "user" && message.content.some((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string"));
	if (latestUserIndex < 0) return null;
	const userIndex = latestUserIndex;
	const user = messages[userIndex];
	const tail = [...messages.slice(userIndex + 1), ...(streamingMessage?.role === "assistant" ? [streamingMessage] : [])];
	// A plain conversation is not a task. Create the panel only after pi has
	// actually invoked a tool in this turn.
	if (!recorded.plan && !tail.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall"))) return null;
	const results = new Map(tail.filter((message) => message.role === "toolResult" && message.toolCallId).map((message) => [message.toolCallId!, message]));
	const steps: TaskStep[] = [];
	for (const message of tail) {
		if (message.role !== "assistant") continue;
		let narrative = "";
		let calls: UiToolCallBlock[] = [];
		let group = 0;
		const flush = () => {
			if (!calls.length) return;
			const completed = calls.filter((call) => results.has(call.id)).length;
			const failed = calls.some((call) => results.get(call.id)?.isError);
			const status: TaskStep["status"] = completed < calls.length ? "running" : failed ? "failed" : "done";
			const endedAt = Math.max(message.timestamp ?? 0, ...calls.map((call) => results.get(call.id)?.timestamp ?? 0));
			steps.push({ id: `${message.id}:${group++}`, messageId: message.id, title: short(narrative, 24) || defaultTitle(calls), status, startedAt: message.timestamp ?? user.timestamp ?? 0, ...(status !== "running" ? { endedAt } : {}), hint: status === "running" ? `${completed}/${calls.length} 项完成` : failed ? "有工具执行失败" : `${calls.length} 项完成`, artifacts: calls.map((call) => {
				const item = artifact(call);
				const output = results.get(call.id)?.content.filter((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string").map((part) => (part as { text: string }).text).join("\n");
				const outputLines = output ? output.replace(/\n$/, "").split("\n").length : 0;
				return outputLines && ["bash", "read"].includes(item.kind) ? { ...item, outputLines } : item;
			}) });
			calls = [];
			narrative = "";
		};
		for (const part of message.content) {
			if (part.type === "toolCall" && typeof (part as UiToolCallBlock).id === "string") {
				if (["task_plan", "plan"].includes((part as UiToolCallBlock).name)) { flush(); continue; }
				calls.push(part as UiToolCallBlock);
			}
			else if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") { flush(); narrative = (part as { text: string }).text; }
		}
		flush();
	}
	if (isStreaming && !steps.some((step) => step.status === "running")) {
		const previous = [...tail].reverse().find((message) => message.role === "assistant");
		steps.push({ id: `${user.id}:pending`, messageId: previous?.id ?? user.id, title: "正在分析请求", status: "running", startedAt: previous?.timestamp ?? user.timestamp ?? 0, artifacts: [] });
	}
	const currentTail = messages.slice(latestUserIndex + 1).concat(streamingMessage ? [streamingMessage] : []);
	const cancelled = currentTail.some((message) => message.role === "assistant" && message.stopReason === "aborted");
	// Earlier failed commands can be followed by a successful fix or rerun.
	// The latest completed tool group is the best observed outcome for this turn.
	const lastCompleted = steps.findLast((step) => step.status !== "running");
	// Plan calls do not create execution rows, but their latest unresolved error
	// must still prevent a successful turn status. A corrected call clears it.
	const planCalls = currentTail.flatMap(message => message.role === "assistant" ? message.content.filter((part): part is UiToolCallBlock => part.type === "toolCall" && ["plan", "task_plan"].includes((part as UiToolCallBlock).name)) : []);
	const planFailed = results.get(planCalls.at(-1)?.id ?? "")?.isError === true;
	const status: TaskProgress["status"] = cancelled ? "cancelled" : isStreaming ? "running" : planFailed || lastCompleted?.status === "failed" ? "failed" : "done";
	const plannedEnd = status === "done" ? Math.max(user.timestamp ?? 0, turnEndedAt ?? 0, ...tail.map((message) => message.timestamp ?? 0), ...steps.map((step) => step.endedAt ?? 0)) : undefined;
	const plan = recorded.known ? recorded.plan : planFromTranscript(tail, results, steps, status === "done", plannedEnd);
	const planIncomplete = plan?.source === "plan" && plan.status === "active";
	let taskStatus: TaskProgress["status"] = status;
	if (plan?.status === "cancelled" || plan?.status === "failed") taskStatus = plan.status;
	else if (!isStreaming && !cancelled && status !== "failed" && (plan?.awaitingConfirmation || planIncomplete)) taskStatus = "waiting";
	if (!steps.length && !plan && !planFailed) return null;
	const title = (!plan?.awaitingConfirmation && plan?.title) || taskTitle(messages, userIndex, steps);
	const endedAt = status === "running" ? undefined : Math.max(user.timestamp ?? 0, turnEndedAt ?? 0, ...tail.map((message) => message.timestamp ?? 0), ...steps.map((step) => step.endedAt ?? 0));
	return { id: `task:${plan?.origin ?? user.id}`, conversationId, sourceMessageId: user.id, title, status: taskStatus, startedAt: user.timestamp ?? 0, ...(endedAt ? { endedAt } : {}), completed: steps.filter((step) => step.status === "done").length, steps, ...(plan ? { plan } : {}) };
}
