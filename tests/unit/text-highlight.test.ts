import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { remarkTextHighlight, TEXT_HIGHLIGHT_COLORS } from "../../web/src/remark-text-highlight.js";

const render = (source: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkTextHighlight], children: source }));
describe("text highlights", () => {
	it("renders each saved palette color, including an entire highlighted paragraph", () => {
		for (const { hex } of TEXT_HIGHLIGHT_COLORS) {
			const source = `<mark style="background-color: ${hex}">**重点** and [link](https://example.com)</mark>`;
			expect(render(source)).toContain(`background-color:${hex}`);
			expect(render(source)).toContain("<strong>重点</strong>");
		}
	});
	it("leaves arbitrary HTML, attributes, unsupported colors and unmatched marks inert", () => {
		for (const source of [
			'<mark style="background-color: #fff3a3" onclick="alert(1)">text</mark>',
			'<mark style="background-color: #123456">text</mark>',
			'<mark style="background-color: #fff3a3">unfinished',
			'<script>alert(1)</script>',
		]) {
			expect(render(source)).not.toContain('<span style=');
			expect(render(source)).not.toContain('<script>');
		}
	});
	it("keeps marker syntax literal inside code fences", () => {
		expect(render('```html\n<mark style="background-color: #fff3a3">text</mark>\n```')).not.toContain('<span style=');
	});
});
