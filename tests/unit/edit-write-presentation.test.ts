import { expect, test } from "vitest";
import type { UiMessage, UiToolCallBlock } from "../../server/protocol.js";
import { editWriteChange, parseEditDiff, retriedEditIds } from "../../web/src/edit-write-presentation.js";

const call = (id: string, name: string, args: object): UiToolCallBlock => ({ type: "toolCall", id, name, argumentsText: JSON.stringify(args) });
const result = (id: string, details?: object, isError = false): UiMessage => ({ id: `r-${id}`, role: "toolResult", toolCallId: id, isError, content: [{ type: "text", text: isError ? "Could not find exact text in file" : "Successfully replaced text" }], details });

test("edit diff has two line number columns and separate nearby changes", () => {
	const diff = " 18     def upgrade():\n 19         before()\n-20         nullable=True\n+20         nullable=False\n 21         after()\n   ...\n 41 def clean_db():\n-42     delete()\n+42     truncate()\n+43     commit()\n 43 done()";
	const hunks = parseEditDiff(diff);
	expect(hunks).toHaveLength(2);
	expect(hunks[0]).toMatchObject({ line: 20, functionName: "def upgrade():" });
	expect(hunks[0].lines.map(({ marker, oldLine, newLine }) => [marker, oldLine, newLine])).toEqual([[" ", 18, 18], [" ", 19, 19], ["-", 20, undefined], ["+", undefined, 20], [" ", 21, 21]]);
	const change = editWriteChange(call("e1", "edit", { path: "migrations/a.py", oldText: "a", newText: "b" }), result("e1", { diff, firstChangedLine: 20 }));
	expect(change).toMatchObject({ path: "migrations/a.py", added: 3, removed: 2, firstChangedLine: 20 });
});

test("multiple edits in one SDK diff segment become separate hunks", () => {
	const diff = " 10 def first():\n-11     old()\n+11     new()\n 12     a()\n 13     b()\n 14     c()\n 15     d()\n 16     e()\n 17 def second():\n-18     before()\n+18     after()\n 19     done()";
	const hunks = parseEditDiff(diff);
	expect(hunks).toHaveLength(2);
	expect(hunks.map((hunk) => hunk.line)).toEqual([11, 18]);
	expect(hunks.map((hunk) => hunk.functionName)).toEqual(["def first():", "def second():"]);
	expect(hunks[0].lines.at(-1)?.oldLine).toBe(13);
	expect(hunks[1].lines[0].oldLine).toBe(16);
});

test("write counts actual lines and failed edits preserve sought text", () => {
	expect(editWriteChange(call("w1", "write", { path: "api/main.py", content: "one\ntwo\n" }), result("w1"))).toMatchObject({ added: 2, removed: 0, empty: false });
	expect(editWriteChange(call("w2", "write", { path: "api/__init__.py", content: "" }), result("w2"))).toMatchObject({ added: 0, empty: true });
	const failed = editWriteChange(call("e1", "edit", { path: "api/main.py", oldText: "def enqueue():\n  pass", newText: "def enqueue():\n  return 1" }), result("e1", undefined, true));
	expect(failed).toMatchObject({ error: true, added: 0, removed: 0 });
	expect(failed?.hunks[0].lines.map((line) => line.text)).toEqual(["def enqueue():", "  pass"]);
});

test("a later successful edit of the same path marks only the earlier failure as retried", () => {
	const failedCall = call("e1", "edit", { path: "src/a.ts", oldText: "old" });
	const successCall = call("e2", "edit", { path: "src/a.ts", oldText: "new" });
	const otherCall = call("e3", "edit", { path: "src/b.ts", oldText: "missing" });
	const messages: UiMessage[] = [{ id: "a", role: "assistant", content: [failedCall] }, result("e1", undefined, true), { id: "b", role: "assistant", content: [otherCall, successCall] }, result("e3", undefined, true), result("e2", { diff: "-1 old\n+1 new" })];
	const results = new Map(messages.filter((message) => message.toolCallId).map((message) => [message.toolCallId!, message]));
	expect([...retriedEditIds(messages, results)]).toEqual(["e1"]);
});
