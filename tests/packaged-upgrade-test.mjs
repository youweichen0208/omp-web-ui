// Read state written by the previous shipped runtime with the newly installed
// runtime. All data and credentials are fixtures; no model/network calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const phase = ["seed", "verify"].includes(args[0]) ? args.shift() : null;
const paths = args.map(p => resolve(p));
assert(paths.length === (phase ? 3 : 4), "Expected seed/verify executable/root/state-dir, or previous executable/root and current executable/root");
const temp = phase ? paths[2] : mkdtempSync(join(tmpdir(), "pi-upgrade-"));
for (const dir of ["agent", "data", "workspace"]) mkdirSync(join(temp, dir), { recursive: true });
const fixture = join(temp, "fixture.mjs");
writeFileSync(fixture, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const [mode,root,temp]=process.argv.slice(2);
const load=p=>import(pathToFileURL(root+'/'+p).href);
const require=createRequire(root+'/package.json');
const sdk=require.resolve.paths('@earendil-works/pi-coding-agent').map(p=>p+'/@earendil-works/pi-coding-agent/dist/index.js').find(p=>fs.existsSync(p));
assert(sdk,'SDK must be shipped with the runtime');
const {SessionManager}=await import(pathToFileURL(sdk).href);
const agent=temp+'/agent',data=temp+'/data',cwd=temp+'/workspace';
if(mode==='seed') {
 fs.writeFileSync(agent+'/settings.json',JSON.stringify({defaultTools:['read'],reviewPreference:'preserved'}));
 fs.writeFileSync(agent+'/auth.json',JSON.stringify({fixture:{type:'api_key',key:'fake-upgrade-fixture'}}));
 const session=SessionManager.create(cwd);
 session.appendMessage({role:'user',content:'upgrade-history-marker',timestamp:Date.now()});
 session.appendMessage({role:'assistant',content:[{type:'text',text:'upgrade-reply-marker'}],api:'openai-completions',provider:'fixture',model:'fixture',stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
 fs.mkdirSync(data+'/uploads/upgrade',{recursive:true});
 fs.writeFileSync(data+'/uploads/upgrade/attachment.txt','upgrade-attachment-marker');
 fs.writeFileSync(temp+'/session-path',session.getSessionFile());
 const {ClientStateStore}=await load('dist/server/client-state.js');
 const store=new ClientStateStore(data+'/client-state.json');
 store.saveSettings('upgrade',{thinkingWrap:false,toolsWrap:true});
 fs.writeFileSync(data+'/desktop-client-id','upgrade');
} else {
 const path=fs.readFileSync(temp+'/session-path','utf8');
 const before=fs.readFileSync(path,'utf8');
 const {ClientSession}=await load('dist/server/agent-service.js');
 const {ClientStateStore}=await load('dist/server/client-state.js');
 const {ThinkingDurationStore}=await load('dist/server/thinking-timing.js');
 const store=new ClientStateStore(data+'/client-state.json');
 assert.equal(store.getSettings('upgrade').thinkingWrap,false);
 assert.equal(store.getSettings('upgrade').toolsWrap,true);
 assert.equal(fs.readFileSync(data+'/desktop-client-id','utf8'),'upgrade');
 const client=await ClientSession.create('upgrade',cwd,store,new ThinkingDurationStore(data+'/timing.json'));
 try {
  assert.equal(client.conv.session.sessionFile,path);
  assert.equal(client.conv.session.messages.length,2);
  assert.match(JSON.stringify(client.conv.session.messages),/upgrade-history-marker/);
  assert.equal(JSON.parse(fs.readFileSync(agent+'/settings.json')).reviewPreference,'preserved');
  assert.equal(JSON.parse(fs.readFileSync(agent+'/auth.json')).fixture.key,'fake-upgrade-fixture');
  assert.equal(fs.readFileSync(data+'/uploads/upgrade/attachment.txt','utf8'),'upgrade-attachment-marker');
  assert(fs.readFileSync(path,'utf8').startsWith(before),'existing transcript entries are preserved');
 } finally { await client.dispose(); }
}
console.log('PASS packaged upgrade '+mode);
`);
try {
	const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", NODE_PATH: "", PI_CODING_AGENT_DIR: join(temp, "agent"), PI_WEB_DATA_DIR: join(temp, "data"), PI_WEB_CWD: join(temp, "workspace") };
	const runs = phase ? [[phase, paths[0], paths[1]]] : [["seed", paths[0], paths[1]], ["verify", paths[2], paths[3]]];
	for (const [mode, executable, root] of runs) {
		process.stdout.write(execFileSync(executable, [fixture, mode, root, temp], { env, cwd: temp, timeout: 60000, encoding: "utf8" }));
	}
} finally { if (!phase) rmSync(temp, { recursive: true, force: true }); }
