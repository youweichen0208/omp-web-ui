import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { getSystemPromptState, writeSystemPromptFile, queuePromptReload, flushPromptReload, promptReloadStatus, promptUsesFile } from "../../server/system-prompt-files.js";
import { nativePromptText, promptView } from "../../server/system-prompt-view.js";
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
async function fixture(trusted=true) {
	const root=mkdtempSync(join(tmpdir(),"pi-prompt-unit-")),cwd=join(root,"work"),agentDir=join(root,"agent");
	cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
	mkdirSync(join(cwd,".pi"),{recursive:true});mkdirSync(agentDir);
	writeFileSync(join(agentDir,"APPEND_SYSTEM.md"),"user instructions");
	writeFileSync(join(cwd,".pi/APPEND_SYSTEM.md"),"project instructions");
	writeFileSync(join(cwd,"AGENTS.md"),"project context");
	new ProjectTrustStore(agentDir).set(cwd,trusted);
	const services=await createAgentSessionServices({cwd,agentDir,settingsManager:SettingsManager.create(cwd,agentDir,{projectTrusted:trusted})});
	const {session}=await createAgentSessionFromServices({services,sessionManager:SessionManager.inMemory(cwd)});
	cleanup.push(()=>session.dispose());
	const state=()=>getSystemPromptState(session,cwd,agentDir);
	const save=(id:string,text:string)=>{const f=state().files.find(f=>f.id===id)!;return writeSystemPromptFile(session,cwd,agentDir,id,f.version,text);};
	return{root,cwd,agentDir,session,state,save};
}
describe("native system prompt file editing",()=>{
	it("attributes rules only to declared tools and preserves indirectly readable skills", async()=>{
		const f = await fixture();
		const native = f.session as unknown as { _runSystemPromptOptions?: import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions };
		const shared = "Shared tool and extension rule";
		try {
			for (const hiddenTools of [["read", "bash"], []]) {
				native._runSystemPromptOptions = {
					cwd: f.cwd, selectedTools: ["read", "bash"], hiddenTools,
					toolSnippets: { read: "Read fixture files", bash: "Run fixture commands" },
					toolGuidelines: { bash: [shared, "Hidden bash rule"] }, promptGuidelines: [shared],
					skills: [{ name: "fixture", description: "Fixture skill", filePath: join(f.cwd, "SKILL.md"), baseDir: f.cwd, sourceInfo: { path: join(f.cwd, "SKILL.md"), source: "fixture", scope: "project", origin: "top-level" }, disableModelInvocation: false }],
				};
				const view = promptView(f.session, f.cwd);
				expect(view.opaque).toBe(false);
				expect(view.raw).toBe(f.session.systemPrompt);
				expect(view.raw).toBe(nativePromptText(native._runSystemPromptOptions));
				expect(view.sections.find(section => section.name === "skills")?.text).toContain("Fixture skill");
				expect(view.rules.find(rule => rule.text === shared)?.kind).toBe(hiddenTools.length ? "extension" : "tool");
				expect(view.rules.some(rule => rule.text === "Hidden bash rule")).toBe(!hiddenTools.length);
				expect(view.sections.find(section => section.name === "tools")?.text.includes("Run fixture commands")).toBe(!hiddenTools.length);
			}
		} finally { native._runSystemPromptOptions = undefined; }
	});
	it("creates only the fixed missing project context and reloads it without adding messages", async()=>{
		const f=await fixture();unlinkSync(join(f.cwd,"AGENTS.md"));await f.session.reload();
		const candidate=f.state().files.find(file=>file.id==="context:new")!;
		expect(candidate.path).toBe(join(f.cwd,"AGENTS.md"));expect(candidate.exists).toBe(false);
		const path=writeSystemPromptFile(f.session,f.cwd,f.agentDir,candidate.id,candidate.version,"created context");
		expect(promptUsesFile(f.session,f.cwd,f.agentDir,path)).toBe(true);
		await queuePromptReload(f.session,()=>{});expect(f.state().raw).toContain("created context");expect(f.session.messages).toHaveLength(0);
		expect(()=>writeSystemPromptFile(f.session,f.cwd,f.agentDir,candidate.id,candidate.version,"overwrite")).toThrow();
	});
	it("shows native sections and project priority; reload preserves conversation and adds no transcript message",async()=>{
		const f=await fixture(),before=f.state(),id=f.session.sessionId,messages=f.session.messages.slice();
		expect(before.opaque).toBe(false);expect(before.raw).toBe(f.session.systemPrompt);
		expect(before.raw).toContain("project instructions");expect(before.raw).not.toContain("user instructions");
		expect(before.sections.map(s=>s.name)).toContain("cwd");expect(before.rules.some(r=>r.kind==="builtin")).toBe(true);
		f.save("append:project","updated native append");expect(f.state().raw).not.toContain("updated native append");
		expect(f.state().files.find(f=>f.id==="append:project")?.changedOnDisk).toBe(true);
		await queuePromptReload(f.session,()=>{});
		expect(f.state().raw).toContain("updated native append");expect(f.session.sessionId).toBe(id);expect(f.session.messages).toEqual(messages);
		f.save("system:project","replacement identity");await queuePromptReload(f.session,()=>{});
		const custom=f.state();expect(custom.custom).toBe(true);expect(custom.sections.map(s=>s.name)).not.toContain("rules");
		expect(custom.raw).toContain("project context");expect(custom.raw).toContain("updated native append");
		f.save("system:user","personal fallback identity");
		const file=custom.files.find(f=>f.id==="system:project")!;
		writeSystemPromptFile(f.session,f.cwd,f.agentDir,file.id,file.version,undefined,true);await queuePromptReload(f.session,()=>{});
		expect(f.state().raw).toContain("personal fallback identity");expect(f.state().custom).toBe(true);
		const fallback=f.state().files.find(f=>f.id==="system:user")!;
		writeSystemPromptFile(f.session,f.cwd,f.agentDir,fallback.id,fallback.version,undefined,true);await queuePromptReload(f.session,()=>{});
		expect(f.state().custom).toBe(false);expect(f.state().sections.map(s=>s.name)).toContain("rules");
	});
	it("uses the personal source in untrusted projects and rejects writes outside loaded context",async()=>{
		const f=await fixture(false);expect(f.state().raw).toContain("user instructions");expect(f.state().raw).not.toContain("project instructions");
		expect(()=>f.save("append:project","blocked")).toThrow(/read-only/);
		expect(()=>writeSystemPromptFile(f.session,f.cwd,f.agentDir,"../../other","", "blocked")).toThrow(/read-only/);
		const ctx=f.state().files.find(file=>file.kind==="context"&&file.path===join(f.cwd,"AGENTS.md"))!;
		f.save(ctx.id,"edited loaded context");await queuePromptReload(f.session,()=>{});expect(f.state().raw).toContain("edited loaded context");
	});
	it("rejects stale contents and redirected symlinks, without touching the new target",async()=>{
		const f=await fixture(),path=join(f.cwd,".pi/APPEND_SYSTEM.md");
		const stale=f.state().files.find(f=>f.id==="append:project")!;
		writeFileSync(path,"external");
		expect(()=>writeSystemPromptFile(f.session,f.cwd,f.agentDir,stale.id,stale.version,"lost update")).toThrow(/changed/);
		const a=join(f.root,"a"),b=join(f.root,"b");writeFileSync(a,"same");writeFileSync(b,"same");unlinkSync(path);symlinkSync(a,path);
		const linked=f.state().files.find(f=>f.id==="append:project")!;unlinkSync(path);symlinkSync(b,path);
		expect(()=>writeSystemPromptFile(f.session,f.cwd,f.agentDir,linked.id,linked.version,"redirected")).toThrow(/changed/);
		expect(readFileSync(b,"utf8")).toBe("same");
		expect(promptUsesFile(f.session,f.cwd,f.agentDir,b)).toBe(true);
	});
	it("retains a failed reload for explicit retry without losing the saved file",async()=>{
		const f=await fixture();f.save("append:project","saved before reload failure");
		const reload=vi.spyOn(f.session,"reload").mockRejectedValueOnce(new Error("reload fixture failure"));
		await queuePromptReload(f.session,()=>{});expect(promptReloadStatus(f.session)).toMatchObject({pending:true,reloadError:"reload fixture failure"});
		await flushPromptReload(f.session);expect(reload).toHaveBeenCalledTimes(1);
		await flushPromptReload(f.session,true);expect(promptReloadStatus(f.session).pending).toBe(false);expect(f.state().raw).toContain("saved before reload failure");reload.mockRestore();
	});
	it("degrades to read-only when a native extension forces the prompt",async()=>{
		const f=await fixture();
		// Simulate the exact native effective run options without invoking a model.
		const native=f.session as unknown as {_runSystemPromptOptions?:{cwd:string;forceSystemPrompt:string}};
		native._runSystemPromptOptions={cwd:f.cwd,forceSystemPrompt:"opaque extension prompt"};
		expect(f.state().raw).toBe(nativePromptText(native._runSystemPromptOptions));
		expect(f.state().forced).toBe(true);expect(f.state().files.every(f=>!f.editable)).toBe(true);
		expect(()=>f.save("append:user","blocked")).toThrow(/read-only/);
		native._runSystemPromptOptions=undefined;
	});
});
