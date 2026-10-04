import { useEffect, useRef, useState } from "react";
import { FiCheck, FiCopy, FiChevronDown, FiChevronRight } from "react-icons/fi";
import { useT } from "../i18n";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import type { PromptFileView, SystemPromptState } from "../types";

type Edit = { file:PromptFileView; text:string; initial:string; confirmed:boolean };
export function SystemPromptPanel({cwd,conversationId}:{cwd:string;conversationId:string}) {
	const t=useT();
	const [state,setState]=useState<SystemPromptState>();
	const [error,setError]=useState("");
	const [edit,setEdit]=useState<Edit>();
	const [raw,setRaw]=useState(false),[rules,setRules]=useState(false),[preamble,setPreamble]=useState(false),[docs,setDocs]=useState(false);
	const [savedId,setSavedId]=useState<string>();
	const [busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[copied,setCopied]=useState(false);
	const alive=useRef(true),sequence=useRef(0),saving=useRef(false);
	const dirty=!!edit&&edit.text!==edit.initial;
	async function request(action:string,args:Record<string,unknown>={}) {
		const response=await fetch(withToken("/api/system-prompt"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId:getClientId(),cwd,conversationId,action,...args})});
		const result=await response.json();if(!response.ok)throw Error(result.error??response.statusText);return result as SystemPromptState;
	}
	async function refresh() {
		if(saving.current)return;
		const id=++sequence.current;
		try{const next=await request("get");if(alive.current&&sequence.current===id)setState(next);}catch(e){if(alive.current&&sequence.current===id)setError((e as Error).message);}
	}
	useEffect(()=>{alive.current=true;void refresh();const timer=setInterval(()=>void refresh(),2000);return()=>{alive.current=false;clearInterval(timer);};},[cwd,conversationId]);
	useEffect(()=>{if(!dirty)return;const handler=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};window.addEventListener("beforeunload",handler);return()=>window.removeEventListener("beforeunload",handler);},[dirty]);
	const discard=()=>!dirty||window.confirm(t("promptDiscard"));
	function open(file:PromptFileView,replacing=false) {
		if(!discard())return;
		const text=replacing&&!file.exists?state?.defaultPreamble??"":file.content;
		setEdit({file,text,initial:text,confirmed:!replacing});setSaved(false);setError("");
	}
	async function mutate(action:"save"|"restore"|"retry",file?:PromptFileView) {
		if(action==="restore"&&(!discard()||!window.confirm(t("promptRestoreConfirm",{path:file?.path??""}))))return;
		saving.current=true;setBusy(true);setError("");++sequence.current;
		try{const next=await request(action,file?{id:file.id,version:file.version,...(action==="save"?{content:edit?.text}:{})}:{});if(alive.current){setState(next);if(action!=="retry")setEdit(undefined);setSavedId(file?.id);setSaved(true);}}
		catch(e){if(alive.current)setError((e as Error).message);}
		finally{saving.current=false;if(alive.current)setBusy(false);}
	}
	async function reloadEditor() {
		if(!discard())return;
		try{const next=await request("get");if(!alive.current)return;setState(next);const file=next.files.find(f=>f.id===edit?.file.id);if(file)setEdit({file,text:file.content,initial:file.content,confirmed:true});setError("");}catch(e){setError((e as Error).message);}
	}
	async function copy(){try{await navigator.clipboard.writeText(state?.raw??"");setCopied(true);}catch{setError(t("promptCopyFailed"));}}
	function editor(kind:PromptFileView["kind"]) {
		if(!edit||edit.file.kind!==kind)return null;
		return <div className="prompt-editor" data-dirty={dirty}>
			{kind==="system"&&<div className="prompt-warning">{t("promptReplaceWarning")}</div>}
			{!edit.confirmed?<div className="prompt-editor-actions"><button onClick={()=>setEdit(undefined)}>{t("cancel")}</button><button className="prompt-primary" onClick={()=>setEdit({...edit,confirmed:true})}>{t("promptContinueReplace")}</button></div>:<>
				{kind!=="context"&&<label className="prompt-scope">{t("promptScope")}<select disabled={busy} value={edit.file.id} onChange={event=>{const file=state?.files.find(f=>f.id===event.target.value);if(file&&discard()){const text=kind==="system"&&!file.exists?state?.defaultPreamble??"":file.content;setEdit({file,text,initial:text,confirmed:true});}}}>{state?.files.filter(f=>f.kind===kind).map(file=><option key={file.id} value={file.id} disabled={!file.editable}>{t(file.scope==="user"?"promptUser":"promptProject")}{!file.editable?` · ${t("promptUntrusted")}`:""}</option>)}</select></label>}
				<code className="prompt-editor-path">{edit.file.path}</code>
				{kind==="context"&&<p className="prompt-muted">{t("promptContextHint")}</p>}
				<textarea autoFocus value={edit.text} onChange={event=>setEdit({...edit,text:event.target.value})} spellCheck={false} aria-label={t("promptEditor")} disabled={busy}/>
				<div className="prompt-editor-actions"><span>{t("promptNativeSave")}</span><button disabled={busy} onClick={()=>void reloadEditor()}>{t("promptReloadFile")}</button><button disabled={busy} onClick={()=>{if(discard())setEdit(undefined);}}>{t("cancel")}</button><button className="prompt-primary" disabled={busy||!edit.file.editable||state?.opaque} onClick={()=>void mutate("save",edit.file)}>{t(busy?"promptSaving":"promptSave")}</button></div>
			</>}
		</div>;
	}
	if(!state)return <section className="system-prompt-panel"><p>{t("loading")}</p>{error&&<p role="alert">{error}</p>}</section>;
	const content=(name:string)=>state.sections.find(section=>section.name===name)?.text;
	const system=state.files.find(file=>file.kind==="system"&&file.active);
	const append=state.files.filter(file=>file.kind==="append"&&file.active);
	const context=state.files.filter(file=>file.kind==="context");
	const preferred=(kind:"append"|"system")=>state.files.find(file=>file.kind===kind&&file.scope===(state.trusted?"project":"user"))!;
	const total=(kind:string)=>state.rules.filter(rule=>rule.kind===kind).length;
	const shadowed=state.files.some(file=>file.id===savedId&&file.exists&&!file.active);
	const muted=state.custom?" prompt-inactive":"";
	return <section className="system-prompt-panel" aria-label={t("settingsSystemPrompt")}>
		<header className="prompt-heading"><h2>{t("settingsSystemPrompt")}</h2><span className="prompt-token" title={t("promptTokenHint")}>{t("promptTokens",{n:state.tokens.toLocaleString()})}</span><div className="prompt-heading-actions"><button className="prompt-link" disabled={!!edit} onClick={()=>setRaw(!raw)}>{t(raw?"promptViewSections":"promptViewRaw")}</button><button onClick={()=>void copy()}>{copied?<FiCheck/>:<FiCopy/>}{t(copied?"promptCopied":"promptCopy")}</button></div></header>
		{(saved||state.pending)&&!state.reloadError&&<p className="prompt-save-status" role="status"><FiCheck/>{t(state.pending?"promptSavedPending":shadowed?"promptSavedShadowed":"promptSavedNext")}</p>}
		{error&&<p className="prompt-error" role="alert">{error}</p>}
		{state.reloadError&&<div className="prompt-error" role="alert">{t("promptReloadFailed")} {state.reloadError}<button disabled={busy} onClick={()=>void mutate("retry")}>{t("promptRetry")}</button></div>}
		{state.opaque?<><p className="prompt-warning">{t(state.forced?"promptForced":"promptOpaque")}</p><pre className="prompt-raw">{state.raw}</pre></>:raw?<pre className="prompt-raw">{state.raw}</pre>:<div className="prompt-sections">
			<div className={`prompt-section${edit?.file.kind==="system"?" prompt-editing":""}`}>
				<div className="prompt-section-line"><span className="prompt-label">{t("promptDefault")}</span><div className="prompt-summary"><button className="prompt-text-button" aria-expanded={preamble} onClick={()=>setPreamble(!preamble)}>{state.custom?t("promptReplaced"):t("promptBuiltinIdentity")}</button>{state.custom&&system&&<code className="prompt-file-path">{system.path}</code>}</div><div className="prompt-row-actions">{state.custom&&system?<><button disabled={busy||!system.editable} onClick={()=>open(system)}>{t("promptEdit")}</button><button disabled={busy||!system.editable} onClick={()=>void mutate("restore",system)}>{t("promptRestore")}</button></>:<button disabled={busy} onClick={()=>open(preferred("system"),true)}>{t("promptReplace")}</button>}</div></div>
				{preamble&&<pre className="prompt-section-text">{content("preamble")}</pre>}{editor("system")}
			</div>
			<div className={`prompt-section${muted}`}><div className="prompt-section-line"><span className="prompt-label">{t("promptTools")} · {state.tools.length}</span><div className="prompt-tool-list">{state.tools.map(tool=><code key={tool.name} className={tool.custom?"prompt-custom-tool":""} title={tool.path}>{tool.name}</code>)}</div><span className="prompt-auto">{t(state.custom?"promptInactive":"promptAutomatic")}</span></div></div>
			<div className={`prompt-section${muted}`}><div className="prompt-section-line"><span className="prompt-label">{t("promptRules")} · {state.rules.length}</span><div className="prompt-summary">{t("promptRuleSummary",{builtin:total("builtin"),tools:total("tool"),extensions:total("extension")+total("unknown")})}<button className="prompt-link" aria-expanded={rules} onClick={()=>setRules(!rules)}>{rules?<FiChevronDown/>:<FiChevronRight/>}{t(rules?"promptCollapse":"promptExpand")}</button></div><span className="prompt-auto">{t(state.custom?"promptInactive":"promptAutomatic")}</span></div>{rules&&<ul className="prompt-rules">{state.rules.map((rule,index)=><li key={index}><span className={`prompt-rule-origin prompt-rule-${rule.kind}`} title={rule.path}>{rule.name??t(rule.kind==="builtin"?"promptBuiltin":rule.kind==="extension"?"promptExtension":"promptRuntime")}</span><code>{rule.text}</code></li>)}</ul>}</div>
			<div className={`prompt-section${muted}`}><div className="prompt-section-line"><span className="prompt-label">{t("promptDocs")}</span><button className="prompt-text-button prompt-summary" aria-expanded={docs} onClick={()=>setDocs(!docs)}>{t("promptDocsSummary")}</button><span className="prompt-auto">{t(state.custom?"promptInactive":"promptAutomatic")}</span></div>{docs&&content("docs")&&<pre className="prompt-section-text">{content("docs")}</pre>}</div>
			<div className={`prompt-section${edit?.file.kind==="append"?" prompt-editing":""}`}><div className="prompt-section-line"><span className="prompt-label">{t("promptAppend")}</span><div className="prompt-summary">{append.length?append.map(file=><code className="prompt-file-path" key={file.id}>{file.path}</code>):<span className="prompt-muted">{content("addendum")?t("promptRuntime"):t("promptNotSet")}</span>}</div><div className="prompt-row-actions"><button disabled={busy||!(append[0]??preferred("append")).editable} onClick={()=>open(append[0]??preferred("append"))}>{t(append.length?"promptEdit":"promptAdd")}</button></div></div>{editor("append")}</div>
			<div className={`prompt-section${edit?.file.kind==="context"?" prompt-editing":""}`}><div className="prompt-section-line prompt-context-line"><span className="prompt-label">{t("promptContext")}</span><div className="prompt-context-files">{context.length?context.map(file=><div className="prompt-context-file" key={file.id}><code title={file.path}>{file.path}</code><span className="prompt-token" title={file.changedOnDisk?t("promptDiskChanged"):t("promptTokenHint")}>{file.tokens.toLocaleString()} tok{file.changedOnDisk?" *":""}</span><button className="prompt-link" disabled={busy||!file.editable} title={file.error} onClick={()=>open(file)}>{t("promptEdit")}</button></div>):<span className="prompt-muted">{t("promptNoContext")}</span>}</div></div>{editor("context")}</div>
			{state.sections.filter(section=>!["preamble","tools","rules","docs","addendum","project_context","skills","cwd"].includes(section.name)).map(section=><div className="prompt-section" key={section.name}><div className="prompt-section-line"><span className="prompt-label">{section.name}</span><span className="prompt-summary">{t("promptRuntimeSection")}</span><span className="prompt-auto">{t("promptAutomatic")}</span></div><pre className="prompt-section-text">{section.text}</pre></div>)}
		</div>}
		{!state.opaque&&<p className="prompt-footnote">{t("promptPriority")}{!state.trusted&&` ${t("promptProjectNotTrusted")}`}</p>}
	</section>;
}
