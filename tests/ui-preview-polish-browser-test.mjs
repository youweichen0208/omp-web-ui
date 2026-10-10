import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';
const port=9262, root=mkdtempSync(join(tmpdir(),'pi-fluid-'));
const cwd=join(root,'pi-harness');mkdirSync(cwd);writeFileSync(join(cwd,'README.md'),'# Project\n');
writeFileSync(join(cwd,'sample.ts'),'export const ready = true;\n');
writeFileSync(join(cwd,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'));
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
	// Generate deterministic media locally; no downloads or external encoders.
	const fixtures=await page.evaluate(async()=>{
		const canvas=document.createElement('canvas');canvas.width=2400;canvas.height=1600;
		const ctx=canvas.getContext('2d');ctx.fillStyle='#e8f1f7';ctx.fillRect(0,0,2400,1600);
		ctx.fillStyle='#2f7aae';ctx.fillRect(120,120,2160,1360);ctx.fillStyle='white';ctx.font='90px sans-serif';ctx.fillText('Preview · 2400 × 1600',220,800);
		const png=canvas.toDataURL('image/png').split(',')[1];
		canvas.width=640;canvas.height=360;
		const stream=canvas.captureStream(10),chunks=[];
		const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
		const stopped=new Promise(resolve=>{recorder.onstop=resolve;});
		recorder.ondataavailable=e=>chunks.push(e.data);recorder.start();
		for(let i=0;i<5;i++){ctx.fillStyle=i%2?'#2f7aae':'#e8f1f7';ctx.fillRect(0,0,640,360);await new Promise(r=>setTimeout(r,100));}
		recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());
		return {png,video:Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))};
	});
	writeFileSync(join(cwd,'landscape.png'),Buffer.from(fixtures.png,'base64'));
	writeFileSync(join(cwd,'clip.webm'),Buffer.from(fixtures.video));

	await page.goto(`http://localhost:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	await page.locator('.workspace-group-manager input').fill('Engineering');
	await page.locator('.workspace-group-actions button[type=submit]').click();
	await page.locator('.workspace-outside button').click();
	await page.locator('.project-item.active').waitFor();
	await page.locator('[data-tree-node="sample.ts"]').click();
	const editor=page.locator('.fp-editor');await editor.waitFor();
	await editor.fill('export const ready = false;\n');
	await page.locator('.fp-header-save').click();
	await page.waitForFunction(()=>!document.querySelector('.fp-header-save'));
	assert.equal(readFileSync(join(cwd,'sample.ts'),'utf8'),'export const ready = false;\n');
	for(const width of [1440,1024,768,375]) {
		await page.setViewportSize({width,height:900});
		await sleep(350);
		if(width<=768) {
			const box=await editor.boundingBox();
			if(box.x>=width || box.x+box.width<=0) await page.locator('.topbar-actions > .panel-toggle').click();
		}
		for(const theme of ['light','dark']) {
			await page.evaluate(theme=>document.documentElement.dataset.appearance=theme,theme);await sleep(350);
			assert(await editor.isVisible());
			const box=await editor.boundingBox();assert(box.x<width && box.x+box.width>0,'editor intersects the viewport');
			assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
			await page.screenshot({path:`tests/scratch/polish-preview-${width}-${theme}.png`});
		}
	}
	await page.emulateMedia({reducedMotion:'reduce'});
	await page.setViewportSize({width:844,height:390});
	assert(await editor.isVisible());

	await page.setViewportSize({width:1440,height:960});await sleep(350);
	await page.keyboard.press('Control+p');
	await page.locator('.gs-input-row input').fill('landscape.png');
	await page.locator('.gs-item',{hasText:'landscape.png'}).click();
	const media=page.locator('.fp-media');await media.waitFor();
	await page.waitForFunction(()=>{const img=document.querySelector('img.fp-media');return img?.complete && img.naturalWidth>0;});
	assert.equal(await media.getAttribute('alt'),'landscape.png');
	assert.equal(await page.locator('.fp-header-status').count(),0,'read-only media has no save status');
	for(const width of [1440,1024,768,375]) {
		await page.setViewportSize({width,height:900});await sleep(350);
		let box=await media.boundingBox();
		if(box.x>=width||box.x+box.width<=0) {await page.locator('.topbar-actions > .panel-toggle').click();await sleep(350);}
		for(const theme of ['light','dark']) {
			await page.evaluate(theme=>document.documentElement.dataset.appearance=theme,theme);
			box=await media.boundingBox();assert(box.x>=0 && box.x+box.width<=width && box.y>=0 && box.y+box.height<=900,'image fits viewport');
			await page.screenshot({path:`tests/scratch/polish-image-${width}-${theme}.png`});
		}
	}
	await page.setViewportSize({width:1440,height:960});await sleep(350);
	await page.keyboard.press('Control+p');await page.locator('.gs-input-row input').fill('clip.webm');
	await page.locator('.gs-item',{hasText:'clip.webm'}).click();
	const video=page.locator('video.fp-media');await video.waitFor();
	await page.waitForFunction(()=>document.querySelector('video.fp-media')?.readyState>=2);
	assert(await video.evaluate(async el=>{el.muted=true;await el.play();return !el.paused&&el.videoWidth===640&&el.controls;}));
	await page.waitForFunction(()=>document.querySelector('video.fp-media')?.currentTime>0);
	await video.evaluate(el=>el.pause());
	for(const width of [1440,1024,768,375]) {
		await page.setViewportSize({width,height:900});await sleep(350);
		let box=await video.boundingBox();if(box.x>=width||box.x+box.width<=0){await page.locator('.topbar-actions > .panel-toggle').click();await sleep(350);}
		box=await video.boundingBox();assert(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=900);
		for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.appearance=theme,theme);await page.screenshot({path:`tests/scratch/polish-video-${width}-${theme}.png`});}
	}
	assert.deepEqual(errors,[]);
	console.log('PASS code preview: editing and disk save, four widths, large image and playable video, light/dark, landscape and reduced motion');
} finally { await browser?.close();server?.kill('SIGTERM');await sleep(300);rmSync(root,{recursive:true,force:true}); }
