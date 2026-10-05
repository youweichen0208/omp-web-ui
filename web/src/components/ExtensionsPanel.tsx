import { ExtensionCatalogList, extensionResourceKeys } from "./ExtensionCatalogList";
import { extensionDownloads } from "../extensions-presentation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FiSearch, FiChevronDown, FiChevronRight, FiExternalLink, FiFolder, FiLock, FiX, FiDownload } from "react-icons/fi";
import { useI18n, useT } from "../i18n";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import { desktopAPI } from "../desktop";
import type { ExtensionCatalog, ExtensionJob, ExtensionOperation, ExtensionPackage, ExtensionPreview, ExtensionsState, ExtensionPackageDetails } from "../types";

async function request<T>(cwd: string, action: string, args: Record<string,unknown> = {}, signal?: AbortSignal): Promise<T> {
	const response = await fetch(withToken("/api/extensions"), { method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ ...args,clientId:getClientId(),cwd,action }),signal });
	const result = await response.json(); if (!response.ok) throw Error(result.error ?? response.statusText); return result;
}
export function ExtensionsPanel({ cwd, reload, onUpdateCount, mode = "manage", children }: { cwd: string; reload: () => void; onUpdateCount?: (count:number)=>void; mode?: "manage" | "updates"; children?: ReactNode }) {
	const t=useT(), {locale}=useI18n();
	const catalogDetails = useCallback((source: string, signal: AbortSignal) => request<ExtensionPackageDetails>(cwd, "details", { source }, signal), [cwd]);
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
	const dialogRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!installOpen && !confirm) return;
		const previous = document.activeElement;
		const dialog = dialogRef.current;
		const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? []);
		focusable()[0]?.focus();
		const trap = (event: KeyboardEvent) => {
			if (event.key !== "Tab") return;
			const items = focusable(), first = items[0], last = items.at(-1);
			if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
			else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
		};
		document.addEventListener("keydown", trap);
		return () => { document.removeEventListener("keydown", trap); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
	}, [installOpen, !!confirm]);
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
		const timer=setInterval(()=>void request<ExtensionJob>(cwd,"job",{id:job.id}).then(next=>{if(disposed)return;setJob(next);if(next.phase!=="running"){sessionStorage.removeItem(jobKey);setChanged(true);if(next.phase==="done"&&lastOperation.current?.action==="install"){setInstallOpen(false);setPreview(undefined);setTab("installed");setQuery("");}void load();}}).catch(e=>{if(!disposed)setError(e.message);}),800);
		return()=>{disposed=true;clearInterval(timer);};
	},[job?.id,job?.phase,cwd]);
	async function start(operation:ExtensionOperation,version=state?.version){
		if(!version)return;lastOperation.current=operation;if(operation.action==="install")pendingInstallName.current=preview?.name;setBusy(true);setError("");
		try{const next=await request<ExtensionJob>(cwd,"start",{operation,version});if(!mounted.current)return;setJob(next);sessionStorage.setItem(jobKey,next.id);setConfirm(undefined);if(operation.action!=="install"){setInstallOpen(false);setPreview(undefined);}}
		catch(e){setError((e as Error).message);}finally{setBusy(false);}
	}
	async function inspect(value:string){setBusy(true);setError("");try{const result=await request<ExtensionPreview>(cwd,"preview",{source:value});if(!mounted.current)return;setPreview(result);setJob(undefined);setSource(value);setInstallOpen(true);setPin(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
	async function open(item:ExtensionPackage){try{if(desktopAPI?.openExtensionPath)await desktopAPI.openExtensionPath({clientId:getClientId(),cwd,id:item.id});else{await navigator.clipboard.writeText(item.path??item.source);}}catch(e){setError((e as Error).message);}}
	const working=busy||job?.phase==="running";
	const updates=state?.packages.filter(p=>p.update && !p.protected)??[];
	useEffect(()=>onUpdateCount?.(updates.length),[updates.length,onUpdateCount]);
	const visible=state?.packages.filter(p=>(mode!=="updates" || p.kind!=="file" && !p.protected) && `${p.name} ${p.source}`.toLowerCase().includes(query.toLowerCase()))??[];
	useEffect(()=>{if(!expanded)return;let cancelled=false;setNotes(undefined);void request<{title:string;notes:string[];url?:string}>(cwd,"notes",{id:expanded}).then(value=>{if(!cancelled)setNotes(value);}).catch(()=>{});return()=>{cancelled=true;};},[expanded,cwd]);
	async function editFile(item:ExtensionPackage){try{const file=await request<{content:string;version:string}>(cwd,"file",{id:item.id});setEditor({...file,original:file.content,id:item.id,name:item.name});}catch(e){setError((e as Error).message);}}
	async function saveFile(){if(!editor)return;setBusy(true);try{await request(cwd,"save-file",{id:editor.id,version:editor.version,content:editor.content});setEditor(undefined);setChanged(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
	const resourceLabel=(key:string)=>key in extensionResourceKeys?t(extensionResourceKeys[key as keyof typeof extensionResourceKeys]):key;
	const counts=(item:ExtensionPackage)=>Object.entries(item.resources).filter(([,values])=>values.length).map(([key,values])=><span key={key}>{resourceLabel(key)} {values.length}</span>);
	function row(item:ExtensionPackage){
		const isOpen=expanded===item.id;
		return <article className={`ext-row${!item.enabled?" ext-disabled":""}`} key={item.id} data-extension-id={item.id}>
			<div className="ext-row-main">
				<button className="ext-expand" aria-label={`${t("extDetails")} ${item.name}`} aria-expanded={isOpen} onClick={()=>setExpanded(isOpen?undefined:item.id)}>{isOpen?<FiChevronDown/>:<FiChevronRight/>}</button>
				<div className="ext-row-info"><div className="ext-name"><strong>{item.name}</strong>{newId===item.id&&<span className="ext-new">{t("extNew")}</span>}</div><div className="ext-meta">{item.kind==="file"?<code title={item.path}>{item.path?.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/,"~")}</code>:<span>{item.kind} · {t(item.scope==="user"?"extPersonal":"extProject")}</span>}{!item.trusted&&<span className="ext-pin">{t("extUntrustedNotLoaded")}</span>}</div></div>
				{item.kind!=="file"&&<div className="ext-resource-counts">{counts(item)}</div>}
				{mode==="manage"&&item.kind==="file"&&<><button onClick={()=>void open(item)}>{t(desktopAPI?.openExtensionPath?"extOpen":"extCopyPath")}</button><button disabled={working} onClick={reload}>{t("extReload")}</button></>}
				<div className="ext-version">{mode==="manage"&&item.update&&!item.protected&&item.trusted&&!item.pinned?<button className="ext-version-update" disabled={working||checking} onClick={()=>void start({action:"update",id:item.id})}>{item.version}{item.latest&&` → ${item.latest}`} · {t("extUpdate")}</button>:<>{item.version??(item.kind==="git"?"git":"")}{item.latest&&item.update&&<span> → {item.latest}</span>}</>}{item.pinned&&<span className="ext-pin"><FiLock/>{t("extPinned")}</span>}</div>
				{mode==="updates"&&item.update&&!item.protected&&<button className="ext-update" disabled={working||checking} onClick={()=>void start({action:"update",id:item.id})}>{t("extUpdate")}</button>}
				{mode!=="updates"&&<input className="ext-switch" role="switch" type="checkbox" aria-label={`${t("extEnable")} ${item.name}`} checked={item.enabled} disabled={working||checking||!item.trusted||item.protected} onChange={e=>void start({action:"toggle",id:item.id,enabled:e.target.checked})}/>}
			</div>
			{isOpen&&<div className="ext-details"><p>{item.description??item.source}</p><code className="ext-source">{item.source}</code><div className="ext-actions">{item.kind==="file"&&<button disabled={working||!item.trusted} onClick={()=>void editFile(item)}>{t("extEditFile")}</button>}
				{item.kind==="npm"&&<a href={`https://pi.dev/packages/${item.name}`} target="_blank" rel="noreferrer"><FiExternalLink/>pi.dev</a>}
				{item.path&&<button onClick={()=>void open(item)}><FiFolder/>{t(desktopAPI?.openExtensionPath?"extOpen":"extCopyPath")}</button>}
				{item.pinned&&<button disabled={working||checking||!item.trusted||item.protected} onClick={()=>setConfirm({operation:{action:"unpin",id:item.id},name:item.name})}>{t("extUnpin")}</button>}
				{item.kind!=="file"&&<><button disabled={working||checking||!state?.trusted||item.protected} onClick={()=>setConfirm({operation:{action:"move",id:item.id},name:item.name})}>{t(item.scope==="user"?"extMoveProject":"extMovePersonal")}</button><button className="ext-danger" disabled={working||checking||!item.trusted||item.protected} onClick={()=>setConfirm({operation:{action:"remove",id:item.id},name:item.name})}>{t(item.kind==="local"?"extRemoveReference":"extUninstall")}</button></>}
			</div>{notes&&<div className="ext-release-notes"><strong>{t("extReleaseNotes")} {notes.title}</strong>{notes.notes.length?<ul>{notes.notes.map((line,i)=><li key={i}>{line}</li>)}</ul>:<p>{t("extNoNotes")}</p>}{notes.url&&<a href={notes.url} target="_blank" rel="noreferrer">{t("extViewNotes")} ↗</a>}</div>}{Object.entries(item.resources).some(([,v])=>v.length>0)&&<details><summary>{t("extResources")}</summary>{Object.entries(item.resources).filter(([,v])=>v.length).map(([key,values])=><div key={key}><strong>{resourceLabel(key)}</strong><pre>{values.join("\n")}</pre></div>)}</details>}<p className="ext-muted">{t("extResourceConfig")}</p></div>}
		</article>;
	}
	return <section className={`extensions-panel ${mode==="manage"?"extensions-v3":""}`}>
		<header className="ext-header"><h2>{mode==="updates"?t("componentUpdates"):"Extensions"}</h2>{mode==="updates"&&<span className="settings-count">{state?.checkedAt?t("v2LastChecked",{time:new Date(state.checkedAt).toLocaleDateString()===new Date().toLocaleDateString()?new Date(state.checkedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}):new Date(state.checkedAt).toLocaleDateString([], {month:"short",day:"numeric"})}):t("extNotChecked")}</span>}<div className="settings-heading-actions">{mode==="updates"?<button disabled={checking||working} onClick={()=>void load(true)}>{t(checking?"extChecking":"settingsCheckNow")}</button>:<button disabled={working} onClick={()=>{setSource("");setPreview(undefined);setJob(undefined);setError("");setInstallOpen(true);}}>{t("extInstallSource")}</button>}</div></header>
		{mode==="manage"&&<div className="ext-v3-tabs" role="tablist" aria-label="Extensions">{(["installed","browse"] as const).map(value=><button key={value} role="tab" tabIndex={tab===value?0:-1} onKeyDown={e=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(e.key)){e.preventDefault();const next=e.key==="Home"?"installed":e.key==="End"?"browse":value==="installed"?"browse":"installed";setTab(next);setQuery("");setPage(1);(e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next==="installed"?0:1])?.focus();}}} aria-selected={tab===value} onClick={()=>{setTab(value);setQuery("");setPage(1);}}>{value==="installed"?`${t("extInstalled")} · ${state?.packages.filter(p=>p.kind!=="file").length??0}`:t("extBrowse")}</button>)}</div>}
		{children}
		{error&&!installOpen&&<div className="ext-error" role="alert">{error}<button onClick={()=>void load()}>{t("extRefresh")}</button></div>}
		{job&&!installOpen&&<div className={`ext-job ${job.phase==="error"?"ext-error":""}`} role="status"><div><strong>{t(job.phase==="running"?"extRunning":job.phase==="done"?"extDone":"extFailed")}</strong><button onClick={()=>setShowLog(!showLog)}>{t("extLog")}</button></div>{job.error&&<p>{job.error}</p>}{job.phase==="error"&&lastOperation.current&&<button disabled={working} onClick={()=>lastOperation.current?.action==="install"?void inspect(source):void start(lastOperation.current!)}>{t("extRetry")}</button>}<pre>{showLog?job.log:job.log.split("\n").filter(Boolean).slice(-3).join("\n")}</pre></div>}
		{changed&&<div className="ext-notice">{t("extReloadHint")} <button disabled={working} onClick={()=>{reload();setChanged(false);}}>{t("extReload")}</button></div>}
		{tab==="installed"?<>
			{mode==="updates"&&updates.length>0&&<div className="ext-update-banner"><FiDownload/><div><strong>{updates.length} {t("extUpdatesAvailable")}</strong><p>{updates.map(p=>p.name).join(" · ")}</p></div><button className="ext-primary" disabled={working||checking} onClick={()=>setConfirm({operation:{action:"update-all"},name:updates.map(p=>p.name).join(", ")})}>{t("extUpdateAll")}</button></div>}

			{!state?<p className="ext-empty">{t("loading")}</p>:<><h3 className="settings-group-title">{t("settingsPackages")}<small>{t("v2PackagesHint")}</small></h3><div className="ext-list">{visible.filter(p=>p.kind!=="file").map(row)}{!visible.some(p=>p.kind!=="file")&&<div className="settings-empty"><p>{t("v2NoPackages")}</p>{mode==="manage"&&<button onClick={()=>setTab("browse")}>{t("extBrowse")}</button>}</div>}</div>{mode==="manage"&&visible.some(p=>p.kind==="file")&&<><h3 className="ext-group-title">{t("extSingleFiles")}<small>{t("v2FilesHint")}</small></h3><div className="ext-list">{visible.filter(p=>p.kind==="file").map(row)}</div></>}</>}
			{mode==="updates"&&<><h3 className="settings-group-title">{t("v2UpdatePolicy")}</h3><div className="settings-group"><label className="settings-list-row"><span>{t("settingsAutoCheck")}<small className="settings-description">{t("v2AutoCheckHint")}</small></span><input className="settings-switch" role="switch" type="checkbox" aria-label={t("settingsAutoCheck")} disabled={!state||working} checked={auto} onChange={e=>{const enabled=e.target.checked;setAuto(enabled);void request(cwd,"preferences",{enabled}).catch(error=>{setAuto(!enabled);setError(error.message);});}}/></label><div className="settings-list-row"><span>{t("v2InstallPolicy")}<small className="settings-description">{t("v2InstallHint")}</small></span><span className="settings-readonly">{t("v2ManualInstall")}</span></div></div></>}

		</>:<>
			<div className="ext-filters"><label className="ext-search"><FiSearch/><input type="search" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}} placeholder={t("extSearch")} aria-label={t("extSearch")}/></label><div className="ext-type-filters">{["","extension","skill","prompt","theme"].map(value=><button key={value} aria-pressed={type===value} onClick={()=>{setType(value);setPage(1);}}>{value?resourceLabel(`${value}s`):t("extAllTypes")}</button>)}</div><select aria-label={t("extSort")} value={sort} onChange={e=>{setSort(e.target.value);setPage(1);}}><option value="downloads">{t("extPopular")}</option><option value="recent">{t("extRecent")}</option></select></div>
			{searching?<p className="ext-empty" role="status">{t("loading")}</p>:<ExtensionCatalogList catalog={catalog} packages={state?.packages??[]} working={working||checking||!state} inspect={value=>void inspect(value)} update={item=>void start({action:"update",id:item.id})} details={catalogDetails}/>}
			{catalog&&!catalog.items.length&&<p className="ext-empty">{t("extNoResults")}</p>}{catalog&&<div className="ext-pagination"><button disabled={page<=1} onClick={()=>setPage(page-1)}>{t("extPrevious")}</button><span>{page} / {catalog.pages}</span><button disabled={page>=catalog.pages} onClick={()=>setPage(page+1)}>{t("extNext")}</button></div>}
		</>}
		{editor&&<div className="ext-dialog-backdrop"><div className="ext-dialog ext-editor" data-dirty={editor.content!==editor.original} role="dialog" aria-modal="true" aria-label={t("extEditFile")} onKeyDown={e=>{if(e.key==="Escape")e.stopPropagation();}}><header><h3>{editor.name}</h3></header><textarea aria-label={t("extEditFile")} value={editor.content} onChange={e=>setEditor({...editor,content:e.target.value})} spellCheck={false}/><p>{t("extEditHint")}</p>{error&&<p role="alert" className="ext-error">{error}</p>}<footer><button disabled={busy} onClick={()=>{if(editor.content===editor.original||window.confirm(t("extDiscard")))setEditor(undefined);}}>{t("extCancel")}</button><button className="ext-primary" disabled={busy} onClick={()=>void saveFile()}>{t("extSaveFile")}</button></footer></div></div>}

		{(installOpen||confirm)&&<div className="ext-dialog-backdrop" onClick={()=>{if(!busy){setInstallOpen(false);setConfirm(undefined);}}}><div ref={dialogRef} className="ext-dialog" role="dialog" aria-modal="true" aria-label={t(installOpen?"extInstall":"extConfirm")} onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==="Escape"){e.stopPropagation();setInstallOpen(false);setConfirm(undefined);}}}><header><h3>{t(installOpen?"extInstall":"extConfirm")}{installOpen&&preview&&<> <code>{preview.name}</code></>}</h3><button aria-label={t("close")} onClick={()=>{setInstallOpen(false);setConfirm(undefined);}}><FiX/></button></header>
			{installOpen?<>{!preview?<form onSubmit={e=>{e.preventDefault();void inspect(source);}}><label>{t("extSource")}<input autoFocus value={source} onChange={e=>setSource(e.target.value)} placeholder="npm:@scope/name · git:github.com/owner/repo · ./local-path"/></label><button className="ext-primary" disabled={busy||!source.trim()} type="submit">{t("extReview")}</button></form>:<><p className="ext-install-meta">{[preview.author,preview.version&&`v${preview.version}`,catalog?.items.find(item=>item.name===preview.name)?.downloads!==undefined?extensionDownloads(catalog.items.find(item=>item.name===preview.name)?.downloads,locale):undefined].filter(Boolean).join(" · ")}</p><div className="ext-preview-resources"><strong>{t("extWillLoad")}</strong>{Object.keys(preview.resources).length?Object.entries(preview.resources).map(([key,values])=><p key={key}><span>{resourceLabel(key)}</span><code>{values.join(", ")||t("extNoneDeclared")}</code></p>):<p>{t("extResourcesUnknown")}</p>}</div><div className="ext-install-scope"><strong>{t("extScope")}</strong><div className="ext-scope-segments">{(["user","project"] as const).map(scope=><button key={scope} aria-pressed={installScope===scope} disabled={working||scope==="project"&&!state?.trusted} onClick={()=>setInstallScope(scope)}>{t(scope==="user"?"extPersonal":"extInstallProject")}</button>)}</div><code>{installScope==="user"?"~/.pi/agent/settings.json":".pi/settings.json"}</code>{!state?.trusted&&<small>{t("extProjectUntrusted")}</small>}</div>{preview.canPin&&<label className="ext-auto"><input type="checkbox" checked={pin} disabled={working} onChange={e=>setPin(e.target.checked)}/>{t("extPinVersion")} {preview.version}</label>}<p className="ext-security">{t("extSecurity")}</p><code className="ext-command">pi install {pin&&preview.canPin?`${preview.source.replace(/^(npm:(?:@[^/]+\/)?[^@]+)(?:@.*)?$/, "$1")}@${preview.version}`:preview.source}{installScope==="project"?" --local":""}</code><footer>{preview.repository&&<a href={preview.repository} target="_blank" rel="noreferrer">{t("extViewSource")} ↗</a>}<button onClick={()=>setInstallOpen(false)}>{t("extCancel")}</button><button className="ext-primary" disabled={working||checking} onClick={()=>void (async()=>{if(job?.phase==="error"||error){setBusy(true);try{const [fresh,current]=await Promise.all([request<ExtensionPreview>(cwd,"preview",{source:preview.source}),request<ExtensionsState>(cwd,"list")]);if(!mounted.current)return;setPreview(fresh);setState(current);await start({action:"install",ticket:fresh.ticket,scope:installScope,pin},current.version);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}else await start({action:"install",ticket:preview.ticket,scope:installScope,pin});})()}>{t(job?.phase==="running"?"extInstalling":job?.phase==="error"||error?"extRetry":"extInstall")}</button></footer></>}</>:<><p>{confirm?.name}</p><p>{t(confirm?.operation.action==="remove"?"extRemoveHint":confirm?.operation.action==="move"?"extMoveHint":confirm?.operation.action==="unpin"?"extUnpinHint":"extUpdateHint")}</p><footer><button onClick={()=>setConfirm(undefined)}>{t("extCancel")}</button><button className="ext-primary" disabled={busy||checking} onClick={()=>confirm&&void start(confirm.operation)}>{t("extConfirm")}</button></footer></>}
			{job?.phase==="error"&&installOpen&&<pre className="ext-install-error" role="alert">{[job.error,job.log.split("\n").filter(Boolean).slice(-3).join("\n")].filter(Boolean).join("\n")}</pre>}{error&&<p className="ext-error" role="alert">{error}</p>}
		</div></div>}
	</section>;
}
