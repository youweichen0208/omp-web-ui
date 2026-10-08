import { expect, test } from "vitest";
import { latestToolTextFailure, unexecutedToolText } from "../../web/src/tool-text.js";

const call = '<invoke name="edit"> <parameter name="path">fixture.py</parameter> <parameter name="edits">[{"oldText":"default","newText":"multi"}]</parameter> </invoke>';
test("identifies the reported complete tool instruction without interpreting or executing arguments", () => {
	expect(unexecutedToolText(`让我写扩展。\n\n${call}`)).toEqual({ before: "让我写扩展。", raw: call, tools: ["edit"] });
});
test("supports DSML wrappers and multiple calls", () => {
	const raw = `<｜DSML｜tool_calls>${call}${call.replaceAll('invoke', '｜DSML｜invoke').replaceAll('parameter', '｜DSML｜parameter')}</｜DSML｜tool_calls>`;
	expect(unexecutedToolText(raw)?.tools).toEqual(["edit"]);
	expect(unexecutedToolText(raw)?.raw).toBe(raw);
});
test("code examples, incomplete calls and explanatory prose are not failures", () => {
	for (const text of [`\`\`\`xml\n${call}\n\`\`\``, `\`${call}\``, `${call}\n这是格式示例。`, '<invoke name="edit">', '普通回复', '<invoke name="edit"></invoke>']) expect(unexecutedToolText(text)).toBeNull();
});

test("recovery belongs only to the latest settled failed user turn", () => {
	const user = { id: "user", role: "user" as const, content: [{ type: "text" as const, text: "edit config" }] };
	const failed = { id: "failed", role: "assistant" as const, content: [{ type: "text" as const, text: call }] };
	expect(latestToolTextFailure([user, failed])).toEqual({ user, message: failed });
	expect(latestToolTextFailure([user, failed], true)).toBeNull();
	expect(latestToolTextFailure([user, failed, { ...user, id: "next" }])).toBeNull();
	expect(latestToolTextFailure([user, failed, { ...failed, id: "answer", content: [{ type: "text", text: "done" }] }])).toBeNull();
	expect(latestToolTextFailure([failed])).toBeNull();
	expect(latestToolTextFailure([user, { ...failed, content: [...failed.content, { type: "toolCall", id: "tool", name: "edit", argumentsText: "{}" }] }])).toBeNull();
});
