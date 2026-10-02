/** Actual SDK image dispatch and service persistence; local native provider, no paid calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.argv[2] || process.cwd());
const { ModelRuntime } = await import(pathToFileURL(join(root,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')));
const { ImageService } = await import(pathToFileURL(join(root,'dist/server/image-service.js')));
const directory = mkdtempSync(join(tmpdir(),'pi-images-sdk-'));
try {
	const runtime = await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:join(directory,'models.json')});
	const model = {type:'image',id:'fixture',name:'Fixture',provider:'image-fixture',api:'fixture-images',baseUrl:'http://127.0.0.1',input:['text','image'],output:['image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
	let scenario = 'success', held = [];
	runtime.registerNativeProvider({id:'image-fixture',name:'Fixture',auth:{apiKey:{name:'Fixture',resolve:async()=>({auth:{apiKey:'FIXTURE_SECRET'},source:'fixture'})}},getModels:()=>[],getAllModels:()=>[model],generateImages:async(_model,context,options)=>{
		assert.equal(options.apiKey,'FIXTURE_SECRET'); assert(context.input.some(c=>c.type==='text'));
		if (scenario === 'hold') await new Promise(resolve=>held.push(resolve));
		return {api:model.api,provider:model.provider,model:model.id,stopReason:scenario === 'error' ? 'error' : 'stop',errorMessage:scenario === 'error' ? 'Fixture failed' : undefined,output:[{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII='}],timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0.03,cacheRead:0,cacheWrite:0,total:0.03}}};
	}});
	const service = new ImageService(join(directory,'images')), wire=[];
	const message = {type:'image_request',requestId:'fixture',cwd:directory,action:'create',prompt:'Fixture image',provider:model.provider,model:model.id};
	const handle = (client,extra={}) => service.handle(client,runtime,{...message,...extra},m=>wire.push(m));
	await handle('success'); for(let i=0;i<30 && wire.at(-1)?.record?.status!=='done';i++) await new Promise(resolve=>setTimeout(resolve,10));
	const done = wire.at(-1).record; assert.equal(done.status,'done',done.error); assert.equal(done.usage.cost.total,0.03); assert(readFileSync(service.file(directory,done.id,0)).length>0); assert(!JSON.stringify(wire).includes('FIXTURE_SECRET')); assert(!JSON.stringify(wire).includes('iVBOR'));
	scenario='error'; await handle('failure'); for(let i=0;i<30 && wire.at(-1)?.record?.status!=='error';i++) await new Promise(resolve=>setTimeout(resolve,10)); assert.equal(wire.at(-1).record.status,'error');
	scenario='hold'; for(let i=0;i<4;i++) await handle(`slot-${i}`);
	await handle('overflow'); assert.match(wire.at(-1).error,/busy/);
	const running = wire.filter(m=>m.record?.status==='running'); const id=running.at(-1).record.id;
	await handle('foreign',{action:'cancel',id}); assert.match(wire.at(-1).error,/another client/);
	service.shutdown(); for(const release of held) release(); await new Promise(resolve=>setTimeout(resolve,30));
	const latest = new ImageService(join(directory,'images')); await latest.handle('reader',runtime,{...message,action:'list'},m=>wire.push(m));
	assert.equal(wire.at(-1).records.filter(r=>r.status==='cancelled').length,4);
	console.log('PASS SDK image models, credential isolation, cost, failures, four-slot limit, cancellation and restored history');
} finally { rmSync(directory,{recursive:true,force:true}); }
