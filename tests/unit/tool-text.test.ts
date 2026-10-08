import { expect, test } from "vitest";
import { TOOL_TEXT_CONTINUE_PROMPT, latestToolTextFailure, unexecutedToolText } from "../../web/src/tool-text.js";

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
	expect(latestToolTextFailure([user, failed])).toEqual({ user, message: failed, kind: "text" });
	expect(latestToolTextFailure([user, failed], true)).toBeNull();
	expect(latestToolTextFailure([user, failed, { ...user, id: "next" }])).toBeNull();
	expect(latestToolTextFailure([user, failed, { ...failed, id: "answer", content: [{ type: "text", text: "done" }] }])).toBeNull();
	expect(latestToolTextFailure([failed])).toBeNull();
	expect(latestToolTextFailure([user, { ...failed, content: [...failed.content, { type: "toolCall", id: "tool", name: "edit", argumentsText: "{}" }] }])).toBeNull();
});

test("recognises the call from its tail when the opening tag is not in the visible text", () => {
	// Field case: leaked reasoning, then only the parameters and </invoke>.
	const fragment = '<parameter name="command">cd /repo && grep -rn "x" a.py 2>/dev/null | head -30</parameter> </invoke>';
	expect(unexecutedToolText(`先验证改动。</think>\n${fragment}`)).toEqual({ before: "先验证改动。</think>", raw: fragment, tools: [] });
	// An unclosed ``` earlier masks the opening tag; the tail still identifies it and keeps the tool name.
	const opened = `说明：\n\`\`\`\n草稿\n<invoke name="bash">\n${fragment}`;
	expect(unexecutedToolText(opened)?.tools).toEqual(["bash"]);
	expect(unexecutedToolText(opened)?.raw.startsWith('<invoke name="bash">')).toBe(true);
	// function_calls wrapper is accepted as well.
	expect(unexecutedToolText(`<function_calls><invoke name="bash">${fragment}</function_calls>`)?.tools).toEqual(["bash"]);
});

test("the tail fallback still ignores closed code, inline code and calls followed by prose", () => {
	const fragment = '<parameter name="command">ls</parameter></invoke>';
	for (const text of [`\`\`\`xml\n${fragment}\n\`\`\``, `\`${fragment}\``, `${fragment}\n然后我会看结果。`, "</parameter></invoke>", '<parameter name="command">ls</parameter>']) {
		expect(unexecutedToolText(text), text).toBeNull();
	}
});

test("after the automatic request, a reply without any tool call is reported as stopped", () => {
	const nudge = { id: "nudge", role: "user" as const, content: [{ type: "text" as const, text: TOOL_TEXT_CONTINUE_PROMPT }] };
	const announce = { id: "announce", role: "assistant" as const, content: [{ type: "text" as const, text: "你说得对。让我通过真正的工具调用创建验证脚本文件。" }] };
	expect(latestToolTextFailure([nudge, announce])).toEqual({ user: nudge, message: announce, kind: "stopped" });
	expect(latestToolTextFailure([nudge, announce], true)).toBeNull();
	// The model did act after the request: a later plain answer is a normal ending.
	const acted = { id: "acted", role: "assistant" as const, content: [{ type: "toolCall" as const, id: "t", name: "write", argumentsText: "{}" }] };
	expect(latestToolTextFailure([nudge, acted, { ...announce, id: "done", content: [{ type: "text" as const, text: "完成。" }] }])).toBeNull();
	// The same plain reply to an ordinary user message is never a failure.
	expect(latestToolTextFailure([{ ...nudge, content: [{ type: "text" as const, text: "继续" }] }, announce])).toBeNull();
	// A text-written call after the request keeps the "text" kind.
	const call = '<invoke name="bash"><parameter name="command">ls</parameter></invoke>';
	expect(latestToolTextFailure([nudge, { ...announce, content: [{ type: "text" as const, text: call }] }])?.kind).toBe("text");
});
