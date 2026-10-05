import { stripVTControlCharacters } from "node:util";
import type { SessionEntry, SessionManager, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { TreeFilterMode, UiTreeNode, UiTreeSiblings } from "./protocol.js";

type TreeSource = Pick<SessionManager, "getTree" | "getLeafId" | "getEntryCount" | "getSessionId">;
const settingsTypes = new Set(["label", "context_edit", "custom", "model_change", "thinking_level_change", "session_info"]);

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => block && block.type === "text" && typeof block.text === "string" ? block.text : "").join("");
}

/** Matches the pinned CLI's filtering, including exclusions preceding its mode switch. */
export function treeNodeVisible(node: SessionTreeNode, leafId: string | null, filter: TreeFilterMode): boolean {
	const e = node.entry;
	if (e.type === "usage") return false;
	if (e.type === "message" && e.message.role === "assistant" && e.id !== leafId) {
		const m = e.message;
		if (!text(m.content).trim() && (!m.stopReason || m.stopReason === "stop" || m.stopReason === "toolUse")) return false;
	}
	switch (filter) {
		case "user-only": return e.type === "message" && e.message.role === "user";
		case "labeled-only": return node.label !== undefined;
		case "no-tools": return !settingsTypes.has(e.type) && !(e.type === "message" && e.message.role === "toolResult");
		case "all": return true;
		default: return !settingsTypes.has(e.type);
	}
}

/** Search intentionally follows CLI: only the first 200 content characters of messages. */
export function treeSearchText(node: SessionTreeNode): string {
	const e = node.entry;
	let body: string;
	switch (e.type) {
		case "message": body = `${e.message.role} ${"content" in e.message ? text(e.message.content).slice(0, 200) : ""} ${e.message.role === "bashExecution" ? e.message.command : ""}`; break;
		case "custom_message": body = `${e.customType} ${text(e.content).slice(0, 200)}`; break;
		case "branch_summary": body = `branch summary ${e.summary}`; break;
		case "compaction": body = "compaction"; break;
		case "model_change": body = `model ${e.modelId}`; break;
		case "thinking_level_change": body = `thinking ${e.thinkingLevel}`; break;
		case "session_info": body = `title ${e.name ?? ""}`; break;
		case "custom": body = `custom ${e.customType}`; break;
		case "context_edit": body = `context edit ${e.replacement === null ? "omit" : "replace"} ${e.targetId}`; break;
		case "label": body = `label ${e.label ?? ""}`; break;
		default: body = "";
	}
	return `${node.label ?? ""} ${body}`.toLowerCase();
}

export function treeEntryContent(e: SessionEntry): string {
	switch (e.type) {
		case "message": return e.message.role === "bashExecution" ? e.message.command : "content" in e.message ? text(e.message.content) || (e.message.role === "assistant" ? e.message.errorMessage ?? "" : "") : "";
		case "custom_message": return text(e.content);
		case "compaction": case "branch_summary": return e.summary;
		case "model_change": return `${e.provider}/${e.modelId}`;
		case "thinking_level_change": return e.thinkingLevel;
		case "session_info": return e.name ?? "";
		case "label": return e.label ?? "";
		case "custom": return e.customType;
		case "context_edit": return `${e.targetId}: ${e.replacement ? text(e.replacement.content) : "omit"}`;
		case "usage": return e.kind;
	}
}
function kind(e: SessionEntry): UiTreeNode["kind"] {
	if (e.type === "message") return e.message.role === "user" ? "user" : e.message.role === "assistant" ? "assistant" : e.message.role === "toolResult" ? "tool" : "custom";
	switch (e.type) {
		case "compaction": return "compaction";
		case "branch_summary": return "branchSummary";
		case "context_edit": return "contextEdit";
		case "model_change": return "model";
		case "thinking_level_change": return "thinking";
		case "label": return "label";
		case "session_info": case "usage": return "info";
		default: return "custom";
	}
}

