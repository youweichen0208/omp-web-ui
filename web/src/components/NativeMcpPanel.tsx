import { Dialog } from "./Dialog";
import { LinkedText } from "./LinkedText";
import { useEffect, useState, useRef } from "react";
import type { ClientMessage, ServerMessage, NativeMcpConfigState } from "../types";
import { randomUuid } from "../uuid";
import { useT } from "../i18n";

export function NativeMcpPanel({ cwd, send, dialog }: { dialog: { id: number; kind: "select" | "confirm" | "input"; title: string; args: unknown[] } | null; cwd: string; send: (msg: ClientMessage) => boolean }) {
	const t = useT();
	const [status,setStatus] = useState("");
	useEffect(() => {
		const receive = (e: Event) => setStatus((e as CustomEvent<string>).detail);
		window.addEventListener("pi-mcp-notice", receive);
		return () => window.removeEventListener("pi-mcp-notice", receive);
	}, []);
	const [scope,setScope] = useState<"global" | "project">("global");
	const [state,setState] = useState<NativeMcpConfigState>();
	const [text,setText] = useState("");
	const [error,setError] = useState("");
	const [pending,setPending] = useState(false);
	const [tools,setTools] = useState<string[]>([]);
	const [name,setName] = useState("");
	const [transport,setTransport] = useState("stdio");
	const [endpoint,setEndpoint] = useState("");
	const [editing,setEditing] = useState(false);
	const [args,setArgs] = useState("[]");
	const [environment,setEnvironment] = useState("{}");
	const [headers,setHeaders] = useState("{}");
	const [provider,setProvider] = useState("");
	const [oauth,setOauth] = useState("{}");
	const [enabled,setEnabled] = useState(true);
	const [exposure,setExposure] = useState("codemode");
	const edit = (server: string) => {
		try {
			const config = JSON.parse(text).mcpServers[server];
			setName(server); setEditing(true); setTransport(config.url ? "http" : "stdio"); setEndpoint(config.url ?? config.command ?? "");
			setArgs(JSON.stringify(config.args ?? [])); setEnvironment(JSON.stringify(config.env ?? {})); setHeaders(JSON.stringify(config.headers ?? {})); setProvider(config.auth?.provider ?? ""); setOauth(JSON.stringify(config.oauth ?? {})); setEnabled(config.enabled !== false); setExposure(config.exposure ?? "codemode");
		} catch(e) { setError((e as Error).message); }
	};
	const remove = (server: string) => { try { const document = JSON.parse(text); delete document.mcpServers[server]; setText(JSON.stringify(document,null,2)); } catch(e) { setError((e as Error).message); } };
	const requests = useRef(new Map<string, string>());
	const request = (action: Extract<ClientMessage,{type:"native_mcp_request"}>["action"], extra = {}, preserveDraft = false) => { const requestId = randomUuid(); requests.current.set(requestId,preserveDraft ? "check" : action); if (!send({ type: "native_mcp_request", requestId, cwd, scope, action, ...extra })) { requests.current.delete(requestId); setError(t("imageDisconnected")); } };
	useEffect(() => {
		requests.current.clear(); setState(undefined); setText(""); setError("");
		const receive = (event: Event) => {
			const msg = (event as CustomEvent<Extract<ServerMessage,{type:"native_mcp_result"}>>).detail;
			if (msg.cwd !== cwd || msg.state && msg.state.scope !== scope || !requests.current.has(msg.requestId)) return;
			const action = requests.current.get(msg.requestId); requests.current.delete(msg.requestId);
			setError(msg.error ?? ""); setPending(!!msg.pending);
			if (msg.state && action !== "command" && action !== "check") { setState(msg.state); setText(JSON.stringify(msg.state.document,null,2)); }
			if (msg.tools) setTools(msg.tools);
		};
		window.addEventListener("pi-native-mcp-event",receive); request("get");
		return () => window.removeEventListener("pi-native-mcp-event",receive);
	},[cwd,scope,send]);
	useEffect(() => { if (!pending) return; const timer = setInterval(() => request("get", {}, true), 2000); return () => clearInterval(timer); }, [pending,cwd,scope,send]);
	const save = () => { try { request("save",{ version:state?.version, document:JSON.parse(text) }); } catch(e) { setError((e as Error).message); } };
	const add = () => { try {
		const document = JSON.parse(text), servers = document.mcpServers ?? {};
		if (!name.trim() || !editing && Object.hasOwn(servers,name)) throw new Error(t("mcpNameConflict"));
		const previous = editing ? servers[name] : {};
		const config = { ...previous, enabled, exposure, type: transport };
		delete config.command; delete config.args; delete config.env; delete config.url; delete config.headers; delete config.oauth; delete config.auth;
		servers[name] = transport === "stdio" ? { ...config, command:endpoint,args:JSON.parse(args),env:JSON.parse(environment) } : { ...config, url:endpoint,headers:JSON.parse(headers), ...(provider ? {auth:{...(previous.auth ?? {}),provider}} : {oauth:JSON.parse(oauth)}) };
		setText(JSON.stringify({...document,mcpServers:servers},null,2));
	} catch(e) { setError((e as Error).message); } };
	const servers = Object.keys(state?.document.mcpServers ?? {});
	return <section className="native-mcp-panel">
		<h3>{t("nativeMcp")}</h3><p className="mcp-status"><LinkedText text={status} /></p>{dialog && <Dialog dialog={dialog} send={send} />}<p>{t("mcpExplanation")}</p>
		<select aria-label={t("mcpScope")} value={scope} onChange={e => setScope(e.target.value as typeof scope)}><option value="global">{t("mcpGlobal")}</option><option value="project">{t("mcpProject")}</option></select>
		<p><code>{state?.path}</code></p>
		{scope === "project" && !state?.trusted && <p>{t("mcpUntrusted")} <button onClick={() => request("trust")}>{t("mcpTrust")}</button></p>}
		{pending && <p role="status">{t("mcpPending")}</p>}
		<label>{t("mcpName")}<input disabled={editing} value={name} onChange={e => setName(e.target.value)} /></label>
		<select value={transport} onChange={e => setTransport(e.target.value)}><option>stdio</option><option>http</option></select>
		<label>{transport === "stdio" ? t("mcpCommand") : "URL"}<input value={endpoint} onChange={e => setEndpoint(e.target.value)} /></label>{transport === "stdio" ? <><label>{t("mcpArgs")}<input value={args} onChange={e => setArgs(e.target.value)} /></label><label>{t("mcpEnv")}<textarea rows={3} value={environment} onChange={e => setEnvironment(e.target.value)} /></label></> : <><label>{t("mcpHeaders")}<textarea rows={3} value={headers} onChange={e => setHeaders(e.target.value)} /></label><label>{t("mcpProvider")}<input disabled={scope === "project"} value={provider} onChange={e => setProvider(e.target.value)} /></label><label>{t("mcpOauth")}<textarea rows={4} value={oauth} onChange={e => setOauth(e.target.value)} /></label></>}
		<label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />{t("mcpEnabled")}</label>
		<label>{t("mcpExposure")}<select value={exposure} onChange={e => setExposure(e.target.value)}>{["codemode","deferred","direct","hidden"].map(value => <option key={value}>{value}</option>)}</select></label>
		<button onClick={add}>{t(editing ? "mcpUpdateDraft" : "mcpAdd")}</button><button onClick={() => {setEditing(false);setName("");}}>{t("mcpNew")}</button>
		<p>{t("mcpJsonHelp")}</p><textarea aria-label={t("mcpConfig")} rows={18} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
		{error && <p role="alert">{error}</p>}
		<button disabled={!state} onClick={save}>{t("save")}</button><button onClick={() => request("get")}>{t("mcpRefresh")}</button><button onClick={() => request("command",{command:"status"})}>{t("mcpStatus")}</button>
		{servers.map(server => <div key={server}><code>{server}</code><button onClick={() => edit(server)}>{t("mcpEdit")}</button><button onClick={() => remove(server)}>{t("delete")}</button>{(["login","logout","reconnect"] as const).map(command => <button key={command} onClick={() => request("command",{command,name:server})}>{t(`mcp_${command}`)}</button>)}</div>)}
		{tools.length > 0 && <p>{t("mcpTools")}: {tools.join(", ")}</p>}
	</section>;
}
