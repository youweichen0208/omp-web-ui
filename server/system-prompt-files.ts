import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PromptFileView, SystemPromptState } from "./protocol.js";
import { promptView, estimatePromptTokens } from "./system-prompt-view.js";
const LIMIT=512*1024;
const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
/** Include the canonical target in CAS, so changing a symlink cannot redirect an outstanding edit. */
function read(path:string) {
	if(!existsSync(path)) { if(lstatMissing(path))return {content:"",version:hash(`missing:${canonicalParent(path)}`),exists:false}; throw Error("Broken symlink"); }
	const target=realpathSync(path),info=statSync(target);if(!info.isFile()||info.size>LIMIT)throw Error("Prompt file must be text and at most 512 KB");
	const data=readFileSync(target);const content=new TextDecoder("utf-8",{fatal:true}).decode(data);
	return {content,version:hash(Buffer.concat([Buffer.from(`${target}\0`),data])),exists:true};
}
function lstatMissing(path:string){try{lstatSync(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return true;throw e;}}
function canonicalParent(path:string):string { let parent=dirname(path), suffix=path.slice(parent.length);while(!existsSync(parent)){const previous=parent;parent=dirname(parent);suffix=previous.slice(parent.length)+suffix;}return realpathSync(parent)+suffix; }
function catalog(session:AgentSession,cwd:string,agentDir:string):PromptFileView[] {
	const loader=session.resourceLoader, files:PromptFileView[]=[];
	const systemPath=loader.getSystemPromptSource()?.path, appendPaths=loader.getAppendSystemPromptSources().map(f=>resolve(f.path));
	for(const scope of ["user","project"] as const)for(const kind of ["system","append"] as const){
		const path=join(scope==="user"?agentDir:join(cwd,".pi"),kind==="system"?"SYSTEM.md":"APPEND_SYSTEM.md");
		files.push({id:`${kind}:${scope}`,path,kind,scope,active:kind==="system"?!!systemPath&&resolve(systemPath)===resolve(path):appendPaths.includes(resolve(path)),editable:scope==="user"||session.settingsManager.isProjectTrusted(),tokens:0,content:"",version:"",exists:false});
	}
	for(const file of loader.getAgentsFiles().agentsFiles) files.push({id:`context:${hash(resolve(file.path))}`,path:resolve(file.path),kind:"context",scope:"context",active:true,editable:true,tokens:0,content:"",version:"",exists:true});
	if(session.settingsManager.isProjectTrusted()&&!files.some(file=>file.kind==="context")&&!existsSync(join(cwd,"AGENTS.md")))files.push({id:"context:new",path:join(cwd,"AGENTS.md"),kind:"context",scope:"context",active:false,editable:true,tokens:0,content:"",version:"",exists:false});
	for(const file of files)try{
		Object.assign(file,read(file.path));
		const loaded=file.kind==="context"?loader.getAgentsFiles().agentsFiles.find(f=>resolve(f.path)===file.path)?.content:file.active?(file.kind==="system"?loader.getSystemPrompt():loader.getAppendSystemPrompt().join("\n\n")):undefined;
		file.tokens=estimatePromptTokens(loaded??file.content);
		file.changedOnDisk=loaded!==undefined&&loaded!==file.content;
	}catch(e){file.editable=false;file.error=(e as Error).message;}
	return files;
}
export function getSystemPromptState(session:AgentSession,cwd:string,agentDir:string):SystemPromptState {
	const view=promptView(session,cwd),definitions=session.getAllTools();
	const files=catalog(session,cwd,agentDir);if(view.opaque)for(const file of files)file.editable=false;
	const options=view.options;
	const toolNames=options?.selectedTools??session.getActiveToolNames();
	return {raw:view.raw,tokens:estimatePromptTokens(view.raw),defaultPreamble:view.defaultPreamble,sections:view.sections,rules:view.rules,opaque:view.opaque,forced:view.forced,
		custom:!!options?.customPrompt,tools:toolNames.map(name=>{const tool=definitions.find(t=>t.name===name);return {name,custom:!!tool?.sourceInfo&&!tool.sourceInfo.path.startsWith("builtin:") && !/^<inline:(codemode|mcp|tool-search)>$/.test(tool.sourceInfo.path),path:tool?.sourceInfo.path};}),files,trusted:session.settingsManager.isProjectTrusted(),...promptReloadStatus(session),busy:!session.isIdle};
}
export function writeSystemPromptFile(session:AgentSession,cwd:string,agentDir:string,id:string,version:string,content:string|undefined,restore=false):string {
	const state=getSystemPromptState(session,cwd,agentDir),file=state.files.find(f=>f.id===id);
	if(!file?.editable||state.opaque)throw Error("This prompt source is read-only");
	if(file.version!==version)throw Error("File changed externally; reopen it before saving");
	if(restore){if(file.kind!=="system"||!file.exists)throw Error("Only an existing SYSTEM.md can be restored");unlinkSync(file.path);return file.path;}
	if(typeof content!=="string"||Buffer.byteLength(content)>LIMIT)throw Error("Prompt text exceeds 512 KB");
	const target=file.exists?realpathSync(file.path):canonicalParent(file.path);
	mkdirSync(dirname(target),{recursive:true});const temp=`${target}.${randomUUID()}.tmp`;
	try{writeFileSync(temp,content,{flag:"wx",mode:file.exists?statSync(target).mode:0o600});renameSync(temp,target);}finally{if(existsSync(temp))unlinkSync(temp);}
	return file.path;
}
export function promptUsesFile(session:AgentSession,cwd:string,agentDir:string,path:string):boolean {
	const identity=(file:string)=>{try{return realpathSync(file);}catch{return resolve(file);}};
	const target=identity(path);
	return session.settingsManager.isProjectTrusted()&&resolve(path)===join(cwd,"AGENTS.md")||catalog(session,cwd,agentDir).some(file=>resolve(file.path)===resolve(path)||identity(file.path)===target);
}
interface ReloadState { dirty:boolean; promise?:Promise<void>; error?:string; unsubscribe?:()=>void; refreshed:()=>void; }
const reloads = new WeakMap<AgentSession, ReloadState>();

export function promptReloadStatus(session: AgentSession) {
	const state = reloads.get(session);
	return { pending: !!state && (state.dirty || !!state.promise), ...(state?.error ? { reloadError: state.error } : {}) };
}

export async function flushPromptReload(session: AgentSession, retry = false): Promise<void> {
	const state = reloads.get(session);
	if (!state) return;
	if (state.promise) return state.promise;
	if (!state.dirty || !session.isIdle || (state.error && !retry)) return;
	state.error = undefined;
	state.dirty = false;
	state.promise = (async () => {
		try {
			await session.reload();
			state.refreshed();
		} catch (e) {
			state.error = (e as Error).message;
			state.dirty = true;
		} finally {
			state.promise = undefined;
			if (!state.dirty) {
				state.unsubscribe?.();
				reloads.delete(session);
			}
		}
	})();
	await state.promise;
	if (state.dirty && !state.error && session.isIdle) await flushPromptReload(session);
}

export async function queuePromptReload(session: AgentSession, refreshed: () => void) {
	let state = reloads.get(session);
	if (!state) {
		state = { dirty: true, refreshed };
		reloads.set(session, state);
		state.unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_settled") void flushPromptReload(session);
		});
	}
	state.dirty = true;
	state.error = undefined;
	await flushPromptReload(session);
}
