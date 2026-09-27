/** Standalone design acceptance: real backend/tree, deterministic model-free transcript. */
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium, _electron as electron} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';
const PORT=8992;
const root=mkdtempSync(join(tmpdir(),'workspace-design-'));
const cwd=join(root,'youwei-trading-agent');mkdirSync(cwd);
for(const path of ['.assets','.scratch/trading-agent-cockpit','.scratch/us-stock-research','docs','src'])mkdirSync(join(cwd,path),{recursive:true});
writeFileSync(join(cwd,'AGENTS.md'),'# Workspace\n\n| Module | File | Details |\n| --- | --- | --- |\n| Model | `docs/architecture-core.md` | preserved cell content |\n| Globals | `some/very/long/path/to/a/module.ts` | more contents |\n');writeFileSync(join(cwd,'CONTEXT.md'),'# Context\n');
writeFileSync(join(cwd,'docs/note.md'),'# Nested note\n');
writeFileSync(join(cwd,'src/problem.ts'),'const value: string = 1;\n');
writeFileSync(join(cwd,'obsolete.txt'),'old content\n');
writeFileSync(join(cwd,'.scratch/us-stock-research/spec.md'),'# Spec\n');
execFileSync('git',['init','-q'],{cwd});execFileSync('git',['add','.'],{cwd});
execFileSync('git',['-c','user.name=UI test','-c','user.email=ui@example.test','commit','-qm','fixture'],{cwd});
for(const path of ['CONTEXT.md','docs/note.md','.scratch/us-stock-research/spec.md'])writeFileSync(join(cwd,path),'# Modified\n');
writeFileSync(join(cwd,'added.txt'),'new content\n');
execFileSync('git',['rm','-q','obsolete.txt'],{cwd});
const lines=['CONTEXT.md','docs/adr/0001-embed-pi-sdk.md','docs/adr/0002-preserve-research-versions.md','docs/agents/domain.md','docs/agents/triage-labels.md','docs/agents/issue-tracker.md','.scratch/trading-agent-cockpit/data-source-research.md','.scratch/us-stock-research/spec.md',...Array.from({length:9},(_,i)=>`.scratch/us-stock-research/issues/${i}.md`)];
const command='ls ~/projects/youwei-knowledge-base/ 2>/dev/null | head; echo "---"; find ~/projects/youwei-trading-agent -type f -not -name ".DS_Store" | head -30; echo "---NEWEST---"; find … -exec stat -f "%Sm %N" -t "%m-%d %H:%M" {} \\; | sort -r | head -8';
const timestamp=new Date('2026-09-24T07:58:00+08:00').getTime();
const messages=[
...Array.from({length:3},(_,i)=>({id:`goal-${i}`,role:'user',content:[{type:'text',text:'【目标已设定】\n\n把首页标题改为 Goal Buddy\n\n请现在开始实现这个目标。'}]})),
{id:'goal-done',role:'user',content:[{type:'text',text:'✅ 目标已达成并通过审查（第 1 轮）。\n\n目标：把首页标题改为 Goal Buddy\n\n审查通过。\n\n（目标模式已解除，接下来按你的普通指令响应。）'}]},
{id:'user',role:'user',timestamp,content:[{type:'text',text:'审查一下最近的代码改动请求，先看看项目里都有哪些文件，最近改了什么。'}]},
{id:'assistant-tool',role:'assistant',model:'glm-5.3',timestamp,content:[{type:'thinking',thinking:'先检查目录与最近修改，再核对项目约束。',durationMs:3000},{type:'toolCall',id:'bash-design',name:'bash',argumentsText:JSON.stringify({command})}]},
{id:'result',role:'toolResult',toolCallId:'bash-design',toolName:'bash',isError:false,content:[{type:'text',text:lines.join('\n')+'\n'}]},
{id:'assistant',role:'assistant',model:'glm-5.3',timestamp,content:[{type:'thinking',thinking:'Confirmed: the workspace contains only docs — no code at all.'},{type:'text',text:'这个仓库目前**只有文档，没有代码**。最近的改动集中在 `.scratch/us-stock-research/issues/`，共 8 个 issue 草稿，另外有两份 ADR。要我逐个审查这些 issue 吗？'}]},
];
let server,browser,app;
try{
const env={...process.env,PI_WEB_CWD:cwd,PI_WEB_DATA_DIR:join(root,'data'),PI_CODING_AGENT_DIR:join(root,'agent')};
let page;
if(process.argv.includes('--electron')){
app=await electron.launch({args:['.',`--user-data-dir=${join(root,'profile')}`],env});
for(let i=0;i<200;i++){page=app.windows().find(w=>w.url().startsWith('http://127.0.0.1:'));if(page)break;await sleep(100)}
assert(page);page.on('dialog',()=>{});
await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1600,1000));
}else{
assert.equal(await portUp(PORT),false);
server=spawn(process.execPath,['dist/server/index.js'],{env:{...env,PORT:String(PORT)},stdio:['ignore','pipe','pipe']});
let log='';server.stderr.on('data',data=>log+=data);
for(let n=0;n<80&&!await portUp(PORT);n++)await sleep(250);
assert(await portUp(PORT),log);
browser=await chromium.launch({executablePath:CHROME_PATH});
page=await browser.newPage({viewport:{width:1600,height:1000}});
}
const resize=async(width)=>{if(app)await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setSize(w,900),width);else await page.setViewportSize({width,height:900});await sleep(200)};
const widths=app?[1600,900,640]:[1600,900,390];
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const sent=[]; let socket, latestState; let overrides={};
await page.routeWebSocket('**/ws',route=>{
socket=route; const upstream=route.connectToServer();
route.onMessage(wire=>{const message=JSON.parse(wire.toString());sent.push(message);if(message.type==='prompt'){route.send(JSON.stringify({type:'prompt_result',requestId:message.requestId,ok:true}));return;}upstream.send(wire)});
upstream.onMessage(wire=>{
const message=JSON.parse(wire.toString());
if(message.type==='snapshot'){
Object.assign(message.state,{messages,piConfigured:true,model:{id:'glm-5.3',name:'GLM 5.3',provider:'volc-glm'},thinkingLevel:'minimal',availableThinkingLevels:['off','minimal','low','medium','high']});
message.state.stats.contextUsage={tokens:17300,contextWindow:1000000,percent:1.73};Object.assign(message.state,overrides);latestState=message.state;
}
if(message.type==='settings_state')Object.assign(message.settings??message,{toolsWrap:true,thinkingWrap:false});
route.send(JSON.stringify(message));
});
});

