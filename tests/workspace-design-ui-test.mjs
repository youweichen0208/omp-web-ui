/** Standalone design acceptance: real backend/tree, deterministic model-free transcript. */
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';
const PORT=8993;
const root=mkdtempSync(join(tmpdir(),'workspace-design-'));
const cwd=join(root,'youwei-trading-agent');mkdirSync(cwd);
for(const path of ['.assets','.scratch/trading-agent-cockpit','.scratch/us-stock-research','docs'])mkdirSync(join(cwd,path),{recursive:true});
writeFileSync(join(cwd,'AGENTS.md'),'# Workspace\n\n| Module | File | Details |\n| --- | --- | --- |\n| Model | `docs/architecture-core.md` | preserved cell content |\n| Globals | `some/very/long/path/to/a/module.ts` | more contents |\n');writeFileSync(join(cwd,'CONTEXT.md'),'# Context\n');
writeFileSync(join(cwd,'docs/note.md'),'# Nested note\n');
mkdirSync(join(cwd,'docs/research'),{recursive:true});
writeFileSync(join(cwd,'docs/research/llm-gateway-options.md'),Array.from({length:30},(_,i)=>`Gateway paragraph ${i+1}`).join('\n\n'));
writeFileSync(join(cwd,'.scratch/us-stock-research/spec.md'),'# Spec\n');
execFileSync('git',['init','-q'],{cwd});execFileSync('git',['add','.'],{cwd});
execFileSync('git',['-c','user.name=UI test','-c','user.email=ui@example.test','commit','-qm','fixture'],{cwd});
for(const path of ['CONTEXT.md','docs/note.md','.scratch/us-stock-research/spec.md'])writeFileSync(join(cwd,path),'# Modified\n');
const lines=['CONTEXT.md','docs/adr/0001-embed-pi-sdk.md','docs/adr/0002-preserve-research-versions.md','docs/agents/domain.md','docs/agents/triage-labels.md','docs/agents/issue-tracker.md','.scratch/trading-agent-cockpit/data-source-research.md','.scratch/us-stock-research/spec.md',...Array.from({length:9},(_,i)=>`.scratch/us-stock-research/issues/${i}.md`)];
const command='ls ~/projects/youwei-knowledge-base/ 2>/dev/null | head; echo "---"; find ~/projects/youwei-trading-agent -type f -not -name ".DS_Store" | head -30; echo "---NEWEST---"; find … -exec stat -f "%Sm %N" -t "%m-%d %H:%M" {} \\; | sort -r | head -8';
const timestamp=new Date('2026-09-24T07:58:00+08:00').getTime();
const messages=[
...Array.from({length:3},(_,i)=>({id:`goal-${i}`,role:'user',content:[{type:'text',text:'【目标已设定】\n\n把首页标题改为 Goal Buddy\n\n请现在开始实现这个目标。'}]})),
{id:'user',role:'user',timestamp,content:[{type:'text',text:'审查一下最近的代码改动请求，先看看项目里都有哪些文件，最近改了什么。'}]},
{id:'assistant-tool',role:'assistant',model:'glm-5.3',timestamp,content:[{type:'thinking',thinking:'先检查目录与最近修改，再核对项目约束。',durationMs:3000},{type:'toolCall',id:'bash-design',name:'bash',argumentsText:JSON.stringify({command})}]},
{id:'result',role:'toolResult',toolCallId:'bash-design',toolName:'bash',isError:false,content:[{type:'text',text:lines.join('\n')+'\n'},...[...lines.slice(0,11),'docs/CONTEXT.md'].map((path,i)=>({type:'toolCall',id:`grep-${i}`,name:'grep',argumentsText:JSON.stringify({path})}))]},
{id:'assistant',role:'assistant',model:'glm-5.3',timestamp,usage:{input:7500,output:1000,cacheRead:86000,cacheWrite:6500},content:[{type:'thinking',thinking:'Confirmed: the workspace contains only docs — no code at all.'},{type:'text',text:'这个仓库目前**只有文档，没有代码**。最近的改动集中在 `.scratch/us-stock-research/issues/`，共 8 个 issue 草稿，另外有两份 ADR。要我逐个审查这些 issue 吗？'}]},
];
let server,browser;
try{
assert.equal(await portUp(PORT),false);
server=spawn(process.execPath,['dist/server/index.js'],{env:{...process.env,PORT:String(PORT),PI_WEB_CWD:cwd,PI_WEB_DATA_DIR:join(root,'data'),PI_CODING_AGENT_DIR:join(root,'agent')},stdio:['ignore','pipe','pipe']});
let log='';server.stderr.on('data',data=>log+=data);
for(let n=0;n<80&&!await portUp(PORT);n++)await sleep(250);
assert(await portUp(PORT),log);
browser=await chromium.launch({executablePath:CHROME_PATH});
const context=await browser.newContext({viewport:{width:1600,height:1000},permissions:['clipboard-read','clipboard-write']});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const sent=[];
await page.routeWebSocket('**/ws',route=>{
const upstream=route.connectToServer();
route.onMessage(wire=>{const message=JSON.parse(wire.toString());sent.push(message);if(message.type==='prompt')throw Error('No model requests allowed');upstream.send(wire)});
upstream.onMessage(wire=>{
const message=JSON.parse(wire.toString());
if(message.type==='snapshot'){
Object.assign(message.state,{messages,piConfigured:true,model:{id:'glm-5.3',name:'GLM 5.3',provider:'volc-glm'},thinkingLevel:'minimal',availableThinkingLevels:['off','minimal','low','medium','high']});
message.state.stats.contextUsage={tokens:17300,contextWindow:1000000,percent:1.73};
message.state.stats.tokens={input:7500,output:1000,cacheRead:86000,cacheWrite:6500,total:101000};
message.state.stats.contextParts={system:1800,tools:5200,conversation:9300,attachments:1000};
message.state.cwdEvents=[{cwd,timestamp:Date.now()}];
}
if(message.type==='projects')message.projects=[{path:'/',lastUsed:1,firstAdded:1,conversationCount:1},{path:join(root,'recent'),lastUsed:100,firstAdded:100,conversationCount:1},{path:cwd,lastUsed:50,firstAdded:50,conversationCount:1}];
if(message.type==='settings_state')Object.assign(message.settings??message,{toolsWrap:true,thinkingWrap:false});
route.send(JSON.stringify(message));
});
});
await page.goto(`http://localhost:${PORT}`);
await page.locator('.tree-filter',{hasText:'3'}).waitFor();
await page.locator('.toolcall-bash').waitFor();
await page.locator('.cwd-event').waitFor();
assert((await page.locator('.cwd-event').textContent()).includes(cwd));
assert.equal(await page.locator('.notice',{hasText:'已切换到工作目录'}).count(),0);
await page.locator('.project-item').first().waitFor();
assert.deepEqual((await page.locator('.project-item .project-name').allTextContents()).slice(0,3),['youwei-trading-agent','recent','根目录']);
for(const button of await page.locator('.thinking.open .thinking-toggle').all())await button.click();
await page.locator('.file-dir-main',{hasText:'.scratch'}).click();
await page.locator('.file-dir-main',{hasText:'us-stock-research'}).waitFor();
await page.locator('.tree-menu-trigger').click();
await page.locator('.tree-hidden-toggle').click();
assert.equal(await page.locator('.file-dir-main',{hasText:'.scratch'}).count(),0);
await page.locator('.tree-hidden-toggle').click();
assert.equal(await page.locator('.tree-hidden-toggle').getAttribute('aria-checked'),'true');
await page.locator('.file-dir-main',{hasText:'.scratch'}).waitFor();
assert.equal(await page.locator('.file-name-text',{hasText:'AGENTS.md'}).isVisible(),true,'root siblings remain visible');
await page.locator('.file-dir-main',{hasText:'docs'}).click();
await page.locator('.file-name-text',{hasText:'note.md'}).waitFor();
await page.locator('.file-dir-main',{hasText:'docs'}).focus();
await page.keyboard.press("ArrowLeft");
assert.equal(await page.locator('.file-name-text',{hasText:'note.md'}).count(),0);
assert.equal(await page.locator('.bash-output-line').count(),8);
assert.equal(await page.locator('.bash-output-gap-button').count(),1);
assert.equal(await page.locator('.bash-output-more').count(),0);
await page.locator('.bash-output-gap-button').click();assert.equal(await page.locator('.bash-output-line').count(),17);
await page.locator('.bash-output-more').click();
await page.locator('.bash-card-more > summary').click();
await page.locator('.toolcall-bash').hover();await page.locator('.toolcall-wrap').click();assert.equal(await page.locator('.bash-output-lines.wrap').count(),1);
await page.locator('.toolcall-bash').hover();await page.locator('.toolcall-wrap').click();
await page.locator('.toolcall-copy').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),command);
await page.locator('#sidebar-settings-slot .chip').click();await page.locator('#sidebar-settings-slot .dd-menu').waitFor();await page.keyboard.press('Escape');
const geometry=await page.evaluate(()=>{
const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
return {left:box('.drawer-left'),right:box('.drawer-right'),header:box('.topbar'),composer:box('.inputbox'),font:getComputedStyle(document.body).fontFamily};
});
assert.equal(geometry.left.w,264);assert.equal(geometry.right.w,272);assert.equal(geometry.header.h,44);assert.equal(geometry.composer.w,780);assert(geometry.font.includes('IBM Plex Sans'));
const readingEdges=await page.evaluate(()=>{
const messages=document.querySelector('.messages');const composer=document.querySelector('.main > .inputbar');const wrap=document.querySelector('.messages-wrap');
return {bottom:parseFloat(getComputedStyle(messages).paddingBottom),composer:composer.getBoundingClientRect().height,topFade:getComputedStyle(wrap,'::before').height,bottomFade:getComputedStyle(wrap,'::after').display};
});
assert.equal(readingEdges.bottom,24,JSON.stringify(readingEdges));
assert.equal(readingEdges.topFade,'16px');assert.equal(readingEdges.bottomFade,'none');
assert((await page.locator('.thinking-control .chip').textContent()).includes('思考'));
assert.equal(await page.getByText('本次对话涉及').count(),0);
assert.equal(await page.locator('.conversation-files').count(),0);
await page.setViewportSize({width:1600,height:480});
assert.equal(await page.locator('.conversation-files').count(),0);
await page.setViewportSize({width:1600,height:1000});
await page.locator('.messages').evaluate(e=>e.scrollTop=0);
await page.locator('.inputbox textarea').focus();
await page.waitForTimeout(1300);
await page.mouse.move(100,100);
await page.screenshot({path:'/private/tmp/pi-strict-workspace.png'});
console.log('PASS tree expansion/change markers, numbered output/wrap/copy, settings and reference dimensions',geometry);
assert.equal(await page.locator('.goal-event:not(.cwd-event)').count(),1);
assert.equal(await page.locator('.goal-event-count').textContent(),'×3');
assert((await page.locator('.thinking-duration').first().textContent()).includes('3 秒'));
assert.equal(await page.locator('.sidebar-connection').isVisible(),false);
assert.equal((await page.locator('.design-workspace > .statusbar').boundingBox()).width,1600);
assert.equal(await page.locator('.project-item.active').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
assert.equal(await page.locator('.usage-popover').count(),0);
assert.match(await page.locator('.usage-trigger').textContent(),/2%.*86%/);
await page.locator('.usage-trigger').hover();
await page.locator('.usage-popover').waitFor();
assert.match(await page.locator('.usage-popover').textContent(),/17.3K \/ 1M/);
assert.match(await page.locator('.usage-popover').textContent(),/缓存命中\s*86%/);
assert.equal(await page.locator('.usage-popover .usage-head').count(),2,'usage details show only context and cache hit rate');
assert.equal(await page.locator('.usage-popover .usage-progress').count(),1);
assert.equal(await page.locator('.usage-popover .usage-actions, .usage-popover .usage-trend, .usage-popover .usage-part-list').count(),0);
await page.locator('.usage-trigger').click();
await page.mouse.move(300,300);
assert.equal(await page.locator('.usage-popover').count(),1,'click pins the usage details');
await page.locator('.topbar').click({position:{x:20,y:20}});
assert.equal(await page.locator('.usage-popover').count(),0);
await page.locator('.topbar').click({position:{x:20,y:20}});
await page.evaluate(()=>document.fonts.ready);
const cdp=await context.newCDPSession(page);
await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
const {root:dom}=await cdp.send('DOM.getDocument');
const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:dom.nodeId,selector:'.msg-model'});
const {fonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId});
assert(fonts.some(f=>f.isCustomFont&&f.familyName.includes('JetBrains Mono')),JSON.stringify(fonts));
await page.locator('.file-name-text',{hasText:'AGENTS.md'}).click();
await page.locator('.fp-markdown table').waitFor();
assert((await page.locator('.fp-file-path').textContent()).includes('AGENTS.md'));
assert.equal(await page.locator('.fp-title-row .fp-back').isVisible(),true);
assert.equal(await page.locator('.fp-foot').count(),0);
assert.equal(await page.locator('.inputbox .attach-chip.current-file').count(),1);
const editorGeometry=await page.evaluate(()=>{
const editor=document.querySelector('.drawer-right').getBoundingClientRect();
const chat=document.querySelector('.view-pane:not(.hidden) .main').getBoundingClientRect();
const table=document.querySelector('.fp-markdown table');
const code=table.querySelector('code');
return {share:editor.width/(editor.width+chat.width),scrollable:table.scrollWidth>table.clientWidth,whiteSpace:getComputedStyle(code).whiteSpace};
});
assert(Math.abs(editorGeometry.share-.45)<.002);
assert.equal(editorGeometry.whiteSpace,'nowrap');
const resize=await page.locator('.view-pane:not(.hidden) .resize-right').boundingBox();
await page.mouse.move(resize.x+resize.width/2,resize.y+100);await page.mouse.down();await page.mouse.move(resize.x-100,resize.y+100);await page.mouse.up();
assert((await page.locator('.drawer-right').boundingBox()).width>geometry.right.w+200);
await page.locator('.fp-more').evaluate(e=>e.open=true);
await page.locator('.fp-more-actions').getByRole('button',{name:'编辑文件'}).click();
await page.locator('.fp-rich-document h1').click();await page.keyboard.press('End');await page.keyboard.type(' edited');
await page.locator('.fp-header-status',{hasText:'未保存'}).waitFor();
const save=page.locator('.fp-header-save');
assert.equal(await save.isVisible(),true);
assert.equal(await save.evaluate(e=>{const b=e.getBoundingClientRect();return e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))}),true);
await page.screenshot({path:'/private/tmp/pi-review-editor.png'});
await save.click();await page.locator('.fp-header-status',{hasText:'已保存'}).waitFor();
assert.equal(await save.count(),0);
await page.locator('.fp-back').click();
console.log('PASS review: goal events, timing, font actually rendered, single footer, editor title/save/table/resize/attachment');

