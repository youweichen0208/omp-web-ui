import type { TreeResponse } from "./types";
export function emitTreeResponse(message: TreeResponse) {
	window.dispatchEvent(new CustomEvent<TreeResponse>("pi-tree-response", { detail: message }));
}
export function openSessionTree() { window.dispatchEvent(new Event("pi-tree-open")); }
export function navigateSibling(conversationId: string, targetId: string) {
	window.dispatchEvent(new CustomEvent("pi-tree-navigate", { detail: { conversationId, targetId } }));
}
export type TreeDraft = { id: string; conversationId: string; text: string };
const drafts = new Map<string, TreeDraft[]>();
export function queueTreeDraft(draft: TreeDraft) {
	if (!draft.text) return;
	const pending = drafts.get(draft.conversationId) ?? [];
	if (!pending.some(item => item.id === draft.id)) pending.push(draft);
	drafts.set(draft.conversationId, pending);
	window.dispatchEvent(new Event("pi-tree-draft"));
}
export function peekTreeDraft(conversationId: string) { return drafts.get(conversationId)?.[0]; }
export function consumeTreeDraft(conversationId: string, id: string) {
	const pending = drafts.get(conversationId);
	if (pending?.[0]?.id === id) pending.shift();
	if (!pending?.length) drafts.delete(conversationId);
	window.dispatchEvent(new Event("pi-tree-draft"));
}
