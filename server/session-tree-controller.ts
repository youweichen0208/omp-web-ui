import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { collectEntriesForBranchSummary, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { projectTree, treeEntryContent, treeRevision, toUiTree } from "./session-tree.js";
import type { TreeRequest, TreeResponse, UiMessage, UiTreeState } from "./protocol.js";

export interface SessionTreeHost {
	conversationId: string;
	runtime: () => AgentSessionRuntime;
	active: () => boolean;
	admitted: () => boolean;
	emit: (message: TreeResponse) => void;
	changed: () => void;
	replaced: () => Promise<void>;
	summary: (operation: { id: string } | undefined) => void;
}

/** Owns operation admission, native-file invalidation and derived message metadata.
 * The native SessionManager remains the sole owner of entries and the leaf. */
export class SessionTreeController {
	private watcher?: FSWatcher;
	private watchPath?: string;
	private fileStamp = "";
	private external = false;
	private operation = false;
	private revision = "";
	private counts = { branchPoints: 0, rootCount: 0 };
	private metadata = new Map<string, Pick<UiMessage, "entryId" | "label" | "siblings">>();
	private decorated = new WeakMap<UiMessage, { key: string; value: UiMessage }>();
	constructor(private readonly host: SessionTreeHost) {}
	get busy() { return this.operation; }
	get externallyModified() { this.checkExternal(); return this.external; }
	private get session() { return this.host.runtime().session; }
	private stamp(): string {
		try { const s = statSync(this.watchPath!); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch { return "missing"; }
	}
	bindFile(): void {
		const path = this.session.sessionFile;
		if (path === this.watchPath) return;
		this.watcher?.close(); this.watcher = undefined;
		this.watchPath = path; this.external = false; this.revision = "";
		this.fileStamp = path ? this.stamp() : "";
		if (path && existsSync(dirname(path))) {
			this.watcher = watch(dirname(path), { persistent: false }, (_event, file) => {
				if (!file || file.toString() === basename(path)) this.checkExternal();
			});
			this.watcher.on("error", () => { this.external = true; this.host.changed(); });
		}
	}
	checkExternal(): void {
		if (!this.watchPath || this.external) return;
		const stamp = this.stamp();
		if (stamp === this.fileStamp) return;
		this.fileStamp = stamp;
		try {
			const disk = readFileSync(this.watchPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
			const native = this.session.sessionManager;
			const entries = native.getEntries();
			// Native writes are synchronous. A watch callback sees the updated manager.
			if (disk[0]?.id === native.getSessionId() && disk.length === entries.length + 1 && entries.every((entry, i) => JSON.stringify(entry) === JSON.stringify(disk[i + 1]))) return;
		} catch { /* Deletion, replacement and partial external writes are all conflicts. */ }
		this.external = true;
		if (!this.session.isIdle) void this.session.abort().catch(() => {});
		this.host.changed();
	}
	assertWritable(): void {
		this.checkExternal();
		if (this.external) throw new Error("会话文件已被外部修改，请重新打开后继续。");
		if (this.operation) throw new Error("等待当前压缩或切换完成。");
	}
	refresh(): UiTreeState {
		this.bindFile();
		const sm = this.session.sessionManager;
		const revision = treeRevision(sm);
		if (revision !== this.revision) {
			const tree = projectTree(sm);
			this.counts = { branchPoints: tree.branchPoints, rootCount: tree.rootCount };
			this.metadata.clear();
			for (const entry of sm.getEntries()) this.metadata.set(entry.id, { entryId: entry.id, label: sm.getLabel(entry.id), siblings: tree.siblings(entry.id) });
			this.revision = revision;
			this.host.emit({ type: "tree_changed", conversationId: this.host.conversationId, revision, branchPoints: tree.branchPoints });
		}
		return { revision, leafId: sm.getLeafId(), ...this.counts, filterMode: this.session.settingsManager.getTreeFilterMode(), skipSummaryPrompt: this.session.settingsManager.getBranchSummarySkipPrompt(), externallyModified: this.external, busy: this.operation || this.session.isCompacting };
	}
	decorate(message: UiMessage, entryId?: string): UiMessage {
		if (!entryId) return message;
		const metadata = this.metadata.get(entryId) ?? { entryId };
		const key = JSON.stringify(metadata);
		const cached = this.decorated.get(message);
		if (cached?.key === key) return cached.value;
		const value = { ...message, ...metadata };
		this.decorated.set(message, { key, value });
		return value;
	}
	async request(request: TreeRequest, onResult?: (status: string) => void): Promise<void> {
		const context = { conversationId: this.host.conversationId, reqId: request.reqId };
		let restoredQueue: { steering: string[]; followUp: string[] } | undefined;
		let ownsOperation = false;
		const reply = (status: "ok" | "cancelled" | "aborted" | "busy" | "error", extra: { editorText?: string; error?: string } = {}) => { onResult?.(status); this.host.emit({ type: "tree_navigate_result", ...context, status, restoredQueue, ...extra }); };
		const session = this.session;
		const sm = session.sessionManager;
		try {
			if (request.conversationId !== this.host.conversationId || !this.host.active()) throw new Error("只能操作当前活动对话。");
			const validate = () => {
				if (!this.host.active() || this.session !== session) throw new Error("对话已切换，请重新操作。");
				this.checkExternal();
				if (this.external) throw new Error("会话文件已被外部修改，请重新打开后继续。");
			};
			if (request.type === "tree_get") {
				const filter = request.filter ?? session.settingsManager.getTreeFilterMode();
				if (!["default", "no-tools", "user-only", "labeled-only", "all"].includes(filter)) throw new Error("Invalid tree filter");
				const state = this.refresh();
				this.host.emit({ type: "tree", ...context, revision: state.revision, leafId: state.leafId, ...toUiTree(sm, filter, (request.query ?? "").slice(0, 1000)) }); return;
			}
			if (request.type === "tree_content") {
				const entry = sm.getEntry(request.entryId);
				if (!entry) throw new Error("Entry not found");
				this.host.emit({ type: "tree_content_result", ...context, entryId: entry.id, content: treeEntryContent(entry) }); return;
			}
			if (request.type === "tree_preview") {
				if (!sm.getEntry(request.targetId)) throw new Error("Entry not found");
				try {
					const result = collectEntriesForBranchSummary(sm, sm.getLeafId(), request.targetId);
					this.host.emit({ type: "tree_preview_result", ...context, entryCount: result.entries.length, commonAncestorId: result.commonAncestorId });
				} catch { this.host.emit({ type: "tree_preview_result", ...context }); }
				return;
			}
			if (!this.host.admitted()) throw new Error("服务正在排空，请稍后重试。");
			if (request.type === "tree_label") {
				validate();
				if (!sm.getEntry(request.entryId)) throw new Error("Entry not found");
				if (request.label !== null && (typeof request.label !== "string" || request.label.length > 200)) throw new Error("Label must be at most 200 characters");
				sm.appendLabelChange(request.entryId, request.label?.trim() || undefined); reply("ok"); return;
			}
			if (this.operation || session.isCompacting) { reply("busy"); return; }
			if (!session.isIdle && !(request.type === "tree_navigate" && request.abortRunning)) { reply("busy"); return; }
			if (request.type !== "session_reopen") validate();
			this.operation = true; ownsOperation = true; this.host.changed();
			if (request.type === "session_reopen") {
				if (!session.sessionFile) throw new Error("Session file is not available");
				const result = await this.host.runtime().switchSession(session.sessionFile);
				if (!result.cancelled) {
					this.watcher?.close(); this.watchPath = undefined; this.external = false;
					await this.host.replaced(); this.bindFile();
				}
				reply(result.cancelled ? "cancelled" : "ok"); return;
			}
			if (request.type === "tree_navigate") {
				if (!sm.getEntry(request.targetId)) throw new Error("Entry not found");
				if (!["none", "default", "custom"].includes(request.summary)) throw new Error("Invalid summary mode");
				if (!session.isIdle) {
					restoredQueue = session.clearQueue();
					await session.abort(); // SDK abort waits for idle / agent_settled, not agent_end.
					validate();
					if (!session.isIdle) { reply("busy"); return; }
				}
				validate();
				this.host.summary({ id: randomUUID() });
				const result = await session.navigateTree(request.targetId, { summarize: request.summary !== "none", customInstructions: request.summary === "custom" ? request.customInstructions?.slice(0, 16000) : undefined, replaceInstructions: request.replaceInstructions, label: request.label?.slice(0, 200) });
				reply(result.aborted ? "aborted" : result.cancelled ? "cancelled" : "ok", { editorText: result.editorText });
				return;
			}
			const entryId = request.type === "session_clone" ? sm.getLeafId() : request.entryId;
			if (!entryId || !sm.getEntry(entryId)) throw new Error("会话没有可派生的节点。");
			const position = request.type === "session_clone" ? "at" : request.position;
			if (position !== "at" && position !== "before") throw new Error("Invalid fork position");
			const result = await this.host.runtime().fork(entryId, { position });
			if (!result.cancelled) await this.host.replaced();
			reply(result.cancelled ? "cancelled" : "ok", { editorText: result.selectedText });
		} catch (error) { reply("error", { error: error instanceof Error ? error.message : String(error) }); }
		finally {
			if (ownsOperation) { this.operation = false; this.host.summary(undefined); }
			this.refresh(); this.host.changed();
		}
	}
	dispose(): void { this.watcher?.close(); this.watcher = undefined; }
}
