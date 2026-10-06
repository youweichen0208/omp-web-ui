import type { TreeResponse } from "./types";
export function emitTreeResponse(message: TreeResponse) {
	window.dispatchEvent(new CustomEvent<TreeResponse>("pi-tree-response", { detail: message }));
}
export function openSessionTree() { window.dispatchEvent(new Event("pi-tree-open")); }
export function navigateSibling(conversationId: string, targetId: string) {
	window.dispatchEvent(new CustomEvent("pi-tree-navigate", { detail: { conversationId, targetId } }));
}
export type TreeDraft = { id: string; conversationId: string; text: string; images?: { data: string; mimeType: string }[] };
const drafts = new Map<string, TreeDraft[]>();
const received = new Set<string>();
export function queueTreeDraft(draft: TreeDraft) {
	if ((!draft.text && !draft.images?.length) || received.has(draft.id)) return;
	received.add(draft.id);
	if (received.size > 256) received.delete(received.values().next().value!);
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
