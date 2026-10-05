import { Dialog } from "./Dialog";
import { LinkedText } from "./LinkedText";
import { useEffect, useState, useRef } from "react";
import type { ClientMessage, ServerMessage, NativeMcpConfigState, NativeCodemodeSettings, NativeMcpTool, NativeMcpServerStatus } from "../types";
import { randomUuid } from "../uuid";
import { useT } from "../i18n";
import { MCP_EXPOSURES, effectiveMcpExposure, importMcpJson } from "../mcp-presentation";

type Reply = Extract<ServerMessage, { type: "native_mcp_result" }>;
type Action = Extract<ClientMessage, { type: "native_mcp_request" }>["action"];
export function NativeMcpPanel({ cwd, send, dialog }: { dialog: { id: string; conversationId: string; kind: "select" | "confirm" | "input" | "editor"; title: string; args: unknown[] } | null; cwd: string; send: (msg: ClientMessage) => boolean }) {
	const t = useT();
	const [scope, setScope] = useState<"global" | "project">("global");
	const [state, setState] = useState<NativeMcpConfigState>();
	const [native, setNative] = useState<NativeCodemodeSettings>();
	const [mode, setMode] = useState<"on" | "only">("on");
	const [budget, setBudget] = useState(3000);
	const [text, setText] = useState("");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [pending, setPending] = useState(false);
	const [busy, setBusy] = useState(false);
	const [statuses, setStatuses] = useState<NativeMcpServerStatus[]>([]);
	const [statusText, setStatusText] = useState("");
	const [tools, setTools] = useState<NativeMcpTool[]>([]);
	const [expanded, setExpanded] = useState<string>();
	const [editor, setEditor] = useState<{ original?: string; name: string; json: string }>();
	const [importText, setImportText] = useState<string>();
	const [log, setLog] = useState<string>();
	const [advanced, setAdvanced] = useState(false);
	const dirty = !!state && text !== JSON.stringify(state.document, null, 2);
	const mutating = useRef(false);
	const requests = useRef(new Map<string, { action: Action; preserve: boolean }>());
	const request = (action: Action, extra = {}, preserve = false) => {
		if (action !== "get" && mutating.current) return;
		if (action !== "get") mutating.current = true;
		const requestId = randomUuid(); requests.current.set(requestId, { action, preserve });
		if (action !== "get") setBusy(true);
		if (!send({ type: "native_mcp_request", requestId, cwd, scope, action, ...extra })) { requests.current.delete(requestId); mutating.current = false; setBusy(false); setError(t("connectionDisconnected")); }
	};
	useEffect(() => {
		requests.current.clear(); mutating.current = false; setState(undefined); setNative(undefined); setText(""); setError(""); setNotice(""); setStatuses([]); setTools([]); setBusy(false); setEditor(undefined); setImportText(undefined); setLog(undefined); setExpanded(undefined);
		const receive = (event: Event) => {
			const msg = (event as CustomEvent<Reply>).detail;
			const req = requests.current.get(msg.requestId);
			if (!req || msg.cwd !== cwd || msg.state && msg.state.scope !== scope) return;
			requests.current.delete(msg.requestId);
			if (req.action !== "get") { mutating.current = false; setBusy(false); }
			if (msg.error) { setError(msg.error); if (req.action === "codemode" && msg.codemode) { setNative(msg.codemode); setMode(msg.codemode.mode); setBudget(msg.codemode.inlineBudget); } return; }
			if (!req.preserve) setError("");
			setPending(!!msg.pending);
			if (msg.state && !req.preserve) { setState(msg.state); setText(JSON.stringify(msg.state.document, null, 2)); }
			if (msg.codemode && (!req.preserve || req.action === "codemode")) { setNative(msg.codemode); setMode(msg.codemode.mode); setBudget(msg.codemode.inlineBudget); }
			if (msg.codemode && req.preserve && req.action !== "codemode") setNative(old => old ? { ...old, effectiveMode: msg.codemode!.effectiveMode, effectiveInlineBudget: msg.codemode!.effectiveInlineBudget } : msg.codemode);
			if (msg.servers) setStatuses(msg.servers);
			if (msg.statusText !== undefined) setStatusText(msg.statusText);
			if (msg.toolInfo) setTools(msg.toolInfo);
			if (msg.log !== undefined) setLog(msg.log);
		};
		const onNotice = (e: Event) => setNotice((e as CustomEvent<string>).detail);
		window.addEventListener("pi-native-mcp-event", receive); window.addEventListener("pi-mcp-notice", onNotice); request("get");
		const timer = setInterval(() => { if (!requests.current.size) request("get", {}, true); }, 3000);
		return () => { clearInterval(timer); window.removeEventListener("pi-native-mcp-event", receive); window.removeEventListener("pi-mcp-notice", onNotice); };
	}, [cwd, scope, send]);
	useEffect(() => { if (!dirty && !busy && !editor && importText === undefined) return; const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent); }, [dirty, busy, editor, importText]);
	const change = (update: (document: Record<string, unknown>) => void) => { try { const document = JSON.parse(text); update(document); setText(JSON.stringify(document, null, 2)); setError(""); request("save", { version: state?.version, document }); } catch (e) { setError((e as Error).message); } };
	const save = () => { try { request("save", { version: state?.version, document: JSON.parse(text) }); } catch (e) { setError((e as Error).message); } };
	let document: Record<string, unknown> = {};
	try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) document = parsed; } catch { /* raw JSON draft remains editable */ }
	const configs = (document.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
	const safeConfigs = configs && typeof configs === "object" && !Array.isArray(configs) ? configs : {};
	const rank = (name: string) => { const status = statuses.find(s => s.name === name)?.state; return status === "needs-auth" || status === "failed" || status === "error" ? 0 : status === "starting" || status === "connecting" || status === "disconnected" ? 1 : 2; };
	const names = [...new Set([...Object.keys(safeConfigs), ...statuses.map(s => s.name)])].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
	const setServer = (name: string, value: Record<string, unknown> | null) => change(doc => { const servers = { ...(doc.mcpServers as Record<string, unknown> ?? {}) }; if (value === null) delete servers[name]; else servers[name] = value; doc.mcpServers = servers; });
	const applyEditor = () => { if (!editor) return; try { if (!/^[\w-]+$/.test(editor.name) || !editor.original && Object.hasOwn(safeConfigs, editor.name)) throw new Error(t("mcpNameConflict")); const value = JSON.parse(editor.json); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("mcpInvalidServer")); setServer(editor.name, value); setEditor(undefined); } catch (e) { setError((e as Error).message); } };
	return <section className="native-mcp-panel mcp-workbench" data-dirty={dirty || busy || !!editor || importText !== undefined}>
		<header className="mcp-page-head"><h3>{t("nativeMcp")}</h3><div className="settings-heading-actions"><button disabled={!state || busy} onClick={() => setAdvanced(true)}>{t("v2EditMcp")}</button><button disabled={busy} onClick={() => request("log", {}, true)}>{t("extLog")}</button></div></header>
		{dialog && <Dialog dialog={dialog} send={send} />}
		{notice && <div className="mcp-notice"><LinkedText text={notice} /></div>}
		<h4 className="settings-group-title">{t("mcpServersTitle")}<small>{t("v2ServersHint")}</small></h4><div className="mcp-scope-row"><span title={state?.path}>{t("mcpScope")}<small className="settings-description">{t("v2ScopeHint")}</small></span><div className="settings-segment" role="group" aria-label={t("mcpScope")}>{(["global", "project"] as const).map(value => <button key={value} disabled={busy} aria-pressed={scope === value} onClick={() => { if ((!dirty && !editor && importText === undefined) || window.confirm(t("mcpDiscard"))) setScope(value); }}>{t(value === "global" ? "mcpGlobal" : "mcpProject")}</button>)}</div></div>
		{scope === "project" && !state?.trusted && <p className="mcp-warning">{t("mcpUntrusted")} <button disabled={busy} onClick={() => request("trust")}>{t("mcpTrust")}</button></p>}
		{pending && <p className="mcp-warning" role="status">{t("mcpPending")}</p>}
		{error && <p className="mcp-error" role="alert">{error} <button disabled={busy} onClick={() => { if (!dirty || window.confirm(t("mcpDiscard"))) request("get"); }}>{t("promptReloadFile")}</button></p>}
		<div className="mcp-section-head"><span>{!names.length ? t("v2NoServersHint") : ""}</span><button disabled={!state || busy} onClick={() => setImportText("")}>{t("mcpImport")}</button><button disabled={!state || busy} onClick={() => setEditor({ name: "", json: '{\n  "url": "https://example.com/mcp",\n  "exposure": "codemode"\n}' })}>+ {t("mcpNew")}</button></div>
		{importText !== undefined && <div className="mcp-editor"><h4>{t("mcpImport")}</h4><p>{t("mcpImportHelp")}</p><textarea aria-label={t("mcpImport")} rows={8} value={importText} onChange={e => setImportText(e.target.value)} /><button onClick={() => { try { const document = importMcpJson(importText, JSON.parse(text)); setText(JSON.stringify(document, null, 2)); request("save", { version: state?.version, document }); setImportText(undefined); setError(""); } catch (e) { setError((e as Error).message); } }}>{t("settingsImportSave")}</button><button onClick={() => setImportText(undefined)}>{t("cancel")}</button></div>}
		{editor && <div className="mcp-editor"><label>{t("mcpName")}<input disabled={!!editor.original} value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} /></label><p>{t("mcpEditorHelp")}</p><textarea aria-label={t("mcpConfig")} rows={10} value={editor.json} onChange={e => setEditor({ ...editor, json: e.target.value })} spellCheck={false} /><button disabled={busy} onClick={applyEditor}>{t("save")}</button><button onClick={() => setEditor(undefined)}>{t("cancel")}</button></div>}
		<div className="mcp-server-list">{names.map(name => {
			const raw = safeConfigs[name]; const config = raw && typeof raw === "object" ? raw : undefined;
			const status = statuses.find(s => s.name === name);
			const serverTools = tools.filter(tool => tool.name.startsWith(`mcp__${name.replace(/-/g, "_")}__`));
			const stateName = status?.state ?? (config?.enabled === false ? "disabled" : statusText ? "unknown" : "connecting");
			const label = stateName === "needs-auth" ? "mcpNeedsAuth" : stateName === "connected" ? "mcpConnected" : stateName === "connecting" || stateName === "starting" ? "mcpConnecting" : stateName === "disabled" ? "mcpDisabled" : stateName === "disconnected" ? "mcpDisconnected" : stateName === "unknown" ? "mcpNotLoaded" : "mcpFailed";
			return <article key={name} className={`mcp-server ${stateName}`}><div className="mcp-server-head"><button className="mcp-server-toggle" aria-expanded={expanded === name} onClick={() => setExpanded(expanded === name ? undefined : name)}><span aria-hidden="true">{expanded === name ? "⌄" : "›"}</span><i className="mcp-state-dot" /><strong>{name}</strong><small>{config?.url ? "http" : config?.command ? "stdio" : t("mcpRuntime")}</small></button><span className="mcp-server-state">{t(label)}{stateName === "connected" && ` · ${status?.toolCount ?? serverTools.length}`}</span>{config && <select aria-label={`${name} ${t("mcpExposure")}`} value={String(config.exposure ?? "codemode").replace("codemode-deferred", "codemode")} disabled={busy} onChange={e => setServer(name, { ...config, exposure: e.target.value })}>{MCP_EXPOSURES.map(value => <option key={value}>{value}</option>)}</select>}</div>
				{expanded === name && <div className="mcp-server-body"><p className="mcp-endpoint">{config?.description ? String(config.description) : ""}</p><code className="mcp-endpoint">{config?.url ? (() => { try { const url = new URL(String(config.url)); url.username = ""; url.password = ""; url.search = ""; return url.href; } catch { return "HTTP"; } })() : String(config?.command ?? "")}</code>
				{stateName === "needs-auth" && <div className="mcp-warning"><p>{t("mcpAuthHelp")}</p><button disabled={busy} onClick={() => request("command", { command: "login", name }, true)}>{t("mcp_login")}</button><p>{t("mcpRemoteLogin")}</p></div>}
				{status && stateName !== "connected" && stateName !== "needs-auth" && <pre className="mcp-diagnostic">{status.detail}</pre>}
				<div className="mcp-tool-table"><div className="mcp-tool-heading"><span>{t("mcpTools")}</span><span>{t("mcpAnnotations")}</span><span>{t("mcpActualExposure")}</span></div>{serverTools.map(tool => { const short = tool.name.split("__").slice(2).join("__"); const exposure = effectiveMcpExposure(config ?? {}, short); return <div key={tool.name}><code title={tool.description}>{short}</code><span>{tool.destructive ? t("mcpDestructive") : tool.readOnly ? t("mcpReadOnly") : "—"}</span>{config ? <span className="mcp-exposure-control"><small>{tool.exposure}</small><select aria-label={`${short} ${t("mcpActualExposure")}`} title={`${t("mcpActualExposure")}: ${tool.exposure}`} value={(config.toolExposure as Record<string, string> | undefined)?.[short] ?? "inherit"} disabled={busy} onChange={e => { const rules = { ...(config.toolExposure as Record<string, string> ?? {}) }; if (e.target.value === "inherit") delete rules[short]; else rules[short] = e.target.value; setServer(name, { ...config, toolExposure: rules }); }}><option value="inherit">{t("mcpInherit")} · {exposure.value}</option>{MCP_EXPOSURES.map(value => <option key={value} value={value}>{value} *</option>)}</select></span> : <code>{tool.exposure}</code>}</div>; })}{!serverTools.length && <p>{t("mcpNoTools")}</p>}</div>
				<div className="mcp-server-actions">{scope === "project" && !config && <button disabled={busy} onClick={() => setServer(name, { enabled: stateName === "disabled" })}>{t(stateName === "disabled" ? "mcpEnableProject" : "mcpDisableProject")}</button>}{(["reconnect", "login", "logout"] as const).map(command => <button key={command} disabled={busy || !status || stateName === "disabled"} onClick={() => request("command", { command, name }, true)}>{t(`mcp_${command}`)}</button>)}{config && <><button disabled={busy} onClick={() => setServer(name, { ...config, enabled: config.enabled === false })}>{t(config.enabled === false ? "mcpEnableServer" : "mcpDisableServer")}</button><button disabled={busy} onClick={() => setEditor({ original: name, name, json: JSON.stringify(config, null, 2) })}>{t("mcpEdit")}</button><button disabled={busy} onClick={() => { if (window.confirm(t("mcpRemoveConfirm", { name }))) setServer(name, null); }}>{t("delete")}</button></>}</div>
			</div>}</article>;
		})}</div>
		{dirty && !busy && <div className="mcp-save-row" role="status"><span>{t("mcpUnsaved")}</span><button onClick={save}>{t("settingsRetrySave")}</button><button onClick={() => { if (window.confirm(t("mcpDiscard"))) request("get"); }}>{t("promptReloadFile")}</button></div>}
		<h4 className="settings-group-title">Codemode<small>{t("v2CodemodeHint")}</small></h4>
		<div className="settings-group">
			<div className="mcp-setting-row"><span title={t("mcpModeHelp")}>{t("settingsToolPresentation")}<small className="settings-description">{t("v2ModeHint")}</small></span><div className="settings-segment" role="group" aria-label="codemode.mode">{(["on", "only"] as const).map(value => <button key={value} aria-pressed={mode === value} disabled={!native || busy} onClick={() => request("codemode", { version: native?.version, codemode: { mode: value, inlineBudget: budget } }, true)}>{value}</button>)}</div></div>
			<div className="mcp-setting-row"><span title={t("mcpBudgetHelp")}>{t("settingsDeclarationBudget")}<small className="settings-description">{t("v2BudgetHint")}</small></span><div className="settings-segment" role="group" aria-label="codemode.inlineBudget">{[...new Set([0, 3000, 8000, budget])].sort((a,b) => a-b).map(value => <button key={value} aria-pressed={budget === value} disabled={!native || busy} onClick={() => request("codemode", { version: native?.version, codemode: { mode, inlineBudget: value } }, true)}>{value}</button>)}</div></div>
			<label className="mcp-setting-row"><span title={t("mcpAutoHelp")}>{t("settingsAutoCodemode")}<small className="settings-description">{t("v2AutoHint")}</small></span><input className="settings-switch" type="checkbox" role="switch" aria-label="autoEnableCodemode" disabled={!state || busy} checked={typeof document.autoEnableCodemode === "boolean" ? document.autoEnableCodemode : state?.inheritedAutoEnableCodemode ?? true} onChange={e => change(doc => { doc.autoEnableCodemode = e.target.checked; })} /></label>
		</div>
		<footer className="settings-paths">{state?.paths?<><code>{t("mcpGlobal")} · {state.paths.global}</code><code>{t("mcpProject")} · {state.paths.project}</code></>:<code>{state?.path}</code>}</footer>
		{advanced&&<div className="ext-dialog-backdrop"><div className="ext-dialog mcp-json-dialog" role="dialog" aria-modal="true" aria-label={t("v2EditMcp")} onKeyDown={event=>{if(event.key==="Escape")event.stopPropagation();}}><header><h3>{t("v2EditMcp")}</h3></header><p>{t("mcpJsonHelp")}</p><code>{state?.path}</code><textarea aria-label={t("mcpConfig")} rows={15} value={text} disabled={busy} onChange={e=>setText(e.target.value)} spellCheck={false}/>{error&&<p className="mcp-error" role="alert">{error}</p>}<footer><button disabled={busy} onClick={()=>{if(!dirty||window.confirm(t("mcpDiscard"))){setText(JSON.stringify(state?.document,null,2));setAdvanced(false);}}}>{t("close")}</button><button disabled={busy||!dirty} onClick={save}>{t("save")}</button></footer></div></div>}

		{log !== undefined && <details className="mcp-advanced" open><summary>mcp.log</summary><pre>{log}</pre><button onClick={() => setLog(undefined)}>{t("close")}</button></details>}
	</section>;
}
