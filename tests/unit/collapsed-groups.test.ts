import { describe, expect, it } from "vitest";
import { buildCollapsedGroups, collapsedPreview } from "../../web/src/collapsed-groups.js";

it("collapsed previews remove Markdown delimiters and omit folded model content", () => {
	expect(collapsedPreview("你选了 **1：平台研究工具**，开始写 `tools.py`。")).toBe("你选了 1：平台研究工具，开始写 tools.py。");
	expect(collapsedPreview("附加内容</think>\n**现在开始实现**")).toBe("现在开始实现");
	expect(collapsedPreview("附加内容</think>")).toBe("");
	expect(collapsedPreview("读取 agent_runtime.py 和 [说明](https://example.com)")).toBe("读取 agent_runtime.py 和 说明");
});
import type { UiMessage } from "../../server/protocol.js";

function msg(id: string, role: string): UiMessage {
	return { id, role, content: [] };
}

/** ids of each group, keyed by the group's head index. */
function shape(
	messages: UiMessage[],
	recentStart: number,
	expanded: string[] = [],
): Record<number, string[]> {
	const { groupAt } = buildCollapsedGroups(
		messages,
		recentStart,
		new Set(expanded),
	);
	const out: Record<number, string[]> = {};
	for (const [i, group] of groupAt) out[i] = group.map((m) => m.id);
	return out;
}

describe("buildCollapsedGroups", () => {
	it("把连续的同角色消息并成一组", () => {
		const messages = [
			msg("a1", "assistant"),
			msg("a2", "assistant"),
			msg("a3", "assistant"),
		];
		expect(shape(messages, 3)).toEqual({ 0: ["a1", "a2", "a3"] });
	});

	it("角色变了就断开——用户提问不会并进 PI 的回复", () => {
		const messages = [
			msg("u1", "user"),
			msg("a1", "assistant"),
			msg("a2", "assistant"),
			msg("u2", "user"),
		];
		expect(shape(messages, 4)).toEqual({
			0: ["u1"],
			1: ["a1", "a2"],
			3: ["u2"],
		});
	});

	it("时间间隔会切断同角色折叠组，保留分隔线", () => {
		const messages = [msg("a1", "assistant"), msg("a2", "assistant")];
		const { groupAt, absorbed } = buildCollapsedGroups(messages, 2, new Set(), new Set([1]));
		expect([...groupAt.keys()]).toEqual([0, 1]);
		expect(absorbed.has(1)).toBe(false);
	});

	it("toolResult 不渲染，也不切断它所在的那一轮", () => {
		const messages = [
			msg("a1", "assistant"),
			msg("t1", "toolResult"),
			msg("a2", "assistant"),
		];
		const { groupAt, absorbed } = buildCollapsedGroups(
			messages,
			3,
			new Set<string>(),
		);
		expect([...groupAt.keys()]).toEqual([0]);
		expect(groupAt.get(0)?.map((m) => m.id)).toEqual(["a1", "a2"]);
		// toolResult 自己被吸收掉（内容在 toolCall 卡片里）
		expect(absorbed.has(1)).toBe(true);
	});

	it("被展开的消息要单独全量渲染，因此会切断所在的组", () => {
		const messages = [
			msg("a1", "assistant"),
			msg("a2", "assistant"),
			msg("a3", "assistant"),
		];
		expect(shape(messages, 3, ["a2"])).toEqual({
			0: ["a1"],
			2: ["a3"],
		});
	});

	it("只处理 recentStart 之前的折叠区", () => {
		const messages = [
			msg("a1", "assistant"),
			msg("a2", "assistant"),
			msg("a3", "assistant"),
		];
		expect(shape(messages, 1)).toEqual({ 0: ["a1"] });
	});

	it("recentStart 为 0（没有折叠区）时什么也不产出", () => {
		expect(shape([msg("a1", "assistant")], 0)).toEqual({});
	});

	it("组里除头一条以外的成员都进 absorbed，不会重复渲染", () => {
		const messages = [
			msg("a1", "assistant"),
			msg("a2", "assistant"),
			msg("a3", "assistant"),
		];
		const { absorbed } = buildCollapsedGroups(messages, 3, new Set<string>());
		expect([...absorbed].sort()).toEqual([1, 2]);
	});

	it("recentStart 超出数组长度也不越界", () => {
		expect(shape([msg("a1", "assistant")], 99)).toEqual({ 0: ["a1"] });
	});
});
