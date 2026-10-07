import { describe, expect, it } from "vitest";
import { parseSkillBlock, skillAwarePreview, queuedMessagePreview } from "../../web/src/skill-block.js";

const BODY = `---
name: demo
---
技能正文第一行
第二行`;

describe("parseSkillBlock", () => {
	it("解析标准 <skill> 块（镜像 SDK 正则，勿单独改动）", () => {
		const text =
			`<skill name="demo" location="/tmp/demo/SKILL.md">\n${BODY}\n</skill>\n\n帮我做 X`;
		const b = parseSkillBlock(text);
		expect(b).not.toBeNull();
		expect(b!.name).toBe("demo");
		expect(b!.location).toBe("/tmp/demo/SKILL.md");
		expect(b!.content).toBe(BODY);
		expect(b!.userMessage).toBe("帮我做 X");
	});

	it("无 userMessage 时为 undefined", () => {
		const text = `<skill name="a" location="/l">\nbody\n</skill>`;
		const b = parseSkillBlock(text);
		expect(b!.userMessage).toBeUndefined();
	});

	it("非 skill 文本返回 null", () => {
		expect(parseSkillBlock("普通消息")).toBeNull();
	});
});

describe("skillAwarePreview", () => {
	it("skill 块折叠成 skill:name · args", () => {
		const text =
			`<skill name="demo" location="/tmp/demo/SKILL.md">\n${BODY}\n</skill>\n\n帮我做 X`;
		expect(skillAwarePreview(text)).toBe("skill:demo · 帮我做 X");
	});

	it("无 args 的 skill 块只留 skill:name", () => {
		const text = `<skill name="a" location="/l">\nbody\n</skill>`;
		expect(skillAwarePreview(text)).toBe("skill:a");
	});

	it("非 skill 文本原样返回（折叠空白）", () => {
		expect(skillAwarePreview("  hello   world  \n")).toBe("hello world");
	});
});


describe("queuedMessagePreview", () => {
	it("summarizes full skills and old truncated queue snapshots without exposing the body", () => {
		const body = '<skill name="ops" location="/tmp/SKILL.md">\n' + 'instructions\n'.repeat(300) + '</skill>\n\n检查状态';
		expect(queuedMessagePreview(body)).toBe('skill:ops · 检查状态');
		expect(queuedMessagePreview(body.slice(0, 2000) + '…')).toBe('skill:ops');
		expect(queuedMessagePreview('普通问题\n保留换行')).toBe('普通问题\n保留换行');
	});
});
