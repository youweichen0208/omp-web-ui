import type { UiMessage } from "./protocol.js";
import { isToolTextContinuation, unexecutedToolText } from "./tool-text.js";

export interface ToolTextIncident {
	incidentId: string;
	user: UiMessage;
	first: UiMessage;
	last: UiMessage;
	reminders: UiMessage[];
	leaks: UiMessage[];
	outputs: { message: UiMessage; raw: string; attempt: number }[];
	state: "reminding" | "stopped" | "recovered";
}
const analyzed = new WeakMap<UiMessage, { text: string; leak: ReturnType<typeof unexecutedToolText> }>();
function analyze(message: UiMessage) {
	const cached = analyzed.get(message);
	if (cached) return cached;
	const text = message.content.map(b => b.type === "text" ? b.text : "").join("\n");
	const value = { text, leak: unexecutedToolText(text) };
	analyzed.set(message, value); return value;
}

/** Replay native history without modifying it. IDs survive reload and branch replay. */
export function toolTextIncidents(messages: readonly UiMessage[], streaming = false) {
	const incidents: ToolTextIncident[] = [];
	let user: UiMessage | undefined, current: ToolTextIncident | undefined;
	let sinceReminderTool = false;
	for (const [index, message] of messages.entries()) {
		if (message.role === "user") {
			if (current && isToolTextContinuation(messages, index)) {
				current.reminders.push(message);
				current.state = "reminding";
				sinceReminderTool = false;
			} else { user = message; current = undefined; sinceReminderTool = false; }
			continue;
		}
		if (message.role !== "assistant" || !user) continue;
		const hasTool = message.content.some(b => b.type === "toolCall");
		if (hasTool) {
			if (current) current.state = "recovered";
			sinceReminderTool = true;
			continue;
		}
		const { text, leak } = analyze(message);
		const stoppedByUser = message.stopReason === "aborted" || message.stopReason === "error";
		if (leak && !stoppedByUser && !current) {
			current = { incidentId: `tool-text:${user.entryId ?? user.id}:${message.entryId ?? message.id}`, user, first: message, last: message, reminders: [], leaks: [], outputs: [], state: "stopped" };
			incidents.push(current);
		}
		if (!current) continue;
		if (!leak && !current.reminders.length) current.state = "recovered";
		if (leak) current.leaks.push(message);
		if (leak || current.reminders.length && !sinceReminderTool) {
			current.last = message;
			current.outputs.push({ message, raw: current.reminders.length ? text : leak?.raw ?? text, attempt: current.reminders.length });
			current.state = stoppedByUser ? "recovered" : "stopped";
		}
	}
	if (current && current.state !== "recovered") current.state = streaming ? "reminding" : "stopped";
	return { incidents, current };
}

const projected = new WeakMap<UiMessage, { key: string; message: UiMessage }>();
/** Optional wire metadata; cached objects preserve append-only snapshot identity. */
export function projectToolTextMessages(messages: UiMessage[]): UiMessage[] {
	const metadata = new Map<string, { origin?: "auto-reminder"; toolText: NonNullable<UiMessage["toolText"]> }>();
	for (const incident of toolTextIncidents(messages).incidents) {
		for (const output of incident.outputs) metadata.set(output.message.id, { toolText: { incidentId: incident.incidentId, attempt: output.attempt } });
		incident.reminders.forEach((message, index) => metadata.set(message.id, { origin: "auto-reminder", toolText: { incidentId: incident.incidentId, attempt: index + 1 } }));
	}
	return messages.map(message => {
		const fields = metadata.get(message.id);
		if (!fields) return message;
		const key = JSON.stringify(fields), cached = projected.get(message);
		if (cached?.key === key) return cached.message;
		const value = { ...message, ...fields }; projected.set(message, { key, message: value }); return value;
	});
}