await page.goto(app?page.url():`http://localhost:${PORT}`);
await page.locator('.toolcall-bash').waitFor();
await page.locator('.goal-event.complete',{hasText:'目标已完成'}).waitFor();
assert.equal(await page.locator('.goal-event.complete .goal-event-details').count(),1);
await page.locator('.tree-filter',{hasText:'改动 5'}).waitFor();
assert.equal(await page.locator('.panel-sessions .session-item.active').count(),1,'current conversation is highlighted');
const emit=(state)=>{overrides=state;latestState={...latestState,...state,rev:latestState.rev+1};socket.send(JSON.stringify({type:'snapshot',state:latestState}));};
await page.locator('.tree-filter').click();
assert.equal(await page.locator('.file-name-text',{hasText:'AGENTS.md'}).count(),0);
assert((await page.locator('.tree-modified-count').count()) >= 1,'folders carry change counts');
assert.equal(await page.locator('.file-item.file .tree-modified-count').count(),0,'files have no numeric count');
assert((await page.locator('.tree-change-badge').count()) >= 1,'changed files carry status letters');
assert.equal(await page.locator('.file-item',{hasText:'CONTEXT.md'}).locator('.tree-change-badge').textContent(),'M');
assert.equal(await page.locator('.file-item',{hasText:'added.txt'}).locator('.tree-change-badge').textContent(),'A');
assert.equal(await page.locator('.file-item',{hasText:'obsolete.txt'}).locator('.tree-change-badge').textContent(),'D');
await page.locator('.file-dir-main',{hasText:'docs'}).click();
await page.locator('.file-name-text',{hasText:'note.md'}).waitFor();
await page.locator('.tree-filter').click();
await page.locator('.file-name-text',{hasText:'AGENTS.md'}).waitFor();
assert.equal(await page.locator('.msg-assistant > .msg-meta:visible').count(),1);
const tool=(id,command)=>({id,role:'assistant',model:'glm-5.3',content:[{type:'toolCall',id:'call-'+id,name:'bash',argumentsText:JSON.stringify({command})}]});
const result=(id,text)=>({id:'result-'+id,role:'toolResult',toolCallId:'call-'+id,content:[{type:'text',text}]});
const conversation=[messages[4],tool('a','rg div'),result('a','331:                       <div className="'+ 'long'.repeat(90)+'">'),tool('b','ls'),result('b','short')];
emit({messages:conversation,isStreaming:false,streamingMessage:null});
await page.locator('.toolcall-bash').nth(1).waitFor();
for(const card of await page.locator('.toolcall-bash').all()){
await page.mouse.move(10,10);await page.locator('.inputbox textarea').focus();await sleep(200);
assert.equal(await card.locator('.toolcall-head button').count(),5);
assert.equal(await card.locator('.toolcall-copy').evaluate(e=>getComputedStyle(e).opacity),'0');
await card.hover();await sleep(200);
assert.equal(await card.locator('.toolcall-copy').evaluate(e=>getComputedStyle(e).opacity),'1');
}
assert.equal(await page.locator('.bash-output-label [title]').count(),0,'current workspace paths do not repeat');
assert.equal(await page.locator('.bash-line-number').first().textContent(),'1');
assert((await page.locator('.bash-line-text').first().textContent()).startsWith('331:'),'rg without -n keeps the original line');
const output=page.locator('.bash-output-lines').first();
assert((await output.getAttribute('class')).includes('has-overflow'));
await output.evaluate(e=>e.scrollLeft=e.scrollWidth);await sleep(100);
assert(!(await output.getAttribute('class')).includes('has-overflow'));
emit({messages:[{...messages[4],timestamp:Date.now()}],isStreaming:true,streamingMessage:null});
await page.locator('.agent-working-placeholder .msg-meta',{hasText:'pi'}).waitFor();
assert.equal(await page.locator('.agent-working-placeholder > .waiting-header-status',{hasText:'正在分析请求'}).count(),1);
emit({messages:conversation,isStreaming:true,streamingMessage:{id:'stream-thinking',role:'assistant',model:'glm-5.3',content:[{type:'thinking',thinking:'Working on the request',durationMs:0}]}});
await page.locator('.thinking.live').waitFor();
assert.equal(await page.locator('.composer-hint').count(),0);
assert.equal(await page.locator('.status-item.working .working-dots i').count(),3);
assert.equal(await page.locator('.agent-working').count(),0,'visible thinking replaces the waiting footer');
assert.equal(await page.locator('.inputbox .working-dots,.inputbox .status-dot,.inputbox .thinking-spinner').count(),0,'no extra working dot in composer');
assert.equal(await page.locator('.msg-assistant > .msg-meta:visible').count(),1);
assert.equal(await page.locator('.inputbox textarea').getAttribute('placeholder'),'继续输入消息…');
const actions=page.locator('.input-tools .inputbox-actions');
await page.locator('.inputbox textarea').fill('queued question');
assert.equal(await actions.locator('.supplement').isVisible(),true);
assert.equal(await actions.locator('.steer').isVisible(),true);
assert.equal(await actions.locator('.stop').isVisible(),true);
await actions.locator('.supplement').click();
assert.equal(sent.filter(m=>m.type==='prompt').at(-1).queue,true);
await page.waitForFunction(()=>document.querySelector('.inputbox textarea').value==='');
await page.locator('.inputbox textarea').fill('steer question');await actions.locator('.steer').click();
assert.equal(sent.filter(m=>m.type==='prompt').at(-1).queue,false);
await page.waitForFunction(()=>document.querySelector('.inputbox textarea').value==='');
await page.locator('.inputbox textarea').fill('keyboard queue');await page.locator('.inputbox textarea').press('Meta+Enter');
assert.equal(sent.filter(m=>m.type==='prompt').at(-1).queue,true);
await page.waitForFunction(()=>document.querySelector('.inputbox textarea').value==='');
await page.locator('.inputbox textarea').fill('keyboard steer');await page.locator('.inputbox textarea').press('Enter');
assert.equal(sent.filter(m=>m.type==='prompt').at(-1).queue,false);
await page.waitForFunction(()=>document.querySelector('.inputbox textarea').value==='');
await page.locator('.inputbox textarea').fill('next action');
assert.notEqual(await actions.locator('.steer').evaluate(e=>getComputedStyle(e).backgroundColor),await actions.locator('.supplement').evaluate(e=>getComputedStyle(e).backgroundColor),'steer is visually primary when text is present');
assert.equal(await actions.locator('.steer').isEnabled(),true);
assert.equal(await actions.locator('.supplement').isEnabled(),true);
await page.locator('.inputbox textarea').fill('');
emit({messages:[...conversation,tool('active','sleep 10')],isStreaming:true,streamingMessage:null});
await page.locator('.agent-working',{hasText:'等待命令完成…'}).waitFor();
assert.equal(await page.locator('.agent-working').count(),1);
assert.equal(await page.locator('.thinking-spinner:visible,.working-spin:visible').count(),0);
emit({messages:[...conversation,{id:'read-step',role:'assistant',model:'glm-5.3',content:[{type:'toolCall',id:'read-active',name:'read',argumentsText:JSON.stringify({path:'web/src/components/LeftPanel.tsx'})}]}],isStreaming:true,streamingMessage:null});
await page.locator('.agent-working',{hasText:'正在读取 LeftPanel.tsx…'}).waitFor();
socket.send(JSON.stringify({type:'tool_status',toolCallId:'read-active',toolName:'read',isError:false,durationMs:300}));
await page.locator('.read-group-head',{hasText:'完成 · 0.3s'}).waitFor();
await page.locator('.agent-working',{hasText:'等待模型'}).waitFor();
const reads={id:'reads',role:'assistant',model:'glm-5.3',content:[
{type:'toolCall',id:'read-one',name:'read',argumentsText:JSON.stringify({path:join(cwd,'CONTEXT.md')})},
{type:'toolCall',id:'read-two',name:'read',argumentsText:JSON.stringify({path:join(cwd,'docs/note.md')})},
]};
const skillOutput='---\nname: grilling\ndescription: Ask hard questions\n---\n# Usage\n'+Array.from({length:14},(_,i)=>`Line ${i+1}`).join('\n');
emit({messages:[messages[4],reads,{id:'read-result-one',role:'toolResult',toolCallId:'read-one',content:[{type:'text',text:skillOutput}]},{id:'read-result-two',role:'toolResult',toolCallId:'read-two',content:[{type:'text',text:'# Note'}]}],isStreaming:false,streamingMessage:null});
await page.locator('.read-group-head',{hasText:'读取 2 个文件'}).waitFor();
assert.equal(await page.locator('.read-group .toolcall:visible').count(),0);
await page.mouse.move(0,0);
await page.locator('.read-group-head').click();
assert.equal(await page.locator('.read-file-row:visible').count(),2);
await page.locator('.read-file-head').first().click();
assert.equal(await page.locator('.read-group .toolcall:visible').count(),1);
assert.equal(await page.locator('.toolcall-args pre',{hasText:'{"path"'}).count(),0,'read arguments do not expose JSON');
assert.equal(await page.locator('.toolcall-frontmatter dt',{hasText:'name'}).count(),1);
assert.equal(await page.locator('.toolcall-markdown h1',{hasText:'grilling'}).count(),0,'frontmatter does not become a heading');
await page.locator('.read-group .toolcall-output-more').first().click();
assert((await page.locator('.read-group .toolcall-markdown').first().textContent()).includes('Line 14'));
emit({messages:[...conversation,tool('active','sleep 10')],isStreaming:true,streamingMessage:null});
await page.locator('.agent-working',{hasText:'等待命令完成…'}).waitFor();
await page.screenshot({path:app?'/private/tmp/pi-agent-working-desktop.png':'/private/tmp/pi-agent-working.png'});
const editCall={id:'edit-call',role:'assistant',model:'glm-5.3',content:[{type:'toolCall',id:'edit-1',name:'edit',argumentsText:JSON.stringify({path:'web/index.html',oldText:'old',newText:'new'})}]};
const editResult={id:'edit-result',role:'toolResult',toolCallId:'edit-1',toolName:'edit',isError:false,content:[{type:'text',text:'Edit complete'}],details:{diff:'-  3 old\n+  3 new'}};
emit({messages:[messages[4],editCall,editResult],isStreaming:false,streamingMessage:null});
await page.locator('.change-card-toggle code',{hasText:'web/index.html'}).waitFor();
assert((await page.locator('.change-card .change-counts').textContent()).includes('+1'));
assert((await page.locator('.change-card .change-counts').textContent()).includes('−1'));
assert.equal((await page.locator('.change-card .change-old').allTextContents()).join(','),'3,');
assert.equal((await page.locator('.change-card .change-new').allTextContents()).join(','),',3');
const diffWidths=await page.locator('.change-lines').evaluate(e=>({line:e.querySelector('.change-line.add').getBoundingClientRect().width,container:e.getBoundingClientRect().width}));
assert(diffWidths.line>=diffWidths.container-2,'diff tint spans the block width');
await page.screenshot({path:app?'/private/tmp/pi-edit-diff-desktop.png':'/private/tmp/pi-edit-diff.png'});
const multiCommand='cd '+cwd+' && echo "=== PORTS ===" && rg 899 tests && echo "=== GIT ===" && git status';
const multiCall={id:'multi',role:'assistant',model:'glm-5.3',content:[{type:'toolCall',id:'multi-bash',name:'bash',argumentsText:JSON.stringify({command:multiCommand})}]};
const multiResult={id:'multi-result',role:'toolResult',toolCallId:'multi-bash',toolName:'bash',isError:true,content:[{type:'text',text:'=== PORTS ===\ntests/a.mjs:8992\n=== GIT ===\nfatal: not a git repository\nCommand exited with code 128'}]};
emit({messages:[messages[4],multiCall,multiResult],isStreaming:false,streamingMessage:null});
await page.locator('.toolcall-steps .toolcall-status',{hasText:'部分失败 · 1/2 步成功'}).waitFor();
assert.equal(await page.locator('.bash-step.done').count(),1);
assert.equal(await page.locator('.bash-step.failed').count(),1);
assert.equal(await page.locator('.bash-step.failed .bash-step-detail:visible').count(),1);
await page.screenshot({path:'/private/tmp/pi-bash-steps.png'});
await page.locator('.bash-view-switch button',{hasText:'原始'}).click();
assert.equal(await page.locator('.toolcall-steps .bash-output').count(),1);
const failureCall={id:'failed',role:'assistant',model:'glm-5.3',content:[{type:'toolCall',id:'failed-bash',name:'bash',argumentsText:JSON.stringify({command:'npm run typecheck'})}]};
const failureResult={id:'failed-result',role:'toolResult',toolCallId:'failed-bash',toolName:'bash',isError:true,content:[{type:'text',text:'src/problem.ts(1,7): error TS2322: Type number is not assignable to string\nCommand exited with code 2'}]};
emit({messages:[messages[4],failureCall,failureResult],isStreaming:false,streamingMessage:null});
await page.locator('.toolcall-diagnostics .toolcall-status',{hasText:'失败 · exit 2 · 1 个错误'}).waitFor();
await page.locator('.bash-failure-line button',{hasText:'src/problem.ts:1'}).click();
await page.locator('.fp-edit-line.from-tool[data-line="1"]').waitFor();
await page.locator('.fp-back').click();
const groupedTools={id:'grouped-tools',role:'assistant',model:'glm-5.3',content:[
{type:'toolCall',id:'grep-one',name:'grep',argumentsText:JSON.stringify({pattern:'TODO',path:'src'})},
{type:'toolCall',id:'agent-one',name:'spawn_agent',argumentsText:JSON.stringify({task_name:'审查前端'})},
{type:'toolCall',id:'agent-two',name:'spawn_agent',argumentsText:JSON.stringify({task_name:'审查服务端'})},
]};
emit({messages:[messages[4],groupedTools,{id:'grep-result',role:'toolResult',toolCallId:'grep-one',content:[{type:'text',text:'src/problem.ts:1:TODO check\n'}]},{id:'agent-result-one',role:'toolResult',toolCallId:'agent-one',content:[{type:'text',text:'发现 1 处问题'}]},{id:'agent-result-two',role:'toolResult',toolCallId:'agent-two',content:[{type:'text',text:'未发现问题'}]}],isStreaming:false,streamingMessage:null});
await page.locator('.grep-summary-head',{hasText:'1 处匹配'}).waitFor();
await page.locator('.subagent-group-head',{hasText:'子代理 × 2'}).click();
assert.equal(await page.locator('.subagent-row').count(),2);
await page.locator('.subagent-row-head').first().click();
assert.equal(await page.locator('.subagent-row-body .toolcall').count(),1);
emit({messages:[...conversation,tool('active','sleep 10')],isStreaming:true,streamingMessage:null});
await page.locator('.inputbox textarea').fill('next queued action');
for(const width of widths){
await resize(width);
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`busy overflow at ${width}`);
const box=await page.locator('.inputbox').boundingBox();
for(const button of ['.supplement','.steer','.stop']){const rect=await actions.locator(button).boundingBox();assert(rect.x>=box.x&&rect.x+rect.width<=box.x+box.width+1,`busy action fits ${width}`);}
}
emit({messages:[messages[4],{id:'long',role:'assistant',model:'glm-5.3',content:[{type:'text',text:Array.from({length:80},(_,i)=>`Paragraph ${i}: more content.`).join('\n\n')}]}],isStreaming:false,streamingMessage:null});
for(const width of widths){
await resize(width);
await page.locator('.messages').hover();await page.mouse.wheel(0,-20000);
await page.locator('.scroll-bottom').waitFor();
const box=await page.locator('.inputbox').boundingBox(),jump=await page.locator('.scroll-bottom').boundingBox();
assert(Math.abs(box.x+box.width-jump.x-jump.width)<2,`bottom alignment ${width}`);
}
assert.deepEqual(errors,[]);
console.log('PASS working state: dots/timer/task, grouped headers, queue/steer, card actions, output scroll, change filter, responsive alignment');
}finally{await app?.close();await browser?.close();server?.kill('SIGTERM');await sleep(200);}
