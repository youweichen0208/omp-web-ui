import { describe, expect, it, vi } from "vitest";
import { WebUIContext } from "../../server/webui-context.js";
import type { ServerMessage } from "../../server/protocol.js";

function fixture(id = "A") {
	const wire: ServerMessage[] = [];
	const ui = new WebUIContext(m => wire.push(m), id, `project/${id}`);
	const dialogs = () => wire.filter((m): m is Extract<ServerMessage, { type: "dialog" }> => m.type === "dialog");
	return { ui, wire, dialogs };
}
describe("conversation UI lifecycle", () => {
	it("isolates keys, rejects wrong response types, repeated and old IDs", async () => {
		const a = fixture(), b = fixture("B");
		a.ui.setStatus("same", "A"); b.ui.setStatus("same", "B");
		a.ui.setWidget("same", ["A"]); b.ui.setWidget("same", ["B"]);
		expect(a.ui.snapshot()[0].lines).toEqual(["A"]);
		expect(b.ui.statusSnapshot()[0].text).toBe("B");
		const pending = a.ui.confirm("Permission", "Run?");
		const id = a.dialogs()[0].id;
		b.ui.resolveDialog(id, true); a.ui.resolveDialog(id, "true");
		const replay: ServerMessage[] = []; a.ui.replayDialogs(m => replay.push(m)); expect(replay).toHaveLength(1);
		a.ui.resolveDialog(id, false); a.ui.resolveDialog(id, true);
		await expect(pending).resolves.toBe(false);
		expect(a.wire.filter(m => m.type === "dialog_closed")).toHaveLength(1);
		a.ui.dispose(); const count = a.wire.length;
		a.ui.notify("late"); a.ui.setWidget("late", ["late"]); a.ui.setEditorText("late"); a.ui.setStatus("late", "late");
		expect(a.wire).toHaveLength(count); expect(a.ui.snapshot()).toEqual([]);
		await expect(a.ui.input("late")).resolves.toBeUndefined();
	});
	it("handles timeout, pre-abort and response/abort races exactly once", async () => {
		vi.useFakeTimers();
		try {
			const { ui, wire, dialogs } = fixture();
			const signal = AbortSignal.abort();
			await expect(ui.confirm("cancel", "", { signal })).resolves.toBe(false);
			await expect(ui.select("cancel", [], { signal })).resolves.toBeUndefined();
			expect(wire).toHaveLength(0);
			const timeout = ui.input("timeout", "", { timeout: 5 });
			await vi.advanceTimersByTimeAsync(5); await expect(timeout).resolves.toBeUndefined();
			const controller = new AbortController();
			const raced = ui.confirm("race", "", { signal: controller.signal, timeout: 20 });
			ui.resolveDialog(dialogs().at(-1)!.id, true); controller.abort(); await vi.advanceTimersByTimeAsync(20);
			await expect(raced).resolves.toBe(true);
			expect(wire.filter(m => m.type === "dialog_closed")).toHaveLength(2);
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});
	it("supports multiline editor and immediate custom fallback; disposes replaced widgets", async () => {
		const { ui, dialogs, wire } = fixture();
		await expect(ui.custom(() => {})).resolves.toBeUndefined();
		const result = ui.editor("Edit", "first\nsecond");
		expect(dialogs()[0].args).toEqual(["first\nsecond"]);
		ui.resolveDialog(dialogs()[0].id, "a\nb"); await expect(result).resolves.toBe("a\nb");
		ui.pasteToEditor("replace"); expect(wire.at(-1)).toMatchObject({ type: "extension_editor", conversationId: "A", text: "replace" });
		const dispose = vi.fn(); ui.setWidget("w", () => ({ render: () => ["text"], invalidate: () => {}, dispose })); ui.setWidget("w", undefined); expect(dispose).toHaveBeenCalledOnce();
		const pending = ui.select("Dispose", ["yes"]); ui.dispose(); await expect(pending).resolves.toBeUndefined();
		const replay: ServerMessage[] = []; ui.replayDialogs(m => replay.push(m)); expect(replay).toEqual([]);
	});
});
