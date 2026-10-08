import { expect, test } from "vitest";
import { wikiProperties } from "../../web/src/wiki-properties.js";

test("opening properties accept Chinese colons and Markdown hard breaks with exact source ranges", () => {
	const raw = "protocol_id：v1\\\r\n准备日期：2026-10-08\\\r\n状态：**草稿**";
	const source = `---\r\ntitle: Test\r\n---\r\n\r\n# Test\r\n\r\n${raw}\r\n\r\n## Body\r\n\r\nexample: body`;
	const result = wikiProperties(source);
	expect(result.rows).toEqual([{ key: "protocol_id", value: "v1" }, { key: "准备日期", value: "2026-10-08" }, { key: "状态", value: "**草稿**" }]);
	expect(result.ranges.map(range => source.slice(range.start, range.end))).toEqual([raw]);
});
test("ordinary prose, fenced examples and properties later in the body remain content", () => {
	for (const source of ["# Title\n\nNote: ordinary prose", "# Title\n\nSome text.\n\na: 1\nb: 2", "# Title\n\n```yaml\na: 1\nb: 2\n```", "# Title\n\nNote: one line\ncontinued prose"]) expect(wikiProperties(source).rows).toEqual([]);
});
test("separate opening property paragraphs stop before prose", () => {
	expect(wikiProperties("# Title\n\na: 1\n\nb: 2\n\nBody.\n\nc: 3").rows).toEqual([{ key: "a", value: "1" }, { key: "b", value: "2" }]);
});
