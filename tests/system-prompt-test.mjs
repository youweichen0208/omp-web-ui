/** Native prompt editing through HTTP, including reload during a running model request. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
const port=9212,mockPort=9213,clientId="system-prompt-fixture",token="prompt-fixture";
for(const p of [port,mockPort])assert.equal(await portUp(p),false,"Port busy");
const root=mkdtempSync(join(tmpdir(),"pi-system-prompt-")),cwd=join(root,"work"),agent=join(root,"agent");
for(const p of [cwd,agent,join(cwd,".pi"),join(agent,"extensions")])mkdirSync(p);
writeFileSync(join(cwd,"AGENTS.md"),"PROJECT_CONTEXT_SENTINEL");
writeFileSync(join(agent,"APPEND_SYSTEM.md"),"PERSONAL_APPEND_SENTINEL");
writeFileSync(join(cwd,".pi/APPEND_SYSTEM.md"),"PROJECT_APPEND_SENTINEL");
writeFileSync(join(agent,"settings.json"),JSON.stringify({defaultProvider:"fixture",defaultModel:"fixture"}));
writeFileSync(join(agent,"models.json"),JSON.stringify({providers:{fixture:{api:"openai-completions",baseUrl:`http://127.0.0.1:${mockPort}`,apiKey:"fixture",models:[{id:"fixture",name:"Fixture",input:["text"],contextWindow:32000,maxTokens:4000}]}}}));
writeFileSync(join(agent,"auth.json"),JSON.stringify({fixture:{type:"api_key",key:"fixture"}}));
writeFileSync(join(agent,"extensions/forced.js"),'export default pi => { pi.on("before_agent_start", event => event.prompt === "FORCED_RUN" ? { systemPrompt: "FORCED_NATIVE_PROMPT" } : undefined); };');
const requests=[];let hold=false,release;
const mock=createServer(async(req,res)=>{
	let body="";for await(const c of req)body+=c;const payload=JSON.parse(body);requests.push(payload);
	res.writeHead(200,{"content-type":"text/event-stream"});
	res.write(`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",choices:[{index:0,delta:{content:"fixture reply"},finish_reason:null}]})}\n\n`);
	if(hold)await new Promise(r=>{release=r;});
	res.end(`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\ndata: [DONE]\n\n`);
});
await new Promise(r=>mock.listen(mockPort,"127.0.0.1",r));
const server=spawn(process.execPath,["dist/server/index.js"],{env:{...process.env,PORT:String(port),PI_WEB_CWD:cwd,PI_CODING_AGENT_DIR:agent,PI_WEB_DATA_DIR:join(root,"data"),PI_WEB_TOKEN:token},stdio:["ignore","pipe","pipe"]});
let logs="",ws,browser,current,conversationId;
server.stdout.on("data",d=>logs+=d);server.stderr.on("data",d=>logs+=d);
const wait=async(fn)=>{for(let i=0;i<300;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw Error("Timed out: "+logs.slice(-2500));};
const req=async(action,args={},headers={})=>{const res=await fetch(`http://127.0.0.1:${port}/api/system-prompt`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`,...headers},body:JSON.stringify({clientId,cwd,conversationId,action,...args})});const text=await res.text();let data;try{data=JSON.parse(text);}catch{data={error:text};}return {status:res.status,...data};};
const save=async(id,content)=>{const state=await req("get"),file=state.files.find(f=>f.id===id);const result=await req("save",{id,version:file.version,content});assert.equal(result.status,200,JSON.stringify(result));return result;};
const prompt=async(text)=>{ws.send(JSON.stringify({type:"prompt",text}));await wait(()=>current?.isStreaming);};
try{
	await wait(()=>portUp(port));ws=new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
	ws.on("message",d=>{const m=JSON.parse(d);if(m.type==="snapshot")current=m.state;else if(m.type==="snapshot_delta"&&current&&current.rev===m.baseRev)current={...current,...m.state};});
	await new Promise((r,j)=>{ws.on("open",r);ws.on("error",j);});ws.send(JSON.stringify({type:"hello",clientId}));await wait(()=>current?.conversationId);conversationId=current.conversationId;
	assert.equal((await req("get",{}, {Origin:"https://evil.invalid"})).status,403);
	assert.equal((await req("get",{cwd:root})).status,409);assert.equal((await req("get",{conversationId:"missing"})).status,409);
	assert.equal((await req("get",{}, {Authorization:"Bearer wrong"})).status,401);
	let state=await req("get");assert.equal(state.status,200,JSON.stringify(state));assert.equal(state.opaque,false);
	assert(state.raw.includes("PROJECT_APPEND_SENTINEL"));assert(!state.raw.includes("PERSONAL_APPEND_SENTINEL"));assert(state.raw.includes("PROJECT_CONTEXT_SENTINEL"));
	assert.equal((await req("save",{id:"../../anything",version:"",content:"blocked"})).status,400);
	const append=state.files.find(f=>f.id==="append:project");
	assert.equal((await req("save",{id:append.id,version:"stale",content:"blocked"})).status,400);
	state=await save(append.id,"RELOADED_APPEND_SENTINEL");assert.equal(state.pending,false);assert(state.raw.includes("RELOADED_APPEND_SENTINEL"));
	assert.equal(current.conversationId,conversationId);assert.equal(requests.length,0,"Editing never calls a model");
	hold=true;await prompt("FIRST_RUN");await wait(()=>requests.length===1);
	state=await save(append.id,"DEFERRED_APPEND_SENTINEL");assert.equal(state.pending,true);assert(state.raw.includes("RELOADED_APPEND_SENTINEL"));
	assert(!JSON.stringify(requests[0]).includes("DEFERRED_APPEND_SENTINEL"));
	release();release=undefined;hold=false;await wait(()=>!current.isStreaming);
	state=await wait(async()=>{const s=await req("get");return !s.pending&&s;});assert(state.raw.includes("DEFERRED_APPEND_SENTINEL"));
	hold=true;await prompt("SECOND_RUN");await wait(()=>requests.length===2);assert(JSON.stringify(requests[1]).includes("DEFERRED_APPEND_SENTINEL"));assert(JSON.stringify(requests[1]).includes("FIRST_RUN"));
	release();release=undefined;hold=false;await wait(()=>!current.isStreaming);
	state=await save("system:project","CUSTOM_IDENTITY_SENTINEL");assert.equal(state.custom,true);assert(!state.sections.some(s=>s.name==="rules"));assert(state.raw.includes("PROJECT_CONTEXT_SENTINEL"));
	const system=state.files.find(f=>f.id==="system:project");
	state=await req("restore",{id:system.id,version:system.version});assert.equal(state.custom,false);assert(state.sections.some(s=>s.name==="rules"));
	hold=true;await prompt("FORCED_RUN");await wait(()=>requests.length===3);state=await req("get");assert.equal(state.forced,true);assert.equal(state.raw,"FORCED_NATIVE_PROMPT");
	assert.equal((await req("save",{id:append.id,version:append.version,content:"blocked"})).status,400);
	release();release=undefined;hold=false;await wait(()=>!current.isStreaming);
	if(process.argv.includes("--browser")){
		browser=await chromium.launch({executablePath:CHROME_PATH||chromium.executablePath()});
		const page=await browser.newPage({viewport:{width:1440,height:1050}});page.setDefaultTimeout(20000);const errors=[];page.on("pageerror",e=>errors.push(e.message));
		await page.addInitScript(id=>sessionStorage.setItem("pi-web-client-id",id),clientId);
		await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
		await page.getByRole("button",{name:"设置",exact:true}).first().click();await page.getByText("所有设置",{exact:true}).click();await page.getByRole("button",{name:"系统提示词",exact:true}).click();
		const panel=page.locator(".system-prompt-panel");await panel.locator(".prompt-sections").waitFor();mkdirSync("tests/scratch",{recursive:true});await page.screenshot({path:"tests/scratch/system-prompt-default.png",fullPage:true});
		await panel.getByRole("button",{name:"展开",exact:true}).click();await panel.locator(".prompt-rule-group li").first().waitFor();mkdirSync("tests/scratch",{recursive:true});await page.screenshot({path:"tests/scratch/system-prompt-sections.png",fullPage:true});await panel.getByRole("button",{name:"收起",exact:true}).click();
		await panel.getByRole("button",{name:"原始文本",exact:true}).click();assert((await panel.locator(".prompt-raw").textContent()).includes("<cwd>"));await panel.getByRole("button",{name:"分段视图",exact:true}).click();
		const appendRow=panel.locator(".prompt-section").filter({has:page.locator(".prompt-label",{hasText:"追加提示词"})});await appendRow.getByRole("button",{name:"编辑",exact:true}).click();
		await panel.getByRole("textbox",{name:"提示词文件内容"}).fill("BROWSER_APPEND_SENTINEL");await page.screenshot({path:"tests/scratch/system-prompt-editor.png",fullPage:true});
		// Navigation must preserve a dirty editor if the user declines discarding it.
		page.once("dialog",dialog=>dialog.dismiss());await page.getByRole("button",{name:"Extensions",exact:true}).click();await panel.locator(".prompt-editor").waitFor();
		await panel.getByRole("button",{name:"保存",exact:true}).click();await panel.locator(".prompt-editor").waitFor({state:"hidden"});assert.equal(readFileSync(join(cwd,".pi/APPEND_SYSTEM.md"),"utf8"),"BROWSER_APPEND_SENTINEL");
		await panel.getByRole("button",{name:"替换",exact:true}).click();await panel.getByRole("button",{name:"继续替换",exact:true}).click();await panel.getByRole("textbox",{name:"提示词文件内容"}).fill("BROWSER_IDENTITY");await page.screenshot({path:"tests/scratch/system-prompt-replace.png",fullPage:true});
		await panel.getByRole("button",{name:"保存",exact:true}).click();await panel.getByRole("button",{name:"移除此替换",exact:true}).waitFor();page.once("dialog",dialog=>dialog.accept());await panel.getByRole("button",{name:"移除此替换",exact:true}).click();await panel.getByRole("button",{name:"替换",exact:true}).waitFor();
		await page.setViewportSize({width:390,height:844});await page.screenshot({path:"tests/scratch/system-prompt-mobile.png",fullPage:true});assert(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
		await page.setViewportSize({width:1440,height:1050});await page.evaluate(()=>localStorage.setItem("pi-harness:lang","en"));await page.reload();await page.getByRole("button",{name:"Settings",exact:true}).first().click();await page.getByText("All settings",{exact:true}).click();await page.getByRole("button",{name:"System prompt",exact:true}).click();await page.getByRole("button",{name:"Copy all",exact:true}).waitFor();await page.screenshot({path:"tests/scratch/system-prompt-en.png",fullPage:true});
		assert.deepEqual(errors,[]);await browser.close();browser=undefined;
	}
	assert.equal(requests.length,3,"No automatic model requests");console.log("PASS native prompt: scopes, CAS, reload, pending edits, conversation history, forceSystemPrompt, browser");
}finally{
	release?.();await browser?.close();ws?.terminate();server.kill();if(server.exitCode===null)await new Promise(r=>server.once("exit",r));await new Promise(r=>mock.close(r));rmSync(root,{recursive:true,force:true});
}