const shortPage=await context.newPage();
const shortAt=Date.now()-6*60*60*1000;
let shortSocket,shortState;
const shortMessages=[
{id:'short-question',role:'user',timestamp:shortAt,content:[{type:'text',text:'请帮我看一下'}]},
{id:'short-answer',role:'assistant',timestamp:shortAt+60_000,content:[{type:'thinking',thinking:'检查中'},{type:'text',text:'已经检查。'}]},
{id:'short-goal',role:'user',timestamp:shortAt+5*60*60*1000,content:[{type:'text',text:'【目标已设定】\n\n继续审查\n\n请现在开始实现这个目标。'}]},
];
await shortPage.routeWebSocket('**/ws',route=>{shortSocket=route;const upstream=route.connectToServer();route.onMessage(wire=>upstream.send(wire));upstream.onMessage(wire=>{const message=JSON.parse(wire.toString());if(message.type==='snapshot'){Object.assign(message.state,{messages:shortMessages,piConfigured:true});shortState=message.state;}route.send(JSON.stringify(message));});});
await shortPage.goto(`http://localhost:${PORT}`);
await shortPage.locator('.goal-event').waitFor();
await shortPage.locator('.qn-bar').waitFor();
const shortLayout=await shortPage.evaluate(()=>{
const messages=document.querySelector('.messages');const event=document.querySelector('.goal-event');const answer=document.querySelector('[data-msg-id="short-answer"]');const rail=document.querySelector('.qn-rail');const marker=document.querySelector('.qn-bar');const question=document.querySelector('[data-msg-id="short-question"]');
const eventTop=event.getBoundingClientRect().top;const answerBottom=answer.getBoundingClientRect().bottom;const eventBottom=event.getBoundingClientRect().bottom;const viewportBottom=messages.getBoundingClientRect().bottom;
const markerPosition=(marker.getBoundingClientRect().top-rail.getBoundingClientRect().top)/rail.getBoundingClientRect().height;
const questionPosition=(question.getBoundingClientRect().top-messages.getBoundingClientRect().top+messages.scrollTop)/messages.scrollHeight;
return {eventTop,answerBottom,eventBottom,viewportBottom,markerPosition,questionPosition};
});
assert(shortLayout.eventTop>=shortLayout.answerBottom && shortLayout.eventBottom<=shortLayout.viewportBottom,JSON.stringify(shortLayout));
assert(Math.abs(shortLayout.markerPosition-shortLayout.questionPosition)<.06,JSON.stringify(shortLayout));
assert((await shortPage.locator('.thinking-duration').textContent()).includes('未记录'));
assert((await shortPage.locator('.time-gap').getAttribute('title')).includes(String(new Date(shortAt).getFullYear())));
const helloMessage={id:'spacing-hello',role:'user',content:[{type:'text',text:'hello'}]};
const showSpacing=(streamingMessage)=>{shortState={...shortState,rev:shortState.rev+1,messages:[helloMessage],isStreaming:true,streamingMessage,model:{id:'glm-5.3',name:'GLM 5.3',provider:'volc-glm'}};shortSocket.send(JSON.stringify({type:'snapshot',state:shortState}));};
const measureSpacing=()=>shortPage.evaluate(()=>{
const bubble=document.querySelector('[data-msg-id="spacing-hello"] .msg-body').getBoundingClientRect();
const placeholder=document.querySelector('.agent-working-placeholder');
const meta=placeholder.querySelector('.msg-meta').getBoundingClientRect();
const status=placeholder.querySelector('.waiting-header-status').getBoundingClientRect();
return {betweenMessages:meta.top-bubble.bottom,statusGap:status.top-meta.bottom,emptyAssistant:document.querySelector('[data-msg-id="spacing-empty"]')!==null,emptyBody:placeholder.querySelector('.msg-body')!==null};
});
showSpacing(null);
await shortPage.locator('.agent-working-placeholder .waiting-header-status',{hasText:'正在分析请求'}).waitFor();
const pendingSpacing=await measureSpacing();
showSpacing({id:'spacing-empty',role:'assistant',model:'glm-5.3',content:[{type:'thinking',thinking:''},{type:'text',text:''}]});
await shortPage.waitForTimeout(50);
const emptySpacing=await measureSpacing();
for(const spacing of [pendingSpacing,emptySpacing]){
assert(spacing.betweenMessages>=20&&spacing.betweenMessages<=24,JSON.stringify(spacing));
assert(spacing.statusGap>=6&&spacing.statusGap<=10,JSON.stringify(spacing));
assert.equal(spacing.emptyAssistant,false,JSON.stringify(spacing));
assert.equal(spacing.emptyBody,false,JSON.stringify(spacing));
}
showSpacing({id:'spacing-content',role:'assistant',model:'glm-5.3',content:[{type:'thinking',thinking:''},{type:'text',text:'回复开始'}]});
await shortPage.locator('[data-msg-id="spacing-content"] .msg-text',{hasText:'回复开始'}).waitFor();
assert.equal(await shortPage.locator('[data-msg-id="spacing-content"] .thinking').count(),0,'empty thinking shell is omitted after text starts');
assert.equal(await shortPage.locator('.agent-working-placeholder').count(),0);
await shortPage.close();

