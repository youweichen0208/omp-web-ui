import { expect, test } from "vitest";
import { malformedToolCall } from "../../server/tool-call-recovery.js";
import { toolRecoveryKey } from "../../web/src/tool-call-recovery.js";
const xml = '<invoke name="read">\n<parameter name="path">runtime.py</parameter>\n</invoke>';
const reply = (text: string, stopReason = "stop") => ({ role: "assistant", stopReason, content: [{ type: "text", text }] });
test("detects the stopped XML invocation from the reported reply", () => {
	expect(malformedToolCall(reply(`现在读取文件。\n\n${xml}`), ["read"])).toBe("read");
});
test("does not run indented Markdown examples", () => {
	for (const prefix of ["    ", "\t"]) {
		expect(malformedToolCall(reply(xml.split("\n").map((line) => prefix + line).join("\n")), ["read"])).toBeUndefined();
	}
});
test("preserves fences, quotes and code delimiters around examples", () => {
	for (const text of [
		`\`\`\`\`xml\n\`\`\`\n${xml}`,
		`~~~xml\n${xml}`,
		`\`\`\`\`xml\n${xml}\n\`\`\``,
		`> Example:\n${xml}`,
		`- Example:\n${xml}`,
		`\`\`some code\n${xml}`,
		`${xml}\n\`\`\`text\nexplanation\n\`\`\``,
		`    <invoke name="read"><parameter name="path">runtime.py</parameter></invoke>`,
	]) expect(malformedToolCall(reply(text), ["read"]), text).toBeUndefined();
	expect(malformedToolCall(reply(`\`\`\`text\nold code\n\`\`\`\n\n${xml}`), ["read"])).toBe("read");
});
test("localizes persisted recovery notices without showing model instructions", () => {
	for (const status of ["retrying", "resumed", "failed", "unverified", "deferred", "cancelled"]) {
		expect(toolRecoveryKey({ role: "custom", customType: "tool-call-recovery", details: { status, toolName: "read" } })).toMatch(/^toolRecovery/);
	}
	for (const details of [null, {}, { status: "toString" }, { status: "unknown" }, { status: 1 }]) {
		expect(toolRecoveryKey({ role: "custom", customType: "tool-call-recovery", details })).toBeUndefined();
	}
	expect(toolRecoveryKey({ role: "custom", customType: "another-extension", details: { status: "retrying" } })).toBeUndefined();
});
test("does not recover examples, partial tags, real calls, errors or user stops", () => {
	for (const text of [`\`\`\`xml\n${xml}\n\`\`\``, `\`${xml}\``, xml.split("\n").map((line) => `> ${line}`).join("\n"), xml.replace("</invoke>", ""), `${xml}\n这是文档示例。`, "实现完成，请确认下一步。"])
		expect(malformedToolCall(reply(text), ["read"])).toBeUndefined();
	for (const reason of ["aborted", "error", "length", "toolUse"]) expect(malformedToolCall(reply(xml, reason), ["read"])).toBeUndefined();
	expect(malformedToolCall(reply(xml), ["write"])).toBeUndefined();
	expect(malformedToolCall({ ...reply(xml), content: [...reply(xml).content, { type: "toolCall", name: "read" }] }, ["read"])).toBeUndefined();
});
