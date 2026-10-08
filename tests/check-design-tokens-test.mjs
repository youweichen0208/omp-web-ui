import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { checkCss, checkTsx, sourceFiles } from "../scripts/check-design-tokens.mjs";

const errors = issues => issues.filter(issue => issue.severity === "error");

test("reports literal colors in nested rules, fallbacks and mixed selector lists", () => {
	const issues = checkCss(`/* #abcdef is a comment */
@media (width > 600px) {
	.card { color: var(--missing, #123ABC); }
}
:root[data-appearance="dark"] .card { background: #fff; }
.fp-markdown .hljs-keyword, .card { color: #abcdef; }
:root { color: #123; }
`);
	assert.deepEqual(errors(issues).map(issue => issue.line), [3, 5, 6, 7]);
});

test("keeps palette exceptions narrow and ignores selector IDs and quoted comments", () => {
	assert.deepEqual(errors(checkCss(`
:root { --accent: #123456; --term-magenta: #c084fc; }
:root[data-appearance="dark"] { --accent: #abcdef; }
#abcdef { color: var(--accent); }
.fp-highlight-purple { --highlight-color: #e5d5ff; }
.fp-embedded[data-code-theme="dark"] { --file-code-keyword: #8ab9dd; }
.fp-markdown .hljs-keyword { color: #2f6f9e; }
.desktop-window-controls .desktop-window-close:hover { background: #dc3545; }
`)), []);
	assert.equal(errors(checkCss('.fp-highlight-purple { color: #123; }')).length, 1);
	assert.equal(errors(checkCss('.card { --file-code-bg: #123; }')).length, 1);
});

test("detects purple OKLCH including alpha and hue units without flagging neutral colors", () => {
	assert.equal(errors(checkCss('.card { color: oklch(60% 0.2 280 / .5); background: oklch(.6 .1 .8turn); border-color: oklch(.6 .1 300deg); }')).length, 3);
	assert.deepEqual(errors(checkCss('.card { color: oklch(.6 0 280); background: oklch(.97 .003 80); }')), []);
});

test("rejects fixed CSS and TSX radii while allowing documented tokens and inheritance", () => {
	assert.deepEqual(checkCss('.card { border-radius: var(--r-sm) 0 / 50%; }'), []);
	assert.deepEqual(checkCss('.card { border-radius: inherit; } .switch { border-radius: var(--r-switch); } .waiting-brand i { border-radius: var(--r-waiting); }'), []);
	const issues = checkCss('.card { border-radius: 9px; border-top-left-radius: 4px; }');
	assert.equal(issues.length, 2);
	assert(issues.every(issue => issue.severity === "error"));
	assert.equal(checkTsx('const style = { borderRadius: 7, borderTopLeftRadius: "var(--r-sm)" };').length, 1);
});

test("detects RGB/HSL and color names in CSS without flagging variables, content or URLs", () => {
	assert.equal(errors(checkCss('.card { color: WHITE; background: linear-gradient(red, hsl(120 20% 40%)); border: 1px solid rgba(0,0,0,.5); outline-color: var(--accent, rebeccapurple); }')).length, 5);
	assert.deepEqual(checkCss('.card { color: var(--red); background: transparent; fill: currentColor; font-family: "Black", serif; content: "white rgb(0,0,0) #fff"; background-image: url("/red.svg"); }'), []);
});

test("detects script style values and SVG attributes while ignoring prose and identifiers", () => {
	assert.equal(errors(checkTsx('const style = { color: "white", backgroundColor: "rgb(1 2 3)", borderColor: "hsl(20 30% 40%)" };', 'style.ts')).length, 3);
	assert.equal(errors(checkTsx('const view = <svg fill={"white"} stroke={ok ? "red" : "blue"} />;')).length, 3);
	assert.equal(errors(checkTsx('el.style["color"] = "white"; el.style.setProperty("color", "red"); const COLOR = "blue";', 'style.ts')).length, 3);
	assert.deepEqual(checkTsx('const label = "white"; const type = "red"; const className = "blue"; const text = "Turn the white button red";'), []);
});

test("content colors exempt only the named palette and JPEG matte declarations", () => {
	assert.deepEqual(checkTsx('export const TEXT_HIGHLIGHT_COLORS = [{ name: "red", hex: "#f00", rgb: "rgb(255,0,0)" }];', 'web/src/remark-text-highlight.ts'), []);
	assert.equal(errors(checkTsx('const style = {color: "red"};', 'web/src/remark-text-highlight.ts')).length, 1);
	assert.deepEqual(checkTsx('const JPEG_MATTE_COLOR = "#ffffff";', 'web/src/image-paste.ts'), []);
	assert.equal(errors(checkTsx('const JPEG_MATTE_COLOR = "#ff0000";', 'web/src/image-paste.ts')).length, 1);
	assert.equal(errors(checkTsx('const JPEG_MATTE_COLOR = "#ffffff";', 'other.ts')).length, 1);
});

test("discovers every CSS, TS and TSX source recursively", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-design-check-"));
	try {
		mkdirSync(join(dir, "nested"));
		for (const file of ["styles.css", "theme.ts", "nested/card.css", "nested/card.tsx", "nested/data.json"]) writeFileSync(join(dir, file), "");
		assert.deepEqual(sourceFiles(dir).map(file => relative(dir, file).replaceAll("\\", "/")).sort(), ["nested/card.css", "nested/card.tsx", "styles.css", "theme.ts"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TSX scans strings and templates but skips comments and HTML entities", () => {
	const source = '// #abcdef\nconst view = <div style={{color: "#ABCDEF"}} title="&#8203;" />;\nconst keyframes = [{ backgroundColor: `#1234` }];';
	assert.deepEqual(errors(checkTsx(source)).map(issue => issue.line), [2, 3]);
	assert.deepEqual(checkTsx('const style = { color: "var(--accent)", borderRadius: 0 };'), []);
});