const navPage=await context.newPage();
const longQuestion='1. Q1 使用范围：确认研究计划\n\nCampaign\n├── Batch\n│  └── Forecast\n\n'+Array.from({length:36},(_,i)=>`说明 ${i+1}：这是一段需要保留的长消息。`).join('\n\n');
const asciiTable=['另外四处需要修正','位置 │ 问题 │ 修改建议','─'.repeat(180),'网关文档:23 (docs/research/llm-gateway-options.md:23) │ TPM/RPM 被写成并发限额 │ 单独定义在途请求数','─'.repeat(180),'Tiingo 文档:48 │ EODHD 价格不准确 │ 改为候选之一','─'.repeat(180),'gVisor 文档:21 │ mmap 默认错误 │ 分别测试','─'.repeat(180),'运行时文档:9 │ 标签缺失 │ 补齐标签'].join('\n');
const navMessages=[...Array.from({length:5},(_,i)=>({id:`nav-${i}`,role:'user',timestamp:timestamp+i*60_000,content:[{type:'text',text:i===0?longQuestion:i===1?asciiTable:i===2?'3. Q3 继续确认 docs/research/llm-gateway-options.md:23':`${i+1}. Q${i+1} 继续确认` }]})),{id:'nav-reply',role:'assistant',timestamp:timestamp+6*60_000,content:[{type:'text',text:Array.from({length:80},(_,i)=>`回答段落 ${i+1}。`).join('\n\n')}]}];
await navPage.routeWebSocket('**/ws',route=>{const upstream=route.connectToServer();route.onMessage(wire=>upstream.send(wire));upstream.onMessage(wire=>{const message=JSON.parse(wire.toString());if(message.type==='snapshot')Object.assign(message.state,{messages:navMessages,piConfigured:true});if(message.type==='scm_data'){message.files=[];message.notRepo=false;}route.send(JSON.stringify(message));});});
await navPage.goto(`http://localhost:${PORT}`);
await navPage.locator('.qn-rail.many').waitFor();
await navPage.locator('.messages').evaluate(el=>el.scrollTop=0);
await navPage.locator('[data-msg-id="nav-0"] .user-message-expand').waitFor();
assert.equal(await navPage.locator('[data-msg-id="nav-1"] .user-message-content.collapsed').count(),1,'long pasted tables fold by default');
assert.equal(await navPage.locator('[data-msg-id="nav-1"] .ascii-table').count(),1,'box-drawing tables use a dedicated preserved block');
const asciiGeometry=await navPage.locator('[data-msg-id="nav-1"] .msg-body').evaluate(el=>({bubble:el.getBoundingClientRect().width,content:el.scrollWidth,table:el.querySelector('.ascii-table pre')?.scrollWidth,viewport:el.querySelector('.ascii-table pre')?.clientWidth}));
assert(asciiGeometry.content<=asciiGeometry.bubble+2,JSON.stringify(asciiGeometry));
assert(asciiGeometry.table>asciiGeometry.viewport,'wide table scrolls inside its block');
await navPage.locator('[data-msg-id="nav-1"] .user-message-expand').click();
await navPage.screenshot({path:'/private/tmp/pi-ascii-table-fix.png'});
await navPage.locator('[data-msg-id="nav-1"] .ascii-table a',{hasText:'docs/research/llm-gateway-options.md:23'}).click();
await navPage.locator('.fp-file-path',{hasText:'llm-gateway-options.md'}).waitFor();
await navPage.locator('.fp-line[data-line="23"].from-tool, .fp-edit-line[data-line="23"].from-tool, .fp-markdown [data-source-start="23"].from-tool').waitFor();
await navPage.locator('.fp-back').click();
await navPage.locator('[data-msg-id="nav-2"] .md a',{hasText:'docs/research/llm-gateway-options.md:23'}).click();
await navPage.locator('.fp-markdown [data-source-start="23"].from-tool').waitFor();
await navPage.locator('.fp-back').click();
assert.equal(await navPage.locator('.panel-right .tree-filter', { hasText: /^(改动|Changes)(?:\s|$)/ }).count(),0,'zero changes is hidden');
assert.equal(await navPage.locator('.panel-right .tree-hidden-toggle').isVisible(),false,'hidden-file control stays in the menu');
await navPage.locator('.panel-right .tree-menu-trigger').click();
assert.equal(await navPage.locator('.panel-right .tree-hidden-toggle').getAttribute('role'),'switch');
await navPage.locator('.topbar').click({position:{x:20,y:20}});
assert.match(await navPage.locator('[data-msg-id="nav-0"] .user-message-expand').textContent(),/展开全部 · \d+ 行/);
assert.equal(await navPage.locator('.msg-user pre code').first().textContent(),'Campaign\n├── Batch\n│  └── Forecast\n');
assert.equal(await navPage.locator('[data-msg-id="nav-0"] .user-message-content.collapsed').count(),1);
await navPage.locator('[data-msg-id="nav-0"] .user-message-expand').click();
assert.equal(await navPage.locator('[data-msg-id="nav-0"] .user-message-content.collapsed').count(),0);
await navPage.locator('.qn-rail').hover();
await navPage.locator('.qn-rail.open').waitFor();
await navPage.locator('.qn-list').waitFor({state:'visible'});
await navPage.waitForTimeout(200);
const navGeometry=await navPage.locator('.qn-list').evaluate(el=>({height:el.getBoundingClientRect().height,viewport:innerHeight,background:getComputedStyle(el).backgroundColor,opacity:getComputedStyle(el).opacity}));
assert(navGeometry.height<300&&navGeometry.height<=navGeometry.viewport*.6,JSON.stringify(navGeometry));
assert.equal(navGeometry.background,'rgb(255, 255, 255)');
assert.equal(navGeometry.opacity,'1');
assert.match(await navPage.locator('.qn-list-text').first().textContent(),/^Q1 使用范围/);
await navPage.screenshot({path:'/private/tmp/pi-question-nav-fix.png'});
await navPage.locator('.topbar').click({position:{x:20,y:20}});
assert.equal(await navPage.locator('.qn-list').isVisible(),false);
await navPage.close();

