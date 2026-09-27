import type { TaskProgress, TaskStep, UiMessage, UiToolCallBlock } from "./protocol.js";

const short = (text: string, limit: number) => {
	const first = text.trim().replace(/\s+/g, " ").split(/[。！？\n]/)[0]?.trim() ?? "";
	return first.length > limit ? `${first.slice(0, limit)}…` : first;
};

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

/** P0: infer the current task from the server's serialized transcript. The
 * transcript remains authoritative; no browser heuristic decides completion. */
export function deriveTaskProgress(conversationId: string, messages: UiMessage[], streamingMessage: UiMessage | null, isStreaming: boolean): TaskProgress | null {
	const userIndex = messages.findLastIndex((message) => message.role === "user" && message.content.some((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string"));
	if (userIndex < 0) return null;
	const user = messages[userIndex];
	const userText = user.content.map((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join(" ");
	const title = short(userText, 56) || "当前任务";
	const tail = [...messages.slice(userIndex + 1), ...(streamingMessage?.role === "assistant" ? [streamingMessage] : [])];
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
			steps.push({ id: `${message.id}:${group++}`, messageId: message.id, title: short(narrative, 40) || defaultTitle(calls), ...(narrative.trim() ? { detail: narrative.trim() } : {}), status, startedAt: message.timestamp ?? user.timestamp ?? 0, ...(status !== "running" ? { endedAt } : {}), hint: status === "running" ? `${completed}/${calls.length} 项完成` : failed ? "有工具执行失败" : `${calls.length} 项完成`, artifacts: calls.map(artifact) });
			calls = [];
			narrative = "";
		};
		for (const part of message.content) {
			if (part.type === "toolCall" && typeof (part as UiToolCallBlock).id === "string") calls.push(part as UiToolCallBlock);
			else if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") { flush(); narrative = (part as { text: string }).text; }
		}
		flush();
		if (group === 0 && narrative.trim()) steps.push({ id: `${message.id}:text`, messageId: message.id, title: short(narrative, 40), detail: narrative.trim(), status: message === streamingMessage ? "running" : "done", startedAt: message.timestamp ?? user.timestamp ?? 0, artifacts: [] });
	}
	if (isStreaming && !steps.some((step) => step.status === "running")) {
		const previous = [...tail].reverse().find((message) => message.role === "assistant");
		steps.push({ id: `${user.id}:pending`, messageId: previous?.id ?? user.id, title: "正在分析请求", status: "running", startedAt: previous?.timestamp ?? user.timestamp ?? 0, artifacts: [] });
	}
	if (!steps.length) return null;
	const cancelled = tail.some((message) => message.role === "assistant" && message.stopReason === "aborted");
	const status: TaskProgress["status"] = cancelled ? "cancelled" : isStreaming ? "running" : steps.some((step) => step.status === "failed") ? "failed" : "done";
	return { id: `task:${user.id}`, conversationId, sourceMessageId: user.id, title, status, startedAt: user.timestamp ?? 0, completed: steps.filter((step) => step.status === "done").length, steps };
}
