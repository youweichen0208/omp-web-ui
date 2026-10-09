import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore, SettingsManager, DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { extensionWork } from "../../server/extensions-worker.js";
import { sourceInfo, validateSource } from "../../server/extensions-model.js";
import { parseCatalog } from "../../server/extensions-catalog.js";

describe("native extension management",()=>{
	it("distinguishes index entry points while keeping native file identities", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-extension-names-"));
		const cwd = join(root, "project"), agentDir = join(root, "agent");
		mkdirSync(cwd); mkdirSync(agentDir);
		const paths = ["weather", "deploy"].map(name => join(agentDir, "extensions", name, "index.ts"));
		for (const path of paths) {
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, 'throw Error("listing must not execute extensions");');
		}
		try {
			let state = await extensionWork({ cwd, agentDir, action: "list" });
			for (const [index, name] of ["weather", "deploy"].entries()) {
				const file = state.packages.find(item => item.path === paths[index]);
				expect(file).toMatchObject({ name, id: `file:user:${paths[index]}`, source: paths[index], kind: "file" });
			}
			const id = `file:user:${paths[0]}`;
			state = await extensionWork({ cwd, agentDir, action: "mutate", version: state.version, operation: { action: "toggle", id, enabled: false } });
			expect(state.packages.find(item => item.id === id)).toMatchObject({ name: "weather", enabled: false });
			expect(state.packages.find(item => item.path === paths[1])?.enabled).toBe(true);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("preserves filters and unrelated settings, persists native switches, moves scope and removes only local references",async()=>{
		const root=mkdtempSync(join(tmpdir(),"pi-extension-test-")),cwd=join(root,"project"),agentDir=join(root,"agent"),pkg=join(root,"package");
		mkdirSync(cwd);mkdirSync(agentDir);mkdirSync(pkg);mkdirSync(join(pkg,"extensions"));mkdirSync(join(agentDir,"extensions"));
		writeFileSync(join(pkg,"package.json"),JSON.stringify({name:"fixture-package",version:"1.0.0",pi:{extensions:["extensions/*.js"]}}));
		writeFileSync(join(pkg,"extensions/a.js"),'throw Error("must not execute while browsing");');
		writeFileSync(join(pkg,"extensions/b.js"),'throw Error("must not execute while browsing");');
		const single=join(agentDir,"extensions/single.js");writeFileSync(single,"export default () => {};");
		const original={source:pkg,extensions:["extensions/a.js"],skills:[]};
		writeFileSync(join(agentDir,"settings.json"),JSON.stringify({packages:[original],codemode:{mode:"only"},custom:{preserved:true}}));
		const input={cwd,agentDir};
		try{
			let state=await extensionWork({...input,action:"list"});
			expect(state.packages.find(p=>p.source===pkg)?.resources.extensions).toHaveLength(2);
			const id=`user:${pkg}`;
			state=await extensionWork({...input,action:"mutate",version:state.version,operation:{action:"toggle",id,enabled:false}});
			expect(state.packages.find(p=>p.id===id)?.enabled).toBe(false);
			const settings=SettingsManager.create(cwd,agentDir);const manager=new DefaultPackageManager({...input,settingsManager:settings});
			expect((await manager.resolve(async()=>"skip")).extensions.filter(r=>r.metadata.origin==="package").every(r=>!r.enabled)).toBe(true);
			state=await extensionWork({...input,action:"mutate",version:state.version,operation:{action:"toggle",id,enabled:true}});
			expect(JSON.parse(readFileSync(join(agentDir,"settings.json"),"utf8")).packages).toEqual([original]);
			const file=state.packages.find(p=>p.kind==="file")!;
			state=await extensionWork({...input,action:"mutate",version:state.version,operation:{action:"toggle",id:file.id,enabled:false}});
			expect(state.packages.find(p=>p.id===file.id)?.enabled).toBe(false);
			await expect(extensionWork({...input,action:"mutate",version:"stale",operation:{action:"remove",id}})).rejects.toThrow(/changed/);
			await expect(extensionWork({...input,action:"mutate",version:state.version,operation:{action:"move",id}})).rejects.toThrow(/trusted/);
			new ProjectTrustStore(agentDir).set(cwd,true);
			state=await extensionWork({...input,action:"mutate",version:state.version,operation:{action:"move",id}});
			expect(state.packages.find(p=>p.source===pkg)?.scope).toBe("project");
			expect(JSON.parse(readFileSync(join(cwd,".pi/settings.json"),"utf8")).packages).toEqual([original]);
			state=await extensionWork({...input,action:"mutate",version:state.version,operation:{action:"remove",id:`project:${pkg}`}});
			expect(state.packages.some(p=>p.source===pkg)).toBe(false);expect(existsSync(join(pkg,"extensions/a.js"))).toBe(true);
			expect(JSON.parse(readFileSync(join(agentDir,"settings.json"),"utf8")).custom).toEqual({preserved:true});
		}finally{rmSync(root,{recursive:true,force:true});}
	});
	it("lists untrusted project declarations without executing or installing them",async()=>{
		const root=mkdtempSync(join(tmpdir(),"pi-extension-untrusted-")),cwd=join(root,"project"),agentDir=join(root,"agent");mkdirSync(cwd);mkdirSync(agentDir);mkdirSync(join(cwd,".pi"));
		writeFileSync(join(cwd,".pi/settings.json"),JSON.stringify({packages:["npm:never-install-untrusted-fixture"]}));
		try{const state=await extensionWork({cwd,agentDir,action:"list"});expect(state.packages[0].trusted).toBe(false);expect(state.packages[0].path).toBeUndefined();}finally{rmSync(root,{recursive:true,force:true});}
	});
	it("updates only the selected scope with the native npmCommand and skips pinned versions",async()=>{
		const root=mkdtempSync(join(tmpdir(),"pi-extension-update-")),cwd=join(root,"project"),agentDir=join(root,"agent");mkdirSync(cwd);mkdirSync(agentDir);mkdirSync(join(cwd,".pi"));
		const command=join(root,"npm-fixture.mjs");
		writeFileSync(command,`import {mkdirSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; const args=process.argv.slice(2); if(args[0]==='view') console.log(JSON.stringify('1.1.0')); else if(args[0]==='install'){const path=join(args[args.indexOf('--prefix')+1],'node_modules','fixture-tools');mkdirSync(path,{recursive:true});writeFileSync(join(path,'package.json'),JSON.stringify({name:'fixture-tools',version:'1.1.0',pi:{extensions:[]}}));}else if(args[0]==='root')console.log(${JSON.stringify(join(root,"global"))});`);
		const source="npm:fixture-tools@latest",pinned="npm:pinned-tools@1.0.0";
		writeFileSync(join(agentDir,"settings.json"),JSON.stringify({npmCommand:[process.execPath,command],packages:[source,pinned]}));
		writeFileSync(join(cwd,".pi/settings.json"),JSON.stringify({packages:[source]}));new ProjectTrustStore(agentDir).set(cwd,true);
		const user=join(agentDir,"npm/node_modules/fixture-tools/package.json"),project=join(cwd,".pi/npm/node_modules/fixture-tools/package.json"),pin=join(agentDir,"npm/node_modules/pinned-tools/package.json");
		for(const file of [user,project,pin]){mkdirSync(join(file,".."),{recursive:true});writeFileSync(file,JSON.stringify({name:file===pin?"pinned-tools":"fixture-tools",version:"1.0.0",pi:{extensions:[]}}));}
		try{
			let state=await extensionWork({cwd,agentDir,action:"check"});expect(state.packages.filter(p=>p.update)).toHaveLength(2);expect(state.packages.find(p=>p.source===pinned)?.update).toBe(false);
			state=await extensionWork({cwd,agentDir,action:"mutate",version:state.version,operation:{action:"update",id:`project:${source}`}});
			expect(JSON.parse(readFileSync(user,"utf8")).version).toBe("1.0.0");expect(JSON.parse(readFileSync(project,"utf8")).version).toBe("1.1.0");
			await extensionWork({cwd,agentDir,action:"mutate",version:state.version,operation:{action:"update-all"}});
			expect(JSON.parse(readFileSync(user,"utf8")).version).toBe("1.1.0");expect(JSON.parse(readFileSync(pin,"utf8")).version).toBe("1.0.0");
		}finally{rmSync(root,{recursive:true,force:true});}
	});

	it("parses actual catalog data as text and preserves source pins",()=>{
		const result=parseCatalog('<article data-package-card="true" data-package-name="@scope/name" data-package-types="extension skill" data-package-downloads="123" data-package-date="1234"><p class="packages-desc">A &amp; B</p><div class="packages-meta"><span>author</span></div><a href="https://example.com/?package-version=1.2.3">report</a></article><a href="/packages?page=4">4</a>',1);
		expect(result.items[0]).toMatchObject({name:"@scope/name",description:"A & B",downloads:123,types:["extension","skill"],version:"1.2.3"});expect(result.pages).toBe(4);expect(result.total).toBeUndefined();
		expect(parseCatalog('<div class="packages-grid"></div><span class="packages-count">1-50 / 5,350</span>',1).total).toBe(5350);
		expect(sourceInfo("npm:@scope/name@1.0.0").pinned).toBe(true);expect(sourceInfo("npm:@scope/name@^1").pinned).toBe(false);
		expect(sourceInfo("git:github.com/owner/repo@v1").pinned).toBe(true);
		expect(()=>validateSource("--help","/tmp")).toThrow();
	});
});