/** No persisted tree cache: derive a bounded view and linear-time navigation index. */
export function projectTree(sm: TreeSource) {
	const roots = sm.getTree();
	const leafId = sm.getLeafId();
	const flat: SessionTreeNode[] = [];
	const byId = new Map<string, SessionTreeNode>();
	const stack = [...roots].reverse();
	while (stack.length) {
		const node = stack.pop()!;
		if (byId.has(node.entry.id)) continue;
		flat.push(node); byId.set(node.entry.id, node);
		for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
	}
	const active = new Set<string>();
	for (let id = leafId; id && !active.has(id); id = byId.get(id)?.entry.parentId ?? null) active.add(id);
	const orderedFlat: SessionTreeNode[] = [];
	const order = (nodes: SessionTreeNode[]) => [...nodes].sort((a, b) => Number(active.has(b.entry.id)) - Number(active.has(a.entry.id)));
	const orderedStack = order(roots).reverse();
	while (orderedStack.length) {
		const node = orderedStack.pop()!; orderedFlat.push(node);
		const children = order(node.children);
		for (let i = children.length - 1; i >= 0; i--) orderedStack.push(children[i]);
	}
	const latest = new Map<string, SessionTreeNode>();
	for (let i = flat.length - 1; i >= 0; i--) {
		const node = flat[i];
		let best = node;
		for (const child of node.children) {
			const candidate = latest.get(child.entry.id) ?? child;
			if (best === node || candidate.entry.timestamp >= best.entry.timestamp) best = candidate;
		}
		latest.set(node.entry.id, best);
	}
	const branchPoints = flat.filter(n => n.children.length > 1).length;
	const siblingMap = new Map<string, UiTreeSiblings>();
	for (const group of [roots, ...flat.map(n => n.children)]) {
		const peers = group.filter(n => treeNodeVisible(n, leafId, "default"));
		if (peers.length < 2) continue;
		peers.forEach((node, i) => siblingMap.set(node.entry.id, { index: i + 1, count: peers.length, prevTarget: i > 0 ? latest.get(peers[i - 1].entry.id)?.entry.id : undefined, nextTarget: i + 1 < peers.length ? latest.get(peers[i + 1].entry.id)?.entry.id : undefined }));
	}
	const siblings = (entryId: string) => siblingMap.get(entryId);
	function view(filter: TreeFilterMode = "default", query = "", limit = 5000) {
		const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
		const visible = new Map<string, { id: string | null; depth: number; root: string }>();
		const nodes: UiTreeNode[] = [];
		let truncated = false;
		for (const node of orderedFlat) {
			const e = node.entry;
			const parent = e.parentId ? visible.get(e.parentId) : undefined;
			const rootId = parent?.root ?? e.id;
			if (!treeNodeVisible(node, leafId, filter) || !tokens.every(token => treeSearchText(node).includes(token))) {
				visible.set(e.id, { id: parent?.id ?? null, depth: parent?.depth ?? -1, root: rootId }); continue;
			}
			const depth = (parent?.depth ?? -1) + 1;
			visible.set(e.id, { id: e.id, depth, root: rootId });
			if (nodes.length >= limit) { truncated = true; continue; }
			const m = e.type === "message" ? e.message : undefined;
			nodes.push({ id: e.id, parentId: e.parentId, visibleParentId: parent?.id ?? null, depth, rootId, kind: kind(e), preview: stripVTControlCharacters(treeEntryContent(e)).replace(/\s+/g, " ").slice(0, 120), timestamp: Date.parse(e.timestamp), label: node.label, onActivePath: active.has(e.id), isLeaf: e.id === leafId, childCount: node.children.length, toolName: m?.role === "toolResult" ? m.toolName : undefined, model: m?.role === "assistant" ? m.model : e.type === "model_change" ? e.modelId : undefined, stopReason: m?.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted") ? m.stopReason : undefined, summaryFromId: e.type === "branch_summary" ? e.fromId : undefined });
		}
		const childCounts = new Map<string | null, number>();
		for (const n of nodes) childCounts.set(n.visibleParentId, (childCounts.get(n.visibleParentId) ?? 0) + 1);
		const layout = new Map<string, { indent: number; justBranched: boolean }>();
		const multipleRoots = (childCounts.get(null) ?? 0) > 1;
		for (const n of nodes) {
			const parent = n.visibleParentId ? layout.get(n.visibleParentId) : undefined;
			const justBranched = (childCounts.get(n.visibleParentId) ?? 0) > 1;
			const indent = parent
				? parent.indent + (justBranched || (parent.justBranched && parent.indent > 0) ? 1 : 0)
				: multipleRoots ? 1 : 0;
			layout.set(n.id, { indent, justBranched });
			n.depth = multipleRoots ? Math.max(0, indent - 1) : indent;
		}
		return { nodes, truncated };
	}
	return { branchPoints, rootCount: roots.length, leafId, siblings, view };
}
export function treeRevision(sm: TreeSource): string {
	// Every label change appends an entry, including clears and replacements.
	return `${sm.getSessionId()}:${sm.getEntryCount()}:${sm.getLeafId() ?? "root"}`;
}
export function toUiTree(sm: TreeSource, filter: TreeFilterMode = "default", query = "") { return projectTree(sm).view(filter, query); }
export function siblingInfo(sm: TreeSource, entryId: string) { return projectTree(sm).siblings(entryId); }
