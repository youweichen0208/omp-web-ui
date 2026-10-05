import { describe, expect, test } from "vitest";
import { SessionManager, TreeSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { TreeFilterMode } from "../../server/protocol.js";
import { projectTree, toUiTree, treeRevision } from "../../server/session-tree.js";

function fixture() {
	const sm = SessionManager.inMemory("/tree-fixture");
	const u = (value: string) => sm.appendMessage({ role: "user", content: value, timestamp: Date.now() });
	const a = (value: string, stopReason: "stop" | "toolUse" | "error" = "stop") => sm.appendMessage({ role: "assistant", content: value ? [{ type: "text", text: value }] : [{ type: "toolCall", id: "call", name: "read", arguments: {} }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() });
	const root = u("root question");
	const answer = a("root answer");
	const first = u("alpha one"); a(""); sm.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "tool output" }], isError: false, timestamp: Date.now() });
	a("alpha answer");
	sm.appendCompaction("compacted alpha", first, 100);
	sm.branch(answer); const second = u("beta two"); a("", "error");
	sm.branch(answer); const third = u("gamma three"); const leaf = a("gamma answer");
	sm.appendLabelChange(first, "bookmark"); sm.appendLabelChange(second, "checkpoint");
	sm.branchWithSummary(answer, "previous branch summary");
	sm.resetLeaf(); u("other root"); a("other answer");
	sm.branch(leaf);
	return { sm, root, answer, first, second, third, leaf, u, a };
}

initTheme("light");
describe("pinned SDK tree selector contract", () => {
	for (const filter of ["default", "no-tools", "user-only", "labeled-only", "all"] as TreeFilterMode[]) {
		test(`matches CLI node order and search for ${filter}`, () => {
			const { sm } = fixture();
			for (const query of ["", "beta two", "bookmark", "branch summary"]) {
				const selector = new TreeSelectorComponent(sm.getTree(), sm.getLeafId(), 80, () => {}, () => {}, undefined, undefined, filter);
				const list = selector.getTreeList();
				for (const char of query) list.handleInput(char);
				// Navigate via public CLI methods; Page Up selects the first visible row.
				list.handleInput("\x1b[5~");
				const ids: string[] = [];
				for (let i = 0; i < 100; i++) {
					const id = list.getSelectedNode()?.entry.id;
					if (!id || ids.includes(id)) break;
					ids.push(id); list.handleInput("\x1b[B");
				}
				expect(toUiTree(sm, filter, query).nodes.map(n => n.id)).toEqual(ids);
			}
		});
	}
});
test("labels, multiple roots, visible parents, sibling leaf targets and revision", () => {
	const { sm, first, second, third, leaf } = fixture();
	const before = treeRevision(sm);
	sm.appendLabelChange(first, "updated");
	expect(treeRevision(sm)).not.toBe(before);
	expect(toUiTree(sm, "labeled-only").nodes.find(n => n.id === first)?.label).toBe("updated");
	sm.appendLabelChange(first, undefined);
	expect(toUiTree(sm, "labeled-only").nodes.map(n => n.id)).toEqual([second]);
	const tree = projectTree(sm);
	expect(tree.rootCount).toBe(2);
	expect(tree.siblings(third)).toMatchObject({ index: 3, count: 4 });
	expect(tree.siblings(second)?.nextTarget).toBe(sm.getLeafId());
	for (const node of tree.view("user-only").nodes) if (node.visibleParentId) expect(tree.view("user-only").nodes.some(n => n.id === node.visibleParentId)).toBe(true);
});
test("10,000 entries are traversed iteratively, filtered before truncating in under 200 ms", () => {
	const sm = SessionManager.inMemory("/tree-performance");
	for (let i = 0; i < 10000; i++) sm.appendMessage({ role: "user", content: `entry ${i}`, timestamp: i });
	const start = performance.now();
	const result = toUiTree(sm);
	expect(performance.now() - start).toBeLessThan(200);
	expect(result.nodes).toHaveLength(5000); expect(result.truncated).toBe(true);
	const filtered = toUiTree(sm, "user-only", "entry 9999");
	expect(filtered.nodes).toHaveLength(1); expect(filtered.truncated).toBe(false);
});
