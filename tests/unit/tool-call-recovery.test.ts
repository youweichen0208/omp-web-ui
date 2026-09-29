import { expect, test } from "vitest";
import { continuationPromise, malformedToolCall, recoveryContinuation, unresolvedRecoveryTool } from "../../server/tool-call-recovery.js";
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
	for (const status of ["retrying", "resumed", "failed", "tool-error", "exhausted", "unverified", "deferred", "cancelled"]) {
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

test("recognizes the reported continuation but excludes mixed or waiting instructions", () => {
	for (const text of ["怎么卡住了 可以帮我继续吗", "继续", "请继续。", "please continue", "resume"]) {
		expect(recoveryContinuation({ role: "user", content: text }), text).toBe(true);
	}
	for (const text of ["继续，但先别执行", "请解释为什么卡住了", "可以", "1", "继续删除生产数据", "不要继续", "continue after I confirm"]) {
		expect(recoveryContinuation({ role: "user", content: text }), text).toBe(false);
	}
	const promise = "继续 A 切片。我刚才在查 Hermes 的 usage 暴露方式。让我继续核实。";
	expect(recoveryContinuation({ role: "user", content: [{ type: "text", text: "继续" }, { type: "image" }] })).toBe(false);
	expect(continuationPromise(reply(promise))).toBe(true);
	for (const text of ["请确认后让我继续核实。", "无法连接，需要等待。", "任务完成。", "请稍等，正在等待批准。", "是否让我继续核实？", "这是分析结果。", "<invoke>让我继续核实。", "`让我继续核实。`", "x".repeat(241) + "让我继续核实。"]) {
		expect(continuationPromise(reply(text)), text).toBe(false);
	}
	expect(continuationPromise(reply(promise, "aborted"))).toBe(false);
	expect(continuationPromise({ ...reply(promise), content: [{ type: "text", text: promise }, { type: "toolCall", name: "read" }] })).toBe(false);
});

test("finds unresolved calls in legacy history without crossing an unrelated instruction or real execution", () => {
	const call = reply(xml);
	const notice = (status: string) => ({ role: "custom", customType: "tool-call-recovery", details: { status, toolName: "read" } });
	const history = [call, notice("deferred"), { role: "user", content: "怎么卡住了 可以帮我继续吗" }, reply("让我继续核实。")];
	expect(unresolvedRecoveryTool(history, ["read"])).toBe("read");
	expect(unresolvedRecoveryTool(history, ["bash"])).toBeUndefined();
	for (const boundary of [
		{ role: "user", content: "暂停，只解释原因。" },
		{ role: "custom", customType: "extension-wait", content: "Wait" },
		{ role: "toolResult", content: "done" },
		reply("请确认是否继续？"),
		reply("读取完成。"),
		reply("让我继续核实。", "aborted"),
		notice("resumed"), notice("cancelled"), notice("tool-error"),
	]) expect(unresolvedRecoveryTool([...history, boundary], ["read"])).toBeUndefined();
	expect(unresolvedRecoveryTool([reply(`\`\`\`xml\n${xml}\n\`\`\``), notice("deferred")], ["read"])).toBeUndefined();
});

test("shows the actual deferral reason while preserving legacy notices", () => {
	const message = { role: "custom", customType: "tool-call-recovery", details: { status: "deferred", toolName: "read" } };
	expect(toolRecoveryKey(message)).toBe("toolRecoveryDeferred");
	expect(toolRecoveryKey({ ...message, details: { ...message.details, reason: "queued-message" } })).toBe("toolRecoveryQueued");
	expect(toolRecoveryKey({ ...message, details: { ...message.details, reason: "new-instruction" } })).toBe("toolRecoveryInterrupted");
});
