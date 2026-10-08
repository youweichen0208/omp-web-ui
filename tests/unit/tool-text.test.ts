import { expect, test } from "vitest";
import { unexecutedToolText } from "../../web/src/tool-text.js";

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
