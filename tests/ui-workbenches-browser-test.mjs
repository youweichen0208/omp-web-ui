import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';
const port=9261, root=mkdtempSync(join(tmpdir(),'pi-fluid-'));
const cwd=join(root,'pi-harness');mkdirSync(cwd);writeFileSync(join(cwd,'README.md'),'# Project\n');
execFileSync('git',['init','-b','main'],{cwd,stdio:'ignore'});
execFileSync('git',['config','user.name','Fixture'],{cwd});execFileSync('git',['config','user.email','fixture@example.com'],{cwd});
writeFileSync(join(cwd,'sample.ts'),'export const ready = true;\n');
writeFileSync(join(cwd,'README.md'),'# Project guide\n\n这是一份用于检查阅读布局的文档。\n\n## Installation\n\nRun the setup command and verify the service status.\n\n```bash\nnpm run build\n```\n\n## Configuration\n\n| Setting | Description |\n| --- | --- |\n| workspace | Local project directory |\n');
execFileSync('git',['add','.'],{cwd});execFileSync('git',['commit','-m','fixture'],{cwd,stdio:'ignore'});
writeFileSync(join(cwd,'sample.ts'),'export const ready = false;\n');
let server,browser;
try {
	assert.equal(await portUp(port),false);
	server=spawn(process.execPath,['dist/server/index.js'],{env:{...process.env,PORT:String(port),PI_WEB_CWD:cwd,PI_WEB_DATA_DIR:join(root,'data'),PI_CODING_AGENT_DIR:join(root,'agent')},stdio:'ignore'});
	for(let i=0;i<100&&!await portUp(port);i++)await sleep(150);
	assert(await portUp(port));
	browser=await chromium.launch({executablePath:CHROME_PATH});
	mkdirSync('tests/scratch',{recursive:true});
	const page=await browser.newPage({viewport:{width:1440,height:960}});
	const errors=[];page.on('pageerror',e=>errors.push(String(e)));
	await page.goto(`http://localhost:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	await page.locator('.workspace-group-manager input').fill('Engineering');
	await page.locator('.workspace-group-actions button[type=submit]').click();
	await page.locator('.workspace-outside button').click();
	await page.locator('.project-item.active').waitFor();
	for(const [label,selector] of [['终端','.terminal-view'],['节点','.node-workbench'],['Git','.scm-view']]) {
		await page.getByRole('tab',{name:label,exact:true}).click();
		await page.locator(selector).waitFor();
		if(label==='Git') { await page.locator('.scm-file').first().click();await page.locator('.scm-diff-pre').first().waitFor(); }
		await sleep(500);
		for(const width of [1440,768,375]) {
			await page.setViewportSize({width,height:900});
			for(const theme of ['light','dark']) {
				await page.evaluate(theme=>document.documentElement.dataset.appearance=theme,theme);await sleep(350);
				if(label==='Git' && width===375) {
					const list=await page.locator('.scm-files').boundingBox(),diff=await page.locator('.scm-diff').boundingBox();
					assert(diff.y>=list.y+list.height-1,'mobile diff follows file list');assert(diff.width>=width-4,'diff uses available width');
				}
				await page.screenshot({path:`tests/scratch/workbench-${label}-${width}-${theme}.png`});
				assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'document overflow');
			}
		}
		await page.setViewportSize({width:1440,height:900});
	}
	await page.getByRole('tab',{name:'对话',exact:true}).click();
	await page.locator('[data-tree-node="README.md"]').click();
	await page.locator('.wiki-document').waitFor();
	for(const width of [1440,768,375]) {
		await page.setViewportSize({width,height:900});
		for(const theme of ['light','dark']) {
			await page.evaluate(theme=>document.documentElement.dataset.appearance=theme,theme);await sleep(350);
			await page.screenshot({path:`tests/scratch/workbench-wiki-${width}-${theme}.png`});
			assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
		}
	}
	await page.getByRole('tab',{name:'对话',exact:true}).click();
	await page.keyboard.press('Control+p');
	await page.locator('.gs-input-row input').fill('README');
	await page.locator('.gs-item',{hasText:'README.md'}).click();
	await page.locator('.wiki-document').waitFor();
	await page.locator('.wiki-chat-panel').waitFor({state:'detached'});
	assert.equal(await page.locator('.wiki-chat-panel').count(),0,'mobile opens document first');
	await page.screenshot({path:'tests/scratch/workbench-wiki-mobile-reading.png'});
	await page.locator('.wiki-chat-toggle').click();
	await page.locator('.wiki-chat-panel').waitFor();
	assert.deepEqual(errors,[]);
	console.log('PASS workbench layouts: terminal, nodes and Git at 375/768/1440 light/dark');
} finally { await browser?.close();server?.kill('SIGTERM');await sleep(300);rmSync(root,{recursive:true,force:true}); }
