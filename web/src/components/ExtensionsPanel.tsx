import { useEffect, useRef, useState } from "react";
import { FiPackage, FiSearch, FiPlus, FiChevronDown, FiChevronRight, FiRefreshCw, FiExternalLink, FiFolder, FiLock, FiX, FiDownload } from "react-icons/fi";
import { useT } from "../i18n";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import { desktopAPI } from "../desktop";
import type { ExtensionCatalog, ExtensionJob, ExtensionOperation, ExtensionPackage, ExtensionPreview, ExtensionsState } from "../types";

async function request<T>(cwd: string, action: string, args: Record<string,unknown> = {}, signal?: AbortSignal): Promise<T> {
	const response = await fetch(withToken("/api/extensions"), { method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ ...args,clientId:getClientId(),cwd,action }),signal });
	const result = await response.json(); if (!response.ok) throw Error(result.error ?? response.statusText); return result;
}
export function ExtensionsPanel({ cwd, reload, onUpdateCount }: { cwd: string; reload: () => void; onUpdateCount?: (count:number)=>void }) {
	const t=useT();
	const [state,setState]=useState<ExtensionsState>();
	const [tab,setTab]=useState<"installed"|"browse">("installed");
	const [query,setQuery]=useState(""), [type,setType]=useState(""), [sort,setSort]=useState("downloads"), [page,setPage]=useState(1);
	const [catalog,setCatalog]=useState<ExtensionCatalog>();
	const [expanded,setExpanded]=useState<string>();
	const pendingInstallName=useRef<string>();
	const [newId,setNewId]=useState<string>();
	const [notes,setNotes]=useState<{title:string;notes:string[];url?:string}>();
	const [editor,setEditor]=useState<{id:string;name:string;content:string;original:string;version:string}>();
	const [error,setError]=useState(""),[busy,setBusy]=useState(false),[searching,setSearching]=useState(false),[checking,setChecking]=useState(false);
	const [source,setSource]=useState(""),[installOpen,setInstallOpen]=useState(false),[preview,setPreview]=useState<ExtensionPreview>();
	const [installScope,setInstallScope]=useState<"user"|"project">("user"),[pin,setPin]=useState(false);
	const [confirm,setConfirm]=useState<{ operation:ExtensionOperation; name:string }>();
	const lastOperation=useRef<ExtensionOperation>();
	const [job,setJob]=useState<ExtensionJob>(),[showLog,setShowLog]=useState(false),[changed,setChanged]=useState(false);
	const [auto,setAuto]=useState(()=>localStorage.getItem("pi-extensions-autocheck")!=="false");
	const mounted=useRef(true), loadSequence=useRef(0);
	useEffect(()=>{if(!editor||editor.content===editor.original)return;const prevent=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue="";};window.addEventListener("beforeunload",prevent);return()=>window.removeEventListener("beforeunload",prevent);},[editor]);
	const jobKey=`pi-extensions-job:${cwd}`;
	async function load(check=false) {
		const sequence=++loadSequence.current; if(check)setChecking(true);
		try { const next=await request<ExtensionsState>(cwd,check?"check":"list"); if(mounted.current && sequence===loadSequence.current) { setState(next);const installed=pendingInstallName.current&&next.packages.find(p=>p.name===pendingInstallName.current);if(installed){setExpanded(installed.id);setNewId(installed.id);pendingInstallName.current=undefined;}if(next.autoCheck!==undefined)setAuto(next.autoCheck);setError(""); } }
		catch(e){if(mounted.current)setError((e as Error).message);} finally {if(mounted.current)setChecking(false);}
	}
	useEffect(()=>{ mounted.current=true; void load(); const saved=sessionStorage.getItem(jobKey); if(saved) void request<ExtensionJob>(cwd,"job",{id:saved}).then(setJob).catch(()=>sessionStorage.removeItem(jobKey)); return()=>{mounted.current=false;}; },[cwd]);
	useEffect(()=>{if(!auto||!state||job?.phase==="running")return; const delay=Math.max(0,(state.checkedAt??0)+6*60*60*1000-Date.now()); const timer=setTimeout(()=>void load(true),delay);return()=>clearTimeout(timer);},[auto,state?.checkedAt,!!state,job?.phase]);
	useEffect(()=>{
		if(tab!=="browse")return; const abort=new AbortController(); setSearching(true); setCatalog(undefined);
		const timer=setTimeout(()=>void request<ExtensionCatalog>(cwd,"search",{query,type,sort,page},abort.signal).then(value=>{setCatalog(value);setError("");}).catch(e=>{if(!abort.signal.aborted)setError(e.message);}).finally(()=>{if(!abort.signal.aborted)setSearching(false);}),300);
		return()=>{clearTimeout(timer);abort.abort();};
	},[cwd,tab,query,type,sort,page]);
	useEffect(()=>{
		if(job?.phase!=="running")return; let disposed=false;
		const timer=setInterval(()=>void request<ExtensionJob>(cwd,"job",{id:job.id}).then(next=>{if(disposed)return;setJob(next);if(next.phase!=="running"){sessionStorage.removeItem(jobKey);setChanged(true);void load();}}).catch(e=>{if(!disposed)setError(e.message);}),800);
		return()=>{disposed=true;clearInterval(timer);};
	},[job?.id,job?.phase,cwd]);
	async function start(operation:ExtensionOperation){
		if(!state)return;lastOperation.current=operation;if(operation.action==="install")pendingInstallName.current=preview?.name;setBusy(true);setError("");
		try{const next=await request<ExtensionJob>(cwd,"start",{operation,version:state.version});setJob(next);sessionStorage.setItem(jobKey,next.id);setConfirm(undefined);setInstallOpen(false);setPreview(undefined);setTab("installed");}
		catch(e){setError((e as Error).message);}finally{setBusy(false);}
	}
	async function inspect(value:string){setBusy(true);setError("");try{setPreview(await request<ExtensionPreview>(cwd,"preview",{source:value}));setSource(value);setInstallOpen(true);setPin(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
	async function open(item:ExtensionPackage){try{if(desktopAPI?.openExtensionPath)await desktopAPI.openExtensionPath({clientId:getClientId(),cwd,id:item.id});else{await navigator.clipboard.writeText(item.path??item.source);}}catch(e){setError((e as Error).message);}}
	const working=busy||job?.phase==="running";
	const updates=state?.packages.filter(p=>p.update)??[];
	useEffect(()=>onUpdateCount?.(updates.length),[updates.length,onUpdateCount]);
	const visible=state?.packages.filter(p=>`${p.name} ${p.source}`.toLowerCase().includes(query.toLowerCase()))??[];
	useEffect(()=>{if(!expanded)return;let cancelled=false;setNotes(undefined);void request<{title:string;notes:string[];url?:string}>(cwd,"notes",{id:expanded}).then(value=>{if(!cancelled)setNotes(value);}).catch(()=>{});return()=>{cancelled=true;};},[expanded,cwd]);
	async function editFile(item:ExtensionPackage){try{const file=await request<{content:string;version:string}>(cwd,"file",{id:item.id});setEditor({...file,original:file.content,id:item.id,name:item.name});}catch(e){setError((e as Error).message);}}
	async function saveFile(){if(!editor)return;setBusy(true);try{await request(cwd,"save-file",{id:editor.id,version:editor.version,content:editor.content});setEditor(undefined);setChanged(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
	const counts=(item:ExtensionPackage)=>Object.entries(item.resources).filter(([,values])=>values.length).map(([key,values])=><span key={key}>{values.length} {key}</span>);
	function row(item:ExtensionPackage){
		const isOpen=expanded===item.id;
		return <article className={`ext-row${!item.enabled?" ext-disabled":""}`} key={item.id} data-extension-id={item.id}>
			<div className="ext-row-main">
				<button className="ext-expand" aria-label={`${t("extDetails")} ${item.name}`} aria-expanded={isOpen} onClick={()=>setExpanded(isOpen?undefined:item.id)}>{isOpen?<FiChevronDown/>:<FiChevronRight/>}</button>
				<div className="ext-avatar">{item.kind==="file"?<FiPackage/>:item.name.replace(/^@/,"").slice(0,2).toUpperCase()}</div>
				<div className="ext-row-info"><div className="ext-name"><strong>{item.name}</strong>{newId===item.id&&<span className="ext-new">{t("extNew")}</span>}<span className="ext-badge">{item.kind}</span><span className="ext-badge">{t(item.scope==="user"?"extPersonal":"extProject")}</span>{!item.trusted&&<span className="ext-pin">{t("extUntrusted")}</span>}</div><div className="ext-meta">{item.kind==="file"?<code title={item.path}>{item.path}</code>:counts(item)}</div></div>
				<div className="ext-version">{item.version??(item.kind==="git"?"git":"")}{item.latest&&item.update&&<span> → {item.latest}</span>}{item.pinned&&<span className="ext-pin"><FiLock/>{t("extPinned")}</span>}</div>
				{item.update&&<button className="ext-update" disabled={working||checking} onClick={()=>void start({action:"update",id:item.id})}>{t("extUpdate")}</button>}
				<input className="ext-switch" role="switch" type="checkbox" aria-label={`${t("extEnable")} ${item.name}`} checked={item.enabled} disabled={working||checking||!item.trusted||item.protected} onChange={e=>void start({action:"toggle",id:item.id,enabled:e.target.checked})}/>
			</div>
			{isOpen&&<div className="ext-details"><p>{item.description??item.source}</p><code className="ext-source">{item.source}</code><div className="ext-actions">{item.kind==="file"&&<button disabled={working||!item.trusted} onClick={()=>void editFile(item)}>{t("extEditFile")}</button>}
				{item.kind==="npm"&&<a href={`https://pi.dev/packages/${item.name}`} target="_blank" rel="noreferrer"><FiExternalLink/>pi.dev</a>}
				{item.path&&<button onClick={()=>void open(item)}><FiFolder/>{t(desktopAPI?.openExtensionPath?"extOpen":"extCopyPath")}</button>}
				{item.pinned&&<button disabled={working||checking||!item.trusted||item.protected} onClick={()=>setConfirm({operation:{action:"unpin",id:item.id},name:item.name})}>{t("extUnpin")}</button>}
				{item.kind!=="file"&&<><button disabled={working||checking||!state?.trusted||item.protected} onClick={()=>setConfirm({operation:{action:"move",id:item.id},name:item.name})}>{t(item.scope==="user"?"extMoveProject":"extMovePersonal")}</button><button className="ext-danger" disabled={working||checking||!item.trusted||item.protected} onClick={()=>setConfirm({operation:{action:"remove",id:item.id},name:item.name})}>{t(item.kind==="local"?"extRemoveReference":"extUninstall")}</button></>}
			</div>{notes&&<div className="ext-release-notes"><strong>{t("extReleaseNotes")} {notes.title}</strong>{notes.notes.length?<ul>{notes.notes.map((line,i)=><li key={i}>{line}</li>)}</ul>:<p>{t("extNoNotes")}</p>}{notes.url&&<a href={notes.url} target="_blank" rel="noreferrer">{t("extViewNotes")} ↗</a>}</div>}{Object.entries(item.resources).some(([,v])=>v.length>0)&&<details><summary>{t("extResources")}</summary>{Object.entries(item.resources).filter(([,v])=>v.length).map(([key,values])=><div key={key}><strong>{key}</strong><pre>{values.join("\n")}</pre></div>)}</details>}<p className="ext-muted">{t("extResourceConfig")}</p></div>}
		</article>;
	}
	return <section className="extensions-panel">
		<header className="ext-header"><h2>Extensions</h2><span className="settings-count">{state?.packages.length ?? 0}</span><div className="settings-heading-actions"><button onClick={()=>{setTab(tab==="installed"?"browse":"installed");setQuery("");setPage(1);}}>{t(tab==="installed"?"extBrowse":"extInstalled")}</button><button className="ext-primary" disabled={working} onClick={()=>{setSource("");setPreview(undefined);setInstallOpen(true);}}>{t("extInstall")}</button></div></header>
		{error&&<div className="ext-error" role="alert">{error}<button onClick={()=>void load()}>{t("extRefresh")}</button></div>}
		{job&&<div className={`ext-job ${job.phase==="error"?"ext-error":""}`} role="status"><div><strong>{t(job.phase==="running"?"extRunning":job.phase==="done"?"extDone":"extFailed")}</strong><button onClick={()=>setShowLog(!showLog)}>{t("extLog")}</button></div>{job.error&&<p>{job.error}</p>}{job.phase==="error"&&lastOperation.current&&<button disabled={working} onClick={()=>lastOperation.current?.action==="install"?void inspect(source):void start(lastOperation.current!)}>{t("extRetry")}</button>}<pre>{showLog?job.log:job.log.split("\n").filter(Boolean).slice(-3).join("\n")}</pre></div>}
		{changed&&<div className="ext-notice">{t("extReloadHint")} <button disabled={working} onClick={()=>{reload();setChanged(false);}}>{t("extReload")}</button></div>}
		{tab==="installed"?<>
			{updates.length>0&&<div className="ext-update-banner"><FiDownload/><div><strong>{updates.length} {t("extUpdatesAvailable")}</strong><p>{updates.map(p=>p.name).join(" · ")}</p></div><button className="ext-primary" disabled={working||checking} onClick={()=>setConfirm({operation:{action:"update-all"},name:updates.map(p=>p.name).join(", ")})}>{t("extUpdateAll")}</button></div>}

			{!state?<p className="ext-empty">{t("loading")}</p>:!visible.length?<div className="ext-empty"><FiPackage/><p>{t("extEmpty")}</p><button onClick={()=>setTab("browse")}>{t("extBrowse")}</button></div>:<><h3 className="settings-group-title">{t("settingsPackages")}</h3><div className="ext-list">{visible.filter(p=>p.kind!=="file").map(row)}</div>{visible.some(p=>p.kind==="file")&&<><h3 className="ext-group-title">{t("extSingleFiles")}</h3><div className="ext-list">{visible.filter(p=>p.kind==="file").map(row)}</div></>}</>}
			<h3 className="settings-group-title">{t("settingsUpdates")}</h3><div className="settings-group"><label className="ext-auto"><span>{t("settingsAutoCheck")}</span><small>{state?.checkedAt?new Date(state.checkedAt).toLocaleString():t("extNotChecked")}</small><input className="settings-switch" role="switch" type="checkbox" checked={auto} onChange={e=>{const enabled=e.target.checked;setAuto(enabled);localStorage.setItem("pi-extensions-autocheck",String(enabled));void request(cwd,"preferences",{enabled}).catch(error=>{setAuto(!enabled);setError(error.message);});}}/></label><div className="settings-list-row"><span>{t("extCheck")}</span><button disabled={checking||working} onClick={()=>void load(true)}>{t(checking?"extChecking":"settingsCheckNow")}</button></div></div>
		</>:<>
			<div className="ext-filters"><label className="ext-search"><FiSearch/><input type="search" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}} placeholder={t("extSearch")} aria-label={t("extSearch")}/></label><select aria-label={t("extSort")} value={sort} onChange={e=>{setSort(e.target.value);setPage(1);}}><option value="downloads">{t("extPopular")}</option><option value="recent">{t("extRecent")}</option></select></div>
			<div className="ext-type-filters">{["","extension","skill","prompt","theme"].map(value=><button key={value} aria-pressed={type===value} onClick={()=>{setType(value);setPage(1);}}>{value||t("extAllTypes")}</button>)}<a href="https://pi.dev/packages" target="_blank" rel="noreferrer">pi.dev ↗</a></div>
			{searching?<p className="ext-empty">{t("loading")}</p>:<div className="ext-catalog">{catalog?.items.map(item=>{const installed=state?.packages.find(p=>p.kind==="npm"&&p.name===item.name);return <article className="ext-catalog-card" key={item.name}>{item.image&&<img loading="lazy" src={item.image} alt="" referrerPolicy="no-referrer"/>}<div className="ext-card-heading"><div className="ext-avatar">{item.name.replace(/^@/,"").slice(0,2).toUpperCase()}</div><div><a href={item.url} target="_blank" rel="noreferrer"><strong>{item.name}</strong></a><small>{item.author} {item.version&&`· v${item.version}`}</small></div></div><p>{item.description}</p><div className="ext-card-types">{item.types.map(value=><span className="ext-badge" key={value}>{value}</span>)}</div><footer><span>{(item.downloads??0).toLocaleString()} {t("extDownloads")}{item.date&&<small>{new Date(item.date).toLocaleDateString()}</small>}</span><button className={installed?"":"ext-primary"} disabled={working||!!installed&&!installed.update} onClick={()=>installed?void start({action:"update",id:installed.id}):void inspect(`npm:${item.name}`)}>{t(installed?(installed.update?"extUpdate":"extInstalled"):"extInstall")}</button></footer></article>;})}</div>}
			{catalog&&!catalog.items.length&&<p className="ext-empty">{t("extNoResults")}</p>}{catalog&&<div className="ext-pagination"><button disabled={page<=1} onClick={()=>setPage(page-1)}>{t("extPrevious")}</button><span>{page} / {catalog.pages}</span><button disabled={page>=catalog.pages} onClick={()=>setPage(page+1)}>{t("extNext")}</button></div>}
		</>}
		{editor&&<div className="ext-dialog-backdrop"><div className="ext-dialog ext-editor" data-dirty={editor.content!==editor.original} role="dialog" aria-modal="true" aria-label={t("extEditFile")} onKeyDown={e=>{if(e.key==="Escape")e.stopPropagation();}}><header><h3>{editor.name}</h3></header><textarea aria-label={t("extEditFile")} value={editor.content} onChange={e=>setEditor({...editor,content:e.target.value})} spellCheck={false}/><p>{t("extEditHint")}</p>{error&&<p role="alert" className="ext-error">{error}</p>}<footer><button disabled={busy} onClick={()=>{if(editor.content===editor.original||window.confirm(t("extDiscard")))setEditor(undefined);}}>{t("extCancel")}</button><button className="ext-primary" disabled={busy} onClick={()=>void saveFile()}>{t("extSaveFile")}</button></footer></div></div>}

		{(installOpen||confirm)&&<div className="ext-dialog-backdrop" onClick={()=>{if(!busy){setInstallOpen(false);setConfirm(undefined);}}}><div className="ext-dialog" role="dialog" aria-modal="true" aria-label={t(installOpen?"extInstall":"extConfirm")} onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==="Escape"){e.stopPropagation();setInstallOpen(false);setConfirm(undefined);}}}><header><h3>{t(installOpen?"extInstall":"extConfirm")}</h3><button aria-label={t("close")} onClick={()=>{setInstallOpen(false);setConfirm(undefined);}}><FiX/></button></header>
			{installOpen?<>{!preview?<form onSubmit={e=>{e.preventDefault();void inspect(source);}}><label>{t("extSource")}<input autoFocus value={source} onChange={e=>setSource(e.target.value)} placeholder="npm:@scope/name · git:github.com/owner/repo · ./local-path"/></label><button className="ext-primary" disabled={busy||!source.trim()} type="submit">{t("extReview")}</button></form>:<><h4>{preview.name} {preview.version&&<span>v{preview.version}</span>}</h4><p>{preview.description}</p><code className="ext-source">{preview.source}</code>{preview.author&&<p>{preview.author}</p>}<div className="ext-preview-resources"><strong>{t("extResources")}</strong>{Object.keys(preview.resources).length?Object.entries(preview.resources).map(([key,values])=><p key={key}>{key}: {values.join(", ")}</p>):<p>{t("extResourcesUnknown")}</p>}</div><label>{t("extScope")}<select value={installScope} onChange={e=>setInstallScope(e.target.value as "user"|"project")}><option value="user">{t("extPersonal")}</option><option value="project" disabled={!state?.trusted}>{t("extProject")}{!state?.trusted?` · ${t("extUntrusted")}`:""}</option></select></label>{preview.canPin&&<label className="ext-auto"><input type="checkbox" checked={pin} onChange={e=>setPin(e.target.checked)}/>{t("extPinVersion")} {preview.version}</label>}<p className="ext-security">{t("extSecurity")}</p><code className="ext-command">pi install {pin&&preview.canPin?`${preview.source.replace(/^(npm:(?:@[^/]+\/)?[^@]+)(?:@.*)?$/, "$1")}@${preview.version}`:preview.source}{installScope==="project"?" --local":""}</code><footer>{preview.repository&&<a href={preview.repository} target="_blank" rel="noreferrer">{t("extViewSource")} ↗</a>}<button onClick={()=>setInstallOpen(false)}>{t("extCancel")}</button><button className="ext-primary" disabled={busy||checking} onClick={()=>void start({action:"install",ticket:preview.ticket,scope:installScope,pin})}>{t("extInstall")}</button></footer></>}</>:<><p>{confirm?.name}</p><p>{t(confirm?.operation.action==="remove"?"extRemoveHint":confirm?.operation.action==="move"?"extMoveHint":confirm?.operation.action==="unpin"?"extUnpinHint":"extUpdateHint")}</p><footer><button onClick={()=>setConfirm(undefined)}>{t("extCancel")}</button><button className="ext-primary" disabled={busy||checking} onClick={()=>confirm&&void start(confirm.operation)}>{t("extConfirm")}</button></footer></>}
			{error&&<p className="ext-error" role="alert">{error}</p>}
		</div></div>}
	</section>;
}
