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
