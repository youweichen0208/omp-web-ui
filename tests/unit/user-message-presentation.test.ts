import { expect, test } from "vitest";
import { preserveUserTree } from "../../web/src/user-message-presentation.js";

test("pasted tree lines become a fixed-width block with line breaks", () => {
	expect(preserveUserTree("Campaign\n├── Batch\n│  └── Forecast\n\nNext"))
		.toBe("```text\nCampaign\n├── Batch\n│  └── Forecast\n```\n\nNext");
});

test("existing fenced code stays untouched", () => {
	const text = "```text\n└── Batch\n```";
	expect(preserveUserTree(text)).toBe(text);
});

test("pasted box-rule tables become a single scrollable code block", () => {
	const rule = "─".repeat(80);
	expect(preserveUserTree(`Intro\n\n位置 │ 问题 │ 修改建议\n${rule}\ndocs/a.md:23 │ 错误 │ 修改\n${rule}\n\nAfter`))
		.toBe(`Intro\n\n\`\`\`ascii-table\n位置 │ 问题 │ 修改建议\n${rule}\ndocs/a.md:23 │ 错误 │ 修改\n${rule}\n\`\`\`\n\nAfter`);
});

test("plain user file paths become local links without changing code", () => {
	expect(preserveUserTree("Read docs/a.md:23 and `docs/b.md:4`"))
		.toBe("Read [docs/a.md:23](#pi-file=docs%2Fa.md:23) and `docs/b.md:4`");
});
