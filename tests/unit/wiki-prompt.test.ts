import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { wikiPrompt } from "../../web/src/wiki-document.js";

// Exercise the real localized message text without loading React in the server test project.
const translations = readFileSync(new URL("../../web/src/i18n.tsx", import.meta.url), "utf8");
function compose(locale: string, input: string, allowCode = false, selected = "") {
	const label = (key: string) => {
		const values = [...translations.matchAll(new RegExp(`\\t${key}: (".*"),`, "g"))];
		return JSON.parse(values[locale === "zh" ? 0 : 1][1]) as string;
	};
	return wikiPrompt(input, "go/error.md", selected, ["go/index.md"], "", [], false, allowCode, {
		scope: label("wikiScope"), selection: label("wikiSelected"), documentsOnly: label("wikiDocumentsOnlyPrompt"), skip: label("wikiSkipPrompt"),
	});
}

describe("Wiki request intent", () => {
	for (const locale of ["zh", "en"]) {
		it(`keeps greetings from becoming document edit requests (${locale})`, () => {
			for (const allowCode of [false, true]) {
				const text = compose(locale, "hello", allowCode);
				expect(text.startsWith("hello\n\n")).toBe(true);
				expect(text).toContain('"go/error.md"');
				expect(text).not.toMatch(/请直接保存修改|Save changes directly\.|请只修改此范围内的文档|Edit documents in this scope only\./);
				expect(text).toMatch(/仅作为上下文|context only/);
			}
			const edit = compose(locale, "请改写选中的段落", false, "原文段落");
			expect(edit).toContain("请改写选中的段落");
			expect(edit).toContain("原文段落");
			expect(edit).toContain('"go/index.md"');
		});
	}
});