const bashPage=await context.newPage();
const bashCommand='echo "=== FIRST ==="; pwd; echo "=== SECOND ==="; ls '+Array.from({length:6},()=>'/Users/alice/projects/missing').join(' ')+'; ls .assets';
const bashLines=['=== FIRST ===','/tmp','=== SECOND ===',...Array.from({length:9},(_,i)=>`normal output ${i}`),'ls: /Users/alice/projects/missing: No such file or directory',...Array.from({length:7},(_,i)=>`more output ${i}`),'Command exited with code 1'];
assert.equal(bashLines.length,21);
const bashMessages=[
{id:'bash-user',role:'user',content:[{type:'text',text:'Check two locations'}]},
{id:'bash-call',role:'assistant',content:[{type:'toolCall',id:'bash-ui',name:'bash',argumentsText:JSON.stringify({command:bashCommand})}]},
{id:'bash-result',role:'toolResult',toolCallId:'bash-ui',toolName:'bash',isError:true,content:[{type:'text',text:bashLines.join('\n')}]},
];
await bashPage.routeWebSocket('**/ws',route=>{const upstream=route.connectToServer();route.onMessage(wire=>upstream.send(wire));upstream.onMessage(wire=>{const message=JSON.parse(wire.toString());if(message.type==='snapshot')Object.assign(message.state,{messages:bashMessages,piConfigured:true});route.send(JSON.stringify(message));});});
await bashPage.goto(`http://localhost:${PORT}`);
await bashPage.locator('.toolcall.partial .toolcall-status',{hasText:'部分失败 · 1/2 步成功'}).waitFor();
await bashPage.locator('.tree-filter', { hasText: /^(改动|Changes)(?:\s|$)/ }).click();
await bashPage.locator('.file-dir-main',{hasText:'.assets'}).waitFor();
assert.equal(await bashPage.locator('.bash-head-command').getAttribute('aria-expanded'), 'false');
await bashPage.locator('.bash-head-command').click();
assert.equal(await bashPage.locator('.bash-head-command').getAttribute('aria-expanded'), 'true');
if (await bashPage.locator('.bash-card-more > summary').count()) await bashPage.locator('.bash-card-more > summary').click();
await bashPage.locator('.bash-view-switch button',{hasText:'原始'}).click();
await bashPage.locator('.bash-output-label',{hasText:'输出 · 21 行 · 疑似错误 1 行'}).waitFor();
assert.equal(await bashPage.locator('.bash-output-line.error').count(),1,'error line remains visible in collapsed output');
assert.equal(await bashPage.locator('.bash-output-line.error .bash-line-number').textContent(),'13');
assert.equal(await bashPage.locator('.toolcall-bash code').first().evaluate(el=>getComputedStyle(el).fontVariantLigatures),'none');
await bashPage.screenshot({path:'/private/tmp/pi-bash-presentation.png'});
await bashPage.close();

