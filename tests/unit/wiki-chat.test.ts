import { describe, expect, it } from "vitest";
import { wikiReplyParts, wikiSectionIndex, wikiHeadingTexts, wikiHasEmptySections } from "../../web/src/wiki-chat.js";

describe("Wiki reply presentation", () => {
	it("keeps prose and final questions around titled suggestions", () => {
		const parts = wikiReplyParts("Here are suggestions.\n\n- **第 5 节：关闭原则**：只由发送方关闭。\n- **Add an example** — See section 9.\n\n要我修改吗？");
		expect(parts).toEqual([
			{ kind: "text", text: "Here are suggestions.\n\n" },
			{ kind: "card", title: "第 5 节：关闭原则", text: "只由发送方关闭。", section: 5 },
			{ kind: "card", title: "Add an example", text: "See section 9.", section: 9 },
			{ kind: "text", text: "\n\n要我修改吗？" },
		]);
	});
	it("preserves ordinary lists and fenced examples", () => {
		const text = "- Plain item\n- Another item\n\n```md\n- **Not a suggestion** §3\n```";
		expect(wikiReplyParts(text)).toEqual([{ kind: "text", text }]);
	});
	it("does not invent a section target", () => {
		expect(wikiReplyParts("- **A suggestion**: No section reference.")[0]).toMatchObject({ section: null });
		expect(wikiSectionIndex(["1. Start", "5. Close"], 5)).toBe(1);
		expect(wikiSectionIndex(["1. Start", "5. Close"], 2)).toBe(-1);
		expect(wikiSectionIndex(["Start", "Close"], 2)).toBe(1);
		expect(wikiSectionIndex(["Start", "Close"], 9)).toBe(-1);
	});
	it("indexes rendered H2 headings, not code examples", () => {
		expect(wikiHeadingTexts("## First **section**\n\n```md\n## Example\n```\n\nSecond\n------")).toEqual(["First section", "Second"]);
	});
});


it("offers section completion only for empty headings outside code", () => {
	expect(wikiHasEmptySections("# Title\n\n## Empty")).toBe(true);
	expect(wikiHasEmptySections("## Empty\n\n## Full\nBody")).toBe(true);
	expect(wikiHasEmptySections("# Title\n\n## Full\nBody")).toBe(false);
	expect(wikiHasEmptySections("---\ntitle: Title\n---\n# Title\n\n## Full\nBody")).toBe(false);
	expect(wikiHasEmptySections("```md\n## Example\n```" )).toBe(false);
});
