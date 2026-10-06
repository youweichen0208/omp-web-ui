import { ToolOutputDownload } from "./ToolOutputDownload";
import { getClientId } from "../use-chat";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiGitBranch, FiX, FiChevronRight, FiChevronDown, FiTag, FiCopy, FiArchive } from "react-icons/fi";
import type { ClientMessage, TreeFilterMode, TreeRequest, TreeResponse, UiState, UiTreeNode } from "../types";
import { useT } from "../i18n";
import { randomUuid } from "../uuid";

type Navigate = { targetId: string; summary: "none" | "default" | "custom"; customInstructions: string; abortRunning: boolean };
export function SessionTreeWorkbench({ state, connected, send }: { state: UiState | null; connected: boolean; send: (message: ClientMessage) => boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<"tree" | "fork">("tree");
	const [filter, setFilter] = useState<TreeFilterMode>("default");
	const [query, setQuery] = useState("");
	const [nodes, setNodes] = useState<UiTreeNode[]>([]);
	const [truncated, setTruncated] = useState(false);
	const [folded, setFolded] = useState(new Set<string>());
	const [selected, setSelected] = useState<string>();
	const [navigate, setNavigate] = useState<Navigate>();
	const [preview, setPreview] = useState<number>();
	const [label, setLabel] = useState<{ id: string; value: string }>();
	const [content, setContent] = useState<{ id: string; text: string; toolCallId?: string }>();
	const [error, setError] = useState("");
	const [waiting, setWaiting] = useState(false);
	const [loading, setLoading] = useState(false);
	const stateRef = useRef(state); stateRef.current = state;
	const requests = useRef(new Map<string, { type: TreeRequest["type"]; targetId?: string; copy?: boolean }>());
	const getId = useRef("");
	const previewId = useRef("");
	const mutationId = useRef("");
	const request = useCallback((message: TreeRequest, copy = false) => {
		if (!["tree_get", "tree_preview", "tree_content"].includes(message.type)) mutationId.current = message.reqId;
		requests.current.set(message.reqId, { type: message.type, targetId: "targetId" in message ? message.targetId : "entryId" in message ? message.entryId : undefined, copy });
		if (!send(message)) { requests.current.delete(message.reqId); setError(t("treeDisconnected")); setWaiting(false); setLoading(false); }
	}, [send, t]);
	const getTree = useCallback(() => {
		if (!state?.conversationId || !connected || !open) return;
		const reqId = randomUuid(); getId.current = reqId; setLoading(true);
		request({ type: "tree_get", conversationId: state.conversationId, reqId, filter: mode === "fork" ? "user-only" : filter, query });
	}, [state?.conversationId, connected, open, filter, query, mode, request]);
	useEffect(() => { const timer = setTimeout(getTree, 120); return () => clearTimeout(timer); }, [getTree, state?.tree?.revision]);
	useEffect(() => {
		requests.current.clear(); setNodes([]); setSelected(undefined); setNavigate(undefined); setLabel(undefined); setContent(undefined); setError(""); setWaiting(false); setFolded(new Set());
		setFilter(stateRef.current?.tree?.filterMode ?? "default");
	}, [state?.conversationId]);
	useEffect(() => { if (!connected) { requests.current.clear(); setWaiting(false); setLoading(false); } }, [connected]);
	const execute = useCallback((intent: Navigate) => {
		const current = stateRef.current;
		if (!current) return;
		setWaiting(true); setError("");
		request({ type: "tree_navigate", conversationId: current.conversationId, reqId: randomUuid(), ...intent });
	}, [request]);
	const choose = useCallback((targetId: string, quick = false) => {
		const current = stateRef.current;
		if (!current || current.tree?.verifying || current.tree?.externallyModified) return;
		const intent: Navigate = { targetId, summary: "none", customInstructions: "", abortRunning: false };
		if ((quick || current.tree?.skipSummaryPrompt) && !current.isStreaming) { execute(intent); return; }
		setNavigate(intent); setPreview(undefined); setError("");
		const reqId = randomUuid(); previewId.current = reqId;
		request({ type: "tree_preview", conversationId: current.conversationId, reqId, targetId });
	}, [request, execute]);
	useEffect(() => {
		const toggle = () => { setMode("tree"); setOpen(value => !value); };
		const keyboard = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "t") { event.preventDefault(); toggle(); }
		};
		const quick = (event: Event) => {
			const detail = (event as CustomEvent<{ conversationId: string; targetId: string }>).detail;
			if (stateRef.current?.conversationId === detail.conversationId) choose(detail.targetId, true);
		};
		window.addEventListener("pi-tree-open", toggle); window.addEventListener("keydown", keyboard); window.addEventListener("pi-tree-navigate", quick);
		return () => { window.removeEventListener("pi-tree-open", toggle); window.removeEventListener("keydown", keyboard); window.removeEventListener("pi-tree-navigate", quick); };
	}, [choose]);
	useEffect(() => {
		const receive = (event: Event) => {
			const message = (event as CustomEvent<TreeResponse>).detail;
			if (message.conversationId !== stateRef.current?.conversationId) return;
			if (message.type === "tree_open") { setMode(message.mode); setOpen(true); return; }
			if (message.type === "tree_changed") { getTree(); return; }
			const action = requests.current.get(message.reqId);
			requests.current.delete(message.reqId);
			if (action?.type === "tree_get" && message.reqId !== getId.current) return;
			if (action?.type === "tree_preview" && message.reqId !== previewId.current) return;
			if (!action && !message.reqId.startsWith("command-")) return;
			if (message.type === "tree" && message.reqId === getId.current) { setNodes(message.nodes); setTruncated(message.truncated); setLoading(false); }
			if (message.type === "tree_preview_result" && message.reqId === previewId.current) setPreview(message.entryCount);
			if (message.type === "tree_content_result") {
				if (action?.copy) void navigator.clipboard.writeText(message.content).catch(() => setContent({ id: message.entryId, text: message.content, toolCallId: message.toolCallId }));
				else setContent({ id: message.entryId, text: message.content, toolCallId: message.toolCallId });
			}
			if (message.type === "tree_navigate_result") {
				const isMutation = message.reqId === mutationId.current;
				if (isMutation) setWaiting(false);
				if (message.reqId === getId.current) setLoading(false);
				if (message.status === "ok") {
					if (action?.type === "tree_navigate") { setSelected(action.targetId); setNavigate(undefined); }
					if (action?.type === "tree_label") setLabel(undefined);
					getTree();
				}
				else setError(message.error ?? t(message.status === "busy" ? "treeBusy" : message.status === "cancelled" ? "treeCancelled" : message.status === "aborted" ? "treeAborted" : "treeFailed"));
			}
		};
		window.addEventListener("pi-tree-response", receive);
		return () => window.removeEventListener("pi-tree-response", receive);
	}, [getTree, t]);
	const visible = useMemo(() => {
		const hidden = new Set<string>();
		return nodes.filter(node => {
			if (node.visibleParentId && (folded.has(node.visibleParentId) || hidden.has(node.visibleParentId))) { hidden.add(node.id); return false; }
			return true;
		});
	}, [nodes, folded]);
	const mutate = (message: TreeRequest) => { setWaiting(true); setError(""); request(message); };
	const disabled = !connected || waiting || state?.tree?.busy || state?.tree?.verifying || state?.tree?.externallyModified;
	const context = () => ({ conversationId: state?.conversationId ?? "", reqId: randomUuid() });
	return <>
		{open && <aside className="session-tree-panel" aria-label={t("treeTitle")}>
			<header><FiGitBranch /><h2>{t(mode === "fork" ? "treeFork" : "treeTitle")}</h2><button onClick={() => setOpen(false)} aria-label={t("close")}><FiX /></button></header>
			<div className="session-tree-controls"><select aria-label={t("treeFilter")} value={mode === "fork" ? "user-only" : filter} disabled={mode === "fork"} onChange={e => setFilter(e.target.value as TreeFilterMode)}>{(["default", "no-tools", "user-only", "labeled-only", "all"] as const).map(value => <option key={value} value={value}>{t(`treeFilter_${value}`)}</option>)}</select><input aria-label={t("treeSearch")} placeholder={t("treeSearch")} value={query} onChange={e => setQuery(e.target.value)} /></div>
			{state?.tree?.verifying && <div role="status">{t("treeVerifying")}</div>}
			{state?.tree?.externallyModified && <div className="tree-warning" role="alert"><p>{t("treeExternal")}</p><button disabled={!connected || waiting || state.isStreaming} onClick={() => mutate({ type: "session_reopen", ...context() })}>{t("treeReopen")}</button></div>}
			{error && <p role="alert" className="tree-warning">{error}</p>}
			{truncated && <p className="tree-warning">{t("treeTruncated")}</p>}
			<div className="session-tree-list" aria-busy={loading}>
				{!nodes.length && <p className="tree-empty">{t(loading ? "loadingSession" : "treeEmpty")}</p>}
				{visible.map((node, index) => <section key={node.id} className={`tree-node${node.onActivePath ? " active-path" : ""}${node.id === selected ? " selected" : ""}${index === 0 || visible[index - 1].rootId !== node.rootId ? " root-start" : ""}`} style={{ paddingLeft: `${12 + Math.min(node.depth, 18) * 12}px` }} data-entry-id={node.id}>
					<span className="tree-connector" aria-hidden="true" style={{ width: `${Math.min(node.depth, 18) * 12}px` }} />
					<div className="tree-node-heading"><button className="tree-fold" disabled={!node.childCount} aria-expanded={!folded.has(node.id)} aria-label={t("treeFold")} onClick={() => setFolded(previous => { const next = new Set(previous); next.has(node.id) ? next.delete(node.id) : next.add(node.id); return next; })}>{node.childCount ? folded.has(node.id) ? <FiChevronRight /> : <FiChevronDown /> : <span>{node.isLeaf ? "●" : "·"}</span>}</button><button className="tree-node-preview" onClick={() => request({ type: "tree_content", ...context(), entryId: node.id })}><small>{node.kind === "compaction" ? <FiArchive /> : node.kind === "branchSummary" ? <FiGitBranch /> : null}{node.isLeaf ? "● " : ""}{t(`treeKind_${node.kind}`)}{node.childCount > 1 ? ` · ${node.childCount}` : ""}</small><span>{node.preview || "…"}</span></button>{node.label && <span className="tree-label"><FiTag />{node.label}</span>}</div>
					<div className="tree-node-actions"><button disabled={disabled} onClick={() => mode === "fork" ? mutate({ type: "session_fork", ...context(), entryId: node.id, position: "before" }) : choose(node.id)}>{t(mode === "fork" ? "treeFork" : "treeNavigate")}</button><button disabled={disabled || state?.isStreaming} onClick={() => mutate({ type: "session_fork", ...context(), entryId: node.id, position: "at" })}><FiGitBranch />{t("treeForkAt")}</button><button disabled={disabled} onClick={() => setLabel({ id: node.id, value: node.label ?? "" })}><FiTag />{t("treeLabel")}</button><button disabled={!connected} onClick={() => request({ type: "tree_content", ...context(), entryId: node.id }, true)} aria-label={t("copy")}><FiCopy /></button></div>
				</section>)}
			</div>
			<footer><span>{nodes.length} · {t("treeNodes")}</span><button disabled={disabled || state?.isStreaming} onClick={() => mutate({ type: "session_clone", ...context() })}><FiArchive />{t("treeClone")}</button></footer>
		</aside>}
		{!open && error && <div className="tree-floating-error" role="alert">{error}<button onClick={() => setError("")} aria-label={t("close")}><FiX /></button></div>}
		{navigate && !waiting && <div className="tree-modal-backdrop"><section className="tree-dialog" role="dialog" aria-modal="true" aria-label={t("treeNavigate")}><h3>{t("treeNavigate")}</h3>{preview !== undefined && <p>{t("treePreviewCount", { n: preview })}</p>}{(["none", "default", "custom"] as const).map(value => <label key={value}><input type="radio" name="tree-summary" value={value} checked={navigate.summary === value} disabled={waiting} onChange={() => setNavigate({ ...navigate, summary: value })} />{t(`treeSummary_${value}`)}</label>)}{navigate.summary === "custom" && <textarea aria-label={t("treeInstructions")} placeholder={t("treeInstructions")} value={navigate.customInstructions} onChange={e => setNavigate({ ...navigate, customInstructions: e.target.value })} />}{state?.isStreaming && <label><input type="checkbox" checked={navigate.abortRunning} onChange={e => setNavigate({ ...navigate, abortRunning: e.target.checked })} />{t("treeStopConfirm")}</label>}{error && <p role="alert">{error}</p>}<div className="tree-dialog-actions"><button disabled={waiting} onClick={() => setNavigate(undefined)}>{t("cancel")}</button><button className="primary" disabled={disabled || (!!state?.isStreaming && !navigate.abortRunning)} onClick={() => execute(navigate)}>{t("treeNavigate")}</button></div></section></div>}
		{label && <div className="tree-modal-backdrop"><form className="tree-dialog" role="dialog" aria-modal="true" aria-label={t("treeLabel")} onSubmit={event => { event.preventDefault(); mutate({ type: "tree_label", ...context(), entryId: label.id, label: label.value.trim() || null }); }}><h3>{t("treeLabel")}</h3><input autoFocus maxLength={200} aria-label={t("treeLabel")} value={label.value} onChange={e => setLabel({ ...label, value: e.target.value })} /><p>{t("treeLabelClear")}</p>{error && <p role="alert">{error}</p>}<div className="tree-dialog-actions"><button type="button" onClick={() => setLabel(undefined)}>{t("cancel")}</button><button className="primary" disabled={waiting || !connected || state?.tree?.verifying || state?.tree?.externallyModified}>{t("save")}</button></div></form></div>}
		{content && <div className="tree-modal-backdrop"><section className="tree-dialog tree-content-dialog" role="dialog" aria-modal="true" aria-label={t("treeContent")}><h3>{t("treeContent")}</h3><pre>{content.text}</pre>{content.toolCallId && state && <ToolOutputDownload url={`/api/tool-output?${new URLSearchParams({ clientId: getClientId(), conversationId: state.conversationId, toolCallId: content.toolCallId })}`} />}<button onClick={() => setContent(undefined)}>{t("close")}</button></section></div>}
	</>;
}