const searchPage=await context.newPage();
const searchMessages=[
{id:'search-user',role:'user',content:[{type:'text',text:'Check the date and matching lines'}]},
{id:'search-call',role:'assistant',content:[{type:'toolCall',id:'mixed-grep',name:'bash',argumentsText:JSON.stringify({command:'date +%F; git branch --show-current; echo "---"; grep -rn pattern docs'})}]},
{id:'search-result',role:'toolResult',toolCallId:'mixed-grep',toolName:'bash',isError:false,content:[{type:'text',text:'2026-09-27\nmain\n---\ndocs/ARCHITECTURE.md:212: matched\n'}]},
];
await searchPage.routeWebSocket('**/ws',route=>{const upstream=route.connectToServer();route.onMessage(wire=>upstream.send(wire));upstream.onMessage(wire=>{const message=JSON.parse(wire.toString());if(message.type==='snapshot')Object.assign(message.state,{messages:searchMessages,piConfigured:true});route.send(JSON.stringify(message));});});
await searchPage.goto(`http://localhost:${PORT}`);
await searchPage.locator('.bash-output-line').first().waitFor();
assert.equal(await searchPage.locator('.bash-output-line').first().locator('.bash-line-number').textContent(),'1');
assert.equal(await searchPage.locator('.bash-output-line').first().locator('.bash-line-text').textContent(),'2026-09-27');
assert.equal(await searchPage.locator('.bash-output-line').nth(3).locator('.bash-line-number').textContent(),'212');
await searchPage.close();

for(const width of [1100,900,390]){
await page.setViewportSize({width,height:900});await page.waitForTimeout(250);
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`overflow at ${width}`);
assert.equal(await page.locator('.usage-trigger').isVisible(),true,`usage control remains visible at ${width}`);
if(width<1100)assert.equal(await page.locator('.usage-cache-short').isVisible(),false);
assert((await page.locator('.input-tools .btn.send').first().boundingBox()).width>=30,`send control shrank at ${width}`);
}
assert.deepEqual(errors,[]);
}finally{await browser?.close();server?.kill('SIGTERM');await sleep(200);}
