/** Electron regression: an unexpected server child exit restores the same URL. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {_electron as electron} from 'playwright-core';

const root=mkdtempSync(join(tmpdir(),'pi-desktop-recovery-'));
const cwd=join(root,'workspace');mkdirSync(cwd);
const childPid=(parent)=>{
	const rows=execFileSync('ps',['-Ao','pid=,ppid=,command='],{encoding:'utf8'}).split('\n');
	for(const row of rows){
		const match=row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		if(match&&Number(match[2])===parent&&match[3].includes('dist/server/index.js'))return Number(match[1]);
	}
	return null;
};
let app;
try {
	app=await electron.launch({args:['.',`--user-data-dir=${join(root,'profile')}`],env:{...process.env,PI_WEB_DATA_DIR:join(root,'data'),PI_WEB_CWD:cwd,PI_CODING_AGENT_DIR:join(root,'agent')}});
	let page;
	for(let n=0;n<200;n++){
		page=app.windows().find(window=>window.url().startsWith('http://127.0.0.1:'));
		if(page)break;
		await sleep(100);
	}
	assert(page,'desktop window loaded');
	const url=page.url();
	const original=childPid(app.process().pid);
	assert(original,'server child is running');
	process.kill(original,'SIGKILL');
	let replacement;
	for(let n=0;n<160;n++){
		replacement=childPid(app.process().pid);
		if(replacement&&replacement!==original){
			try {if((await fetch(`${url}api/health`)).ok)break;}catch{}
		}
		await sleep(100);
	}
	assert(replacement&&replacement!==original,'desktop restarted the server child');
	assert.equal(page.url(),url,'window kept its URL and conversation state');
	assert((await fetch(`${url}api/health`)).ok,'server responds after restart');
	console.log('PASS desktop server recovery: same port and window URL');
} finally {await app?.close();}
