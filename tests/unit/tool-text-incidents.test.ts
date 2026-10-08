import { expect, test } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { toolTextIncidents, projectToolTextMessages } from "../../server/tool-text-incidents.js";
import { TOOL_TEXT_CONTINUE_PROMPT } from "../../server/tool-text.js";
import { latestToolTextFailure } from "../../web/src/tool-text.js";
const text = (id: string, text: string, role = "assistant"): UiMessage => ({ id, role, content: [{ type: "text", text }] });
const leak = '<invoke name="bash"><parameter name="command">echo test</parameter></invoke>';
const first = [text("question", "Do the work", "user"), text("leak", leak)];
const reminded = [...first, text("reminder", TOOL_TEXT_CONTINUE_PROMPT, "user")];

test("one incident spans reminder, plain failure and reload; retry belongs to the original question", () => {
	const messages = [...reminded, text("reply", "I will do that now")];
	const { current, incidents } = toolTextIncidents(messages);
	expect(incidents).toHaveLength(1);
	expect(current).toMatchObject({ state: "stopped", user: { id: "question" }, last: { id: "reply" }, reminders: [{ id: "reminder" }] });
	expect(current?.outputs.map(o => o.attempt)).toEqual([0, 1]);
	expect(toolTextIncidents(JSON.parse(JSON.stringify(messages))).current?.incidentId).toBe(current?.incidentId);
	expect(latestToolTextFailure(messages)?.user.id).toBe("question");
	expect(toolTextIncidents(messages, true).current?.state).toBe("reminding");
	expect(latestToolTextFailure(messages, true)).toBeNull();
});

test("real tools recover the incident, while a new leak stops without creating a second incident", () => {
	const tool: UiMessage = { id: "tool", role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash" }] };
	const messages = [...reminded, tool, text("done", "Finished")];
	expect(toolTextIncidents(messages).current?.state).toBe("recovered");
	expect(latestToolTextFailure(messages)).toBeNull();
	const repeated = toolTextIncidents([...messages, text("again", leak)]);
	expect(repeated.incidents).toHaveLength(1);
	expect(repeated.current?.state).toBe("stopped");
	expect(repeated.current?.last.id).toBe("again");
});

test("projection marks reminder origin and attempt without rewriting native messages or changing stable references", () => {
	const before = structuredClone(reminded);
	const projected = projectToolTextMessages(reminded);
	expect(projected[2]).toMatchObject({ origin: "auto-reminder", toolText: { attempt: 1, incidentId: toolTextIncidents(reminded).current?.incidentId } });
	expect(projectToolTextMessages(reminded)[2]).toBe(projected[2]);
	expect(reminded).toEqual(before);
	expect(projected[0]).toBe(reminded[0]);
});

test("ordinary questions, tool examples and user cancellation do not become failed incidents", () => {
	expect(toolTextIncidents([text("q", "Question", "user"), text("example", '```xml\n'+leak+'\n```')]).current).toBeUndefined();
	expect(latestToolTextFailure([...reminded, text("new", "Other question", "user")])).toBeNull();
	expect(latestToolTextFailure([...reminded, { ...text("stopped", ""), stopReason: "aborted" }])).toBeNull();
});
