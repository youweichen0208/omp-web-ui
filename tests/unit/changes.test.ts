import { expect, test } from "vitest";
import { changedWords, foldDiff, parseUnifiedDiff } from "../../web/src/changes.js";

test("patch parser distinguishes source header text, renames and binary files", () => {
	const files = parseUnifiedDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -4,2 +4,2 @@\n--- source\n+++ source\n keep\ndiff --git a/old.md b/new.md\nsimilarity index 100%\nrename from old.md\nrename to new.md\ndiff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n');
	expect(files).toHaveLength(3);
	expect(files[0]).toMatchObject({ path: "a.ts", added: 1, removed: 1, lines: [{ marker: "-", oldLine: 4, text: "-- source" }, { marker: "+", newLine: 4, text: "++ source" }, { marker: " ", oldLine: 5, newLine: 5, text: "keep" }] });
	expect(files[1]).toMatchObject({ oldPath: "old.md", path: "new.md" });
	expect(files[2].binary).toBe(true);
});

test("quoted paths and deletions keep the real path", () => {
	const [file] = parseUnifiedDiff('diff --git "a/a\\tb.md" "b/a\\tb.md"\n--- "a/a\\tb.md"\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n');
	expect(file.path).toBe("a\tb.md"); expect(file.removed).toBe(1);
});

test("context folding retains three lines on both sides and is lossless", () => {
	const lines = Array.from({ length: 30 }, (_, n) => ({ marker: n === 0 || n === 29 ? "+" as const : " " as const, text: String(n) }));
	const rows = foldDiff(lines);
	expect(rows.find(row => row.kind === "gap")).toEqual({ kind: "gap", start: 4, end: 26 });
	expect(rows.flatMap(row => row.kind === "line" ? [row.index] : Array.from({ length: row.end - row.start }, (_, n) => row.start + n))).toEqual(lines.map((_, n) => n));
});

test("word highlight preserves shared prefix and suffix, including Unicode", () => {
	expect(changedWords("const 名称 = newer;", "const 名称 = older;")).toEqual([{ text: "const 名称 = ", changed: false }, { text: "newer", changed: true }, { text: ";", changed: false }]);
});

test("word diff leaves shared interior words unhighlighted", () => {
	const parts = changedWords("old + stable + before", "new + stable + after");
	expect(parts).toEqual([{ text: "old", changed: true }, { text: " + stable + ", changed: false }, { text: "before", changed: true }]);
});

test("completed turns keep separate summaries and automatic reminders stay in their turn", async () => {
	const { turnChangeSummaries } = await import("../../web/src/changes.js");
	const messages: import("../../server/protocol.js").UiMessage[] = [
		{ id: "u1", role: "user", content: [{ type: "text", text: "first" }] },
		{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", argumentsText: '{"path":"a.ts","oldText":"before","newText":"after"}' }] },
		{ id: "r1", role: "toolResult", toolCallId: "t1", content: [] },
		{ id: "reminder", role: "user", origin: "auto-reminder", content: [] },
		{ id: "done1", role: "assistant", content: [{ type: "text", text: "done" }] },
		{ id: "u2", role: "user", content: [{ type: "text", text: "second" }] },
		{ id: "a2", role: "assistant", content: [{ type: "toolCall", id: "t2", name: "edit", argumentsText: '{"path":"b.ts","oldText":"before","newText":"after"}' }] },
		{ id: "r2", role: "toolResult", toolCallId: "t2", isError: true, content: [] },
	];
	const summaries = turnChangeSummaries(messages, null, "/repo", true);
	expect([...summaries.keys()]).toEqual(["done1"]);
	expect(summaries.get("done1")?.[0]).toMatchObject({ path: "a.ts", added: 1, removed: 1, unlocated: true });
	expect([...turnChangeSummaries(messages, null, "/repo", false).keys()]).toEqual(["done1"]);
});
