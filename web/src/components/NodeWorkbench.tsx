import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { randomUuid } from "../uuid";
import { useT } from "../i18n";
import { RemoteTerminal } from "./node-terminal";

import type { NodeProfile, NodeSource,   ClientMessage, ServerMessage } from "../types";

type Event = Extract<ServerMessage, { type: "node_event" }>;
type Node = NodeProfile;
type Tab = { id: string; conversationId: string; busy: boolean; closed?: boolean; output?: string };

const draftNode = (): Partial<Node> => ({ name: "", group: "默认", host: "", port: 22, username: "root", auth: "password", defaultDir: "/" });

export function NodeWorkbench({ send, active }: { send: (msg: ClientMessage) => boolean; active: boolean }) {
	const t = useT();
	const [sources, setSources] = useState<NodeSource[]>([]);
	const [detected, setDetected] = useState<Partial<NodeSource>[]>([]);
	const [sourceView, setSourceView] = useState(false);
	const [detectedDone, setDetectedDone] = useState(false);
	const [sourceDraft, setSourceDraft] = useState<{ kind: "xshell" | "ssh"; path: string } | null>(null);
	const [search, setSearch] = useState("");
	const [workspace, setWorkspace] = useState(false);
	const [showFiles, setShowFiles] = useState(false);

	const [credentialAuth, setCredentialAuth] = useState<"password" | "key">("password");
	const [credentialKeyPath, setCredentialKeyPath] = useState("");
	const [credential, setCredential] = useState<string | null>(null);
	const [persistSecret, setPersistSecret] = useState(true);
	const [sameGroup, setSameGroup] = useState(false);
	const [testing, setTesting] = useState(false);
	const credentialAttempt = useRef<{ nodeId: string; payload: Record<string, unknown> } | null>(null);
	const opening = useRef(new Set<string>());
	const awaitingTrust = useRef(new Set<string>());
	const [notice, setNotice] = useState("");
	const [nodes, setNodes] = useState<Node[]>([]);
	const [timings, setTimings] = useState<Record<string, { connectedAt?: number; latencyMs?: number }>>({});
	const [now, setNow] = useState(Date.now());
	const [connections, setConnections] = useState<Record<string, string>>({});
	const [tabs, setTabs] = useState<Record<string, Tab[]>>({});
	const [selected, setSelected] = useState<string>(localStorage.getItem("pi-node-selected") ?? "");
	const [activeTabs, setActiveTabs] = useState<Record<string, string>>({});

	const [draft, setDraft] = useState<Partial<Node> | null>(null);
	const [secret, setSecret] = useState("");
	const [error, setError] = useState("");

	const [path, setPath] = useState("/");
	const [listings, setListings] = useState<Record<string, { path: string; entries: { name: string; type: string }[] }>>({});
	const [file, setFile] = useState<{ nodeId: string; path: string; text: string } | null>(null);
	const terminalHistory = useRef(new Map<string, string>());
	const latestList = useRef(new Map<string, string>());
	const latestRead = useRef(new Map<string, string>());
	const pendingWrite = useRef<string | null>(null);
	const request = useCallback((action: string, nodeId?: string, payload?: Record<string, unknown>, terminalId?: string, conversationId?: string) => {
		const requestId = randomUuid();
		return send({ type: "node_request", requestId, action, nodeId, terminalId, conversationId, payload }) ? requestId : null;
	}, [send]);
	useEffect(() => { if (!active || !workspace) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active, workspace]);
	const node = nodes.find((n) => n.id === selected);
	const currentTabs = tabs[selected] ?? [];
	const activeTab = currentTabs.find((t) => t.id === activeTabs[selected]) ?? currentTabs.at(-1);

	const credentialNode = nodes.find((n) => n.id === credential);
	const source = sources.find((s) => s.id === node?.sourceId);
	const entries = listings[selected]?.path === path ? listings[selected].entries : [];

	useEffect(() => { if (active) { request("state"); request("source_detect"); } }, [active, request]);

	useEffect(() => { if (node) setPath(node.defaultDir); }, [selected, node?.defaultDir]);
	useEffect(() => {
		const listener = (e: globalThis.Event) => {
			const msg = (e as CustomEvent<Event>).detail;
			const id = msg.nodeId ?? "";

			if (msg.event === "state") {
				const list = (msg.data?.nodes ?? []) as Node[];
				setNodes(list);
				setTimings(Object.fromEntries(((msg.data?.connections ?? []) as { nodeId: string; connectedAt?: number; latencyMs?: number }[]).map((c) => [c.nodeId, c])));
				setSources((msg.data?.sources ?? []) as NodeSource[]);

				setConnections(Object.fromEntries(((msg.data?.connections ?? []) as { nodeId: string; status: string }[]).map((c) => [c.nodeId, c.status])));
				for (const c of (msg.data?.connections ?? []) as { nodeId: string; terminals: Tab[] }[]) for (const tab of c.terminals) terminalHistory.current.set(`${c.nodeId}:${tab.id}`, tab.output ?? "");
				setTabs((before) => {
					const next = { ...before };
					for (const c of (msg.data?.connections ?? []) as { nodeId: string; terminals: Tab[] }[]) {
						const previous = (before[c.nodeId] ?? []).filter((tab) => !c.terminals.some((current) => current.id === tab.id)).map((tab) => ({ ...tab, closed: true }));
						next[c.nodeId] = [...previous, ...c.terminals];
					}
					for (const key of Object.keys(next)) if (!((msg.data?.connections ?? []) as { nodeId: string }[]).some((c) => c.nodeId === key)) next[key] = next[key].map((t) => ({ ...t, closed: true }));
					for (const key of Object.keys(next)) if (!list.some((n) => n.id === key)) delete next[key];
					return next;
				});
				return;
			}
			if (msg.event === "terminal_output") {
				const key = `${id}:${msg.terminalId}`;
				terminalHistory.current.set(key, ((terminalHistory.current.get(key) ?? "") + String(msg.data?.text ?? "")).slice(-65536));
				return;
			}
			if (msg.event === "trust_required") {
				if (msg.requestId) awaitingTrust.current.add(msg.requestId);
				if (window.confirm(t("nodeTrust", { name: String(msg.data?.name ?? ""), host: String(msg.data?.host ?? ""), fingerprint: String(msg.data?.fingerprint ?? "") }))) {
					const attempt = credentialAttempt.current;
					if (attempt?.nodeId === id) request("credential_test", id, { ...attempt.payload, fingerprint: msg.data?.fingerprint });
					else request("trust", id, { fingerprint: msg.data?.fingerprint });
				} else { opening.current.delete(id); credentialAttempt.current = null; setTesting(false); }
				return;
			}

			if (msg.event === "failure") { if (msg.requestId === pendingWrite.current) pendingWrite.current = null; const text = String(msg.data?.message ?? "");
				if (!(msg.requestId && awaitingTrust.current.delete(msg.requestId))) { setError(text); setTesting(false); if (msg.data?.action === "credential_test") credentialAttempt.current = null; opening.current.delete(id); }
				return; }

			if (msg.event === "terminal_busy") { setTabs((all) => ({ ...all, [id]: (all[id] ?? []).map((t) => t.id === msg.terminalId ? { ...t, busy: Boolean(msg.data?.busy) } : t) })); return; }
			if (msg.event === "terminal_exit") { const key = `${id}:${msg.terminalId}`; terminalHistory.current.set(key, (terminalHistory.current.get(key) ?? "") + "\r\n[SSH 已断开]\r\n"); setTabs((all) => ({ ...all, [id]: (all[id] ?? []).map((t) => t.id === msg.terminalId ? { ...t, closed: true } : t) })); return; }
			if (msg.event !== "result") return;
			const action = msg.data?.action;
			if (action === "source_detect") { setDetected((msg.data?.sources ?? []) as Partial<NodeSource>[]); setDetectedDone(true); }
			if (action === "source_add") { setSourceDraft(null); setSourceView(false); }
			if (action === "credential_test") { credentialAttempt.current = null; setTesting(false); setCredential(null); setSecret(""); setNotice(t("nodeCredentialsSaved", { n: Number(msg.data?.count ?? 1) })); }
			if ((action === "connect" || action === "trust" || action === "credential_test") && opening.current.has(id)) { opening.current.delete(id); request("terminal_open", id, {}, randomUuid()); setWorkspace(true); }
			if (action === "terminal_open") { const t: Tab = { id: String(msg.data?.terminalId), conversationId: String(msg.data?.conversationId), busy: false }; setTabs((all) => ({ ...all, [id]: (all[id] ?? []).some((x) => x.id === t.id) ? all[id] : [...(all[id] ?? []), t] })); setActiveTabs((all) => ({ ...all, [id]: t.id })); }
			if (action === "list" && msg.requestId === latestList.current.get(id)) setListings((all) => ({ ...all, [id]: { path: String(msg.data?.path ?? ""), entries: (msg.data?.entries ?? []) as { name: string; type: string }[] } }));
			if (action === "read" && msg.requestId === latestRead.current.get(id)) setFile({ nodeId: id, path: String(msg.data?.path ?? ""), text: String(msg.data?.text ?? "") });
			if (action === "write" && msg.requestId === pendingWrite.current) { pendingWrite.current = null; setFile((current) => current?.nodeId === id && current.path === msg.data?.path ? null : current); }

			if (action === "save") { setDraft(null); setSecret(""); if (msg.data?.id) setSelected(String(msg.data.id)); }
			if (action === "import_legacy" || action === "import") setNotice(t("nodeImported", { n: Number(msg.data?.count ?? 0) }));
		};
		window.addEventListener("pi-node-event", listener);
		return () => window.removeEventListener("pi-node-event", listener);
	}, [request, t]);
	const filtered = useMemo(() => nodes.filter((n) => `${n.name} ${n.host} ${n.username}`.toLowerCase().includes(search.toLowerCase())), [nodes, search]);
	const groups = useMemo(() => [...new Set(filtered.map((n) => n.group))], [filtered]);
	const listFiles = (target: string) => { const id = request("list", selected, { path: target }, activeTab?.id, activeTab?.conversationId); if (id) latestList.current.set(selected, id); };
	const openFile = (target: string) => { const id = request("read", selected, { path: target }, activeTab?.id, activeTab?.conversationId); if (id) latestRead.current.set(selected, id); };
	const saveFile = () => { if (!file || file.nodeId !== selected) return; pendingWrite.current = request("write", file.nodeId, { path: file.path, text: file.text }, activeTab?.id, activeTab?.conversationId); };

	const openNode = (target: Node) => {
		setSelected(target.id); setError("");
		if ((target.auth === "password" && !target.hasSecret) || (target.auth === "key" && (!target.keyPath || target.unsupported?.includes("key")) && !target.localKeyPath)) { setCredentialAuth(target.auth === "key" ? "key" : "password"); setCredentialKeyPath(target.localKeyPath || target.keyPath || ""); setCredential(target.id); setSecret(""); setSameGroup(false); opening.current.add(target.id); return; }
		setWorkspace(true); setSourceView(false);
		if (connections[target.id] === "connected") { if (!(tabs[target.id] ?? []).some((tab) => !tab.closed)) request("terminal_open", target.id, {}, randomUuid()); }
		else { opening.current.add(target.id); request("connect", target.id); }
	};

	const addButton = <button onClick={() => { setDraft(draftNode()); setSecret(""); }} aria-label={t("nodeAdd")}>＋</button>;
	const importButton = <label className="node-secondary">{t("nodeImportJson")}<input type="file" accept="application/json,.json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { const data = JSON.parse(await f.text()); request("import", undefined, { nodes: data.nodes }); } catch { setError(t("nodeInvalidJson")); } e.target.value = ""; }} /></label>;
	const sourceCards = <div className="node-source-page"><div className="node-eyebrow">{t("nodeSources")}</div><h2>{t("nodeAdd")}</h2><p className="node-muted">{t("nodeSourceIntro")}</p>
		{detectedDone && !detected.length && !sources.length && <p className="node-muted">{t("nodeNoSources")}</p>}
		{[...sources, ...detected.filter((d) => !sources.some((s) => s.path === d.path))].map((s) => <section className="node-source-card" key={s.path}>
			<header><span className="node-source-icon">{s.kind === "xshell" ? "X" : "~/"}</span><div><strong>{s.kind === "xshell" ? "Xshell 8" : "SSH config"}</strong><small>{t("nodeSyncInfo", { n: s.count ?? 0, g: s.groups ?? 0 })}</small></div></header>
			<code>{s.path}</code><p>✓ {t("nodeSyncFields")}</p><p className="node-muted">— {t("nodeSyncPassword")}<br />— {t("nodeSyncUnsupported")}</p>
			{s.error && <p className="node-error" role="alert">{s.error}</p>}{s.lastSync && <small>{t("nodeSyncTime", { time: new Date(s.lastSync).toLocaleString() })}</small>}
			<div className="node-actions">{s.id ? <><button onClick={() => request("source_sync", undefined, { id: s.id })}>{t("nodeSyncNow")}</button><button onClick={() => request("source_toggle", undefined, { id: s.id, enabled: !s.enabled })}>{t(s.enabled ? "nodeSyncPause" : "nodeSyncResume")}</button></> : <><button className="node-primary" onClick={() => request("source_add", undefined, { kind: s.kind, path: s.path, enabled: true })}>{t("nodeSyncKeep")}</button><button onClick={() => request("source_add", undefined, { kind: s.kind, path: s.path, enabled: false })}>{t("nodeImportOnce")}</button></>}<button onClick={() => setSourceDraft({ kind: s.kind ?? "xshell", path: s.path ?? "" })}>{t("nodeChangePath")}</button></div>
		</section>)}
		<div className="node-actions"><button onClick={() => setSourceDraft({ kind: "xshell", path: "" })}>{t("nodeAddSource")}</button><button onClick={() => request("source_detect")}>{t("nodeDetect")}</button>{addButton}{importButton}</div>
	</div>;
	return <div className={`node-workbench ${workspace && node ? "node-workspace-open" : ""}`}>
		{error && <div className="node-global-message node-error" role="alert">{error}<button aria-label={t("close")} onClick={() => setError("")}>×</button></div>}
		{notice && <div className="node-global-message node-notice" role="status">{notice}<button aria-label={t("close")} onClick={() => setNotice("")}>×</button></div>}
		{!workspace && <aside className="node-sidebar"><header><strong>{t("nodeWorkbench")}</strong>{addButton}</header><input aria-label={t("nodeSearch")} placeholder={t("nodeSearch")} value={search} onChange={(e) => setSearch(e.target.value)} />
			{sources.map((s) => <button className="node-source-status" key={s.id} onClick={() => setSourceView(true)}><span className={`node-dot ${s.error ? "connecting" : s.enabled ? "connected" : "offline"}`} />{s.kind === "xshell" ? "Xshell 8" : "SSH config"}<small>{s.error || (s.lastSync ? new Date(s.lastSync).toLocaleTimeString() : "…")}</small></button>)}
			<div className="node-list">{groups.map((group) => <section key={group}><h3>{group}<span>{filtered.filter((n) => n.group === group).length}</span></h3>{filtered.filter((n) => n.group === group).map((n) => <div className={`node-item ${selected === n.id ? "selected" : ""}`} key={n.id}><button onClick={() => { setSelected(n.id); setSourceView(false); }}><span className={`node-dot ${connections[n.id] ?? "offline"}`} />{n.name}<small>{n.username}@{n.host}:{n.port}</small></button>{(n.sourceMissing || n.unsupported?.length || n.auth === "password" && !n.hasSecret) && <span className="node-badge">{t(n.sourceMissing ? "nodeSourceMissing" : n.unsupported?.length ? "nodeUnsupported" : "nodeMissingSecret")}</span>}{!n.sourceId && <button title={t("nodeEdit")} onClick={() => { setDraft(n); setSecret(""); }}>⋯</button>}</div>)}</section>)}</div>
			<footer><button onClick={() => setSourceView(true)}>{t("nodeSources")}</button>{importButton}<details><summary>⋯</summary><button onClick={() => request("import_legacy")}>{t("nodeImportLegacy")}</button><button onClick={() => { const clean = nodes.map(({ hasSecret, fingerprint, sourceId, sourceKey, sourceMissing, ...rest }) => rest); const url = URL.createObjectURL(new Blob([JSON.stringify({ nodes: clean }, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "pi-nodes.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>{t("nodeExport")}</button></details></footer>
		</aside>}
		{!workspace && (sourceView || !node ? sourceCards : <section className="node-detail">
			<header className="node-detail-head"><div><div className="node-eyebrow">{node.group}</div><h2>{node.name}</h2><code>{node.username}@{node.host}:{node.port}</code></div><div className="node-actions">{source && <button onClick={() => request("source_reveal", undefined, { id: source.id })}>{t("nodeRevealSource")}</button>}{!node.sourceId && <button onClick={() => { setDraft(node); setSecret(""); }}>{t("nodeEdit")}</button>}<button className="node-primary" disabled={!!node.unsupported?.some((reason) => reason !== "key") || node.sourceMissing || connections[node.id] === "connecting"} onClick={() => openNode(node)}>{t("nodeOpenTerminal")}</button></div></header>
			{node.sourceMissing && <p className="node-warning">{t("nodeSourceMissing")}</p>}{!!node.unsupported?.length && <p className="node-warning">{t("nodeUnsupported")}: {node.unsupported.join(", ")}</p>}
			{<div className={node.hasSecret ? "node-credential-note" : "node-warning"}><div><strong>{t(node.auth === "agent" ? "nodeAgentAuth" : node.auth === "password" ? "nodePassword" : "nodePassphrase")}{!node.hasSecret && node.auth === "password" && ` · ${t("nodeMissingSecret")}`}</strong><p>{t("nodeCredentialHint")}</p></div><button onClick={() => { setCredentialAuth(node.auth === "key" ? "key" : "password"); setCredentialKeyPath(node.localKeyPath || node.keyPath || ""); setCredential(node.id); setSecret(""); setSameGroup(false); }}>{t("nodeFillSecret")}</button></div>}
			<dl><dt>{t("nodeAuth")}</dt><dd>{t(node.auth === "key" ? "nodeKey" : node.auth === "agent" ? "nodeAgentAuth" : "nodePassword")}</dd>{(node.localKeyPath || node.keyPath) && <><dt>{t("nodeKeyPath")}</dt><dd><code>{node.localKeyPath || node.keyPath}</code></dd></>}{source && <><dt>{t("nodeSourceLocation")}</dt><dd><code>{source.path}{source.kind === "xshell" ? `/${node.sourceKey}` : ` · ${node.sourceKey}`}</code><small>{t("nodeSourceReadonly")}</small><button title={t("nodeSourceOpenHint")} onClick={() => void navigator.clipboard.writeText(source.kind === "xshell" ? `${source.path}/${node.sourceKey}` : source.path).then(() => setNotice(t("nodeCopied"))).catch((e) => setError(String(e)))}>{t("nodeCopy")}</button></dd></>}<dt>{t("nodeLastConnected")}</dt><dd>{node.lastConnected ? new Date(node.lastConnected).toLocaleString() : t("nodeNever")}</dd><dt>{t("nodeDefaultDir")}</dt><dd><code>{node.defaultDir}</code></dd></dl>

		</section>)}
		{workspace && node && <div className="node-connected"><nav className="node-connection-tabs"><button onClick={() => setWorkspace(false)}>{t("nodeBackList")}</button>{nodes.filter((n) => n.id === selected || connections[n.id] || tabs[n.id]?.length).map((n) => <button key={n.id} className={n.id === selected ? "active" : ""} onClick={() => setSelected(n.id)}><span className={`node-dot ${connections[n.id] ?? "offline"}`} />{n.name}</button>)}<button onClick={() => { setWorkspace(false); setSourceView(true); }} aria-label={t("nodeAdd")}>＋</button>{timings[selected]?.connectedAt && <span className="node-connection-timing">{t("nodeConnectionTiming", { ms: timings[selected].latencyMs ?? 0, duration: `${Math.floor(Math.max(0, now - timings[selected].connectedAt!) / 60000)}:${String(Math.floor(Math.max(0, now - timings[selected].connectedAt!) / 1000) % 60).padStart(2, "0")}` })}</span>}</nav>
			<div className="node-connected-body"><section className="node-main"><header className="node-main-head"><strong>{node.name}</strong><span>{node.username}@{node.host}:{node.port}</span><em>{t(connections[selected] === "connected" ? "nodeConnected" : "nodeDisconnected")}</em><button onClick={() => connections[selected] === "connected" ? request("disconnect", selected) : openNode(node)}>{t(connections[selected] === "connected" ? "nodeDisconnect" : "nodeConnect")}</button></header>
			<div className="node-tabs">{currentTabs.map((tab, i) => <div key={tab.id} className={activeTab?.id === tab.id ? "active" : ""}><button onClick={() => setActiveTabs((a) => ({ ...a, [selected]: tab.id }))}>{t("nodeTab", { n: i + 1 })}{tab.closed ? ` · ${t("nodeTabClosed")}` : tab.busy ? ` · ${t("nodeTabBusy")}` : ""}</button><button aria-label={t("nodeCloseTab")} onClick={() => { if (!tab.closed) request("terminal_close", selected, {}, tab.id, tab.conversationId); terminalHistory.current.delete(`${selected}:${tab.id}`); setTabs((all) => ({ ...all, [selected]: (all[selected] ?? []).filter((x) => x.id !== tab.id) })); }}>×</button></div>)}<button disabled={connections[selected] !== "connected"} onClick={() => request("terminal_open", selected, {}, randomUuid())}>＋</button></div>
			<div className="node-terminals">{currentTabs.map((tab) => <RemoteTerminal key={`${selected}:${tab.id}`} nodeId={selected} tab={tab} active={active && activeTab?.id === tab.id} send={send} initialOutput={terminalHistory.current.get(`${selected}:${tab.id}`) ?? tab.output}  />)}{!currentTabs.length && <div className="node-empty">{t("nodeOpenHint")}</div>}</div>
			<div className="node-terminal-footer"><span>{t("nodeTerminalHint")}</span><button onClick={() => setShowFiles(!showFiles)}>{t("nodeShowFiles")}</button></div>
			{showFiles && <><div className="node-filebar"><input value={path} onChange={(e) => setPath(e.target.value)} aria-label={t("nodeDefaultDir")} /><button disabled={connections[selected] !== "connected"} onClick={() => listFiles(path)}>{t("nodeBrowse")}</button></div><div className="node-files">{entries.map((entry) => { const target = `${path.replace(/\/$/, "")}/${entry.name}`; return <button key={entry.name} onClick={() => entry.type === "dir" ? (setPath(target), listFiles(target)) : openFile(target)}>{entry.type === "dir" ? "▸" : "·"} {entry.name}</button>; })}</div></>}
			{file?.nodeId === selected && <div className="node-file-editor"><span>{file.path}</span><button onClick={saveFile}>{t("save")}</button><button onClick={() => setFile(null)}>{t("close")}</button><textarea value={file.text} onChange={(e) => setFile({ ...file, text: e.target.value })} /></div>}
		</section></div>
		</div>}
		{sourceDraft && <div className="node-modal-backdrop"><form className="node-modal" onSubmit={(e) => { e.preventDefault(); request("source_add", undefined, { ...sourceDraft, enabled: true }); }}><h2>{t("nodeAddSource")}</h2><label>{t("nodeSources")}<select value={sourceDraft.kind} onChange={(e) => setSourceDraft({ ...sourceDraft, kind: e.target.value as "xshell" | "ssh" })}><option value="xshell">Xshell 8</option><option value="ssh">SSH config</option></select></label><label>{t("nodeSourcePath")}<input required autoFocus value={sourceDraft.path} onChange={(e) => setSourceDraft({ ...sourceDraft, path: e.target.value })} /></label><div className="node-modal-actions"><button type="button" onClick={() => setSourceDraft(null)}>{t("cancel")}</button><button type="submit">{t("nodeSyncKeep")}</button><button type="button" disabled={!sourceDraft.path.trim()} onClick={() => request("source_add", undefined, { ...sourceDraft, enabled: false })}>{t("nodeImportOnce")}</button></div></form></div>}
		{credentialNode && <div className="node-modal-backdrop"><form className="node-modal" onSubmit={(e) => { e.preventDefault(); const payload = { auth: credentialAuth, secret, persist: persistSecret, sameGroup, ...(credentialAuth === "key" ? { keyPath: credentialKeyPath } : {}) }; credentialAttempt.current = { nodeId: credentialNode.id, payload }; setTesting(true); request("credential_test", credentialNode.id, payload); }}><h2>{credentialNode.name}</h2><code>{credentialNode.username}@{credentialNode.host}:{credentialNode.port}</code><label>{t("nodeAuth")}<select disabled={testing} value={credentialAuth} onChange={(e) => { setCredentialAuth(e.target.value as "password" | "key"); setSecret(""); setSameGroup(false); }}><option value="password">{t("nodePassword")}</option><option value="key">{t("nodeKey")}</option></select></label><p className="node-muted">{t("nodeLocalAuthHint")}</p><>{credentialAuth === "key" && <><label>{t("nodeKeyPath")}<input required value={credentialKeyPath} onChange={(e) => setCredentialKeyPath(e.target.value)} /></label><p className="node-muted">{t("nodePrivateKeyHint")}</p></>}</><label>{t(credentialAuth === "key" ? "nodePassphrase" : "nodePassword")}<input autoFocus type="password" autoComplete="new-password" required={credentialAuth === "password"} value={secret} onChange={(e) => setSecret(e.target.value)} /></label><label className="node-checkbox"><input type="checkbox" checked={persistSecret} onChange={(e) => setPersistSecret(e.target.checked)} />{t("nodePersistSecret")}</label>{credentialAuth === "password" && <label className="node-checkbox"><input type="checkbox" checked={sameGroup} onChange={(e) => setSameGroup(e.target.checked)} />{t("nodeGroupSecret")}</label>}{sameGroup && <p className="node-muted">{t("nodeGroupHint")}</p>}<p className="node-muted">{t("nodeCredentialHint")}</p><div className="node-modal-actions"><button type="button" disabled={testing} onClick={() => { opening.current.delete(credentialNode.id); setCredential(null); setSecret(""); credentialAttempt.current = null; }}>{t("cancel")}</button><button disabled={testing} className="node-primary">{t(testing ? "nodeTesting" : "nodeTestSave")}</button></div></form></div>}

		{draft && <div className="node-modal-backdrop"><form className="node-modal" onSubmit={(e) => { e.preventDefault(); request("save", draft.id, { ...draft, secret: secret || undefined }); }}><h2>{draft.id ? t("nodeEdit") : t("nodeAdd")}</h2>{([ ["group", t("nodeGroup")], ["name", t("nodeName")], ["host", t("nodeAddress")], ["port", t("nodePort")], ["username", t("nodeUsername")], ["defaultDir", t("nodeDefaultDir")] ] as const).map(([key, label]) => <label key={key}>{label}<input required={key !== "group"} value={String(draft[key] ?? "")} onChange={(e) => setDraft({ ...draft, [key]: key === "port" ? Number(e.target.value) : e.target.value })} /></label>)}<label>{t("nodeAuth")}<select value={draft.auth} onChange={(e) => setDraft({ ...draft, auth: e.target.value as Node["auth"] })}><option value="password">{t("nodePassword")}</option><option value="key">{t("nodeKey")}</option><option value="agent">{t("nodeAgentAuth")}</option></select></label>{draft.auth === "key" && <label>{t("nodeKeyPath")}<input value={draft.keyPath ?? ""} onChange={(e) => setDraft({ ...draft, keyPath: e.target.value })} /></label>}{draft.auth !== "agent" && <label>{draft.auth === "key" ? t("nodePassphrase") : t("nodePassword")}<input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={draft.hasSecret ? t("nodeKeepSecret") : ""} /></label>}<div className="node-modal-actions">{draft.id && draft.fingerprint && <button type="button" onClick={() => { if (window.confirm(t("nodeForgetHostKeyConfirm", { name: draft.name ?? "" }))) request("forget_host_key", draft.id); }}>{t("nodeForgetHostKey")}</button>}{draft.id && <button type="button" onClick={() => { if (window.confirm(t("nodeDeleteConfirm", { name: draft.name ?? "" }))) { request("delete", draft.id); setDraft(null); } }}>{t("nodeDelete")}</button>}<button type="button" onClick={() => setDraft(null)}>{t("cancel")}</button><button type="submit">{t("save")}</button></div></form></div>}	</div>;
}
