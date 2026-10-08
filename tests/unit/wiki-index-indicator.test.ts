import { expect, test } from "vitest";
import { wikiIndexIssueGroups } from "../../web/src/wiki-index-summary.js";

test("mixed index limits retain separate counts instead of inheriting the first cause", () => {
	const groups = wikiIndexIssueGroups([
		{ path: "blocked", reason: "unreadable", subtree: true },
		{ path: "large.md", reason: "file-size" },
		{ path: "later.md", reason: "byte-budget" },
		{ path: "last.md", reason: "byte-budget" },
	]);
	expect(groups).toEqual([
		{ reason: "byte-budget", count: 2 },
		{ reason: "unreadable", count: 1 },
		{ reason: "file-size", count: 1 },
	]);
	expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(4);
});
test("empty and single-cause statuses keep their exact counts", () => {
	expect(wikiIndexIssueGroups([])).toEqual([]);
	expect(wikiIndexIssueGroups([{ path: "a", reason: "unreadable" }, { path: "b", reason: "unreadable" }])).toEqual([{ reason: "unreadable", count: 2 }]);
});
