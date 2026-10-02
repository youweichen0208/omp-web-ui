import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ImageService } from "../../server/image-service.js";
import { NativeMcpConfigService } from "../../server/native-mcp-config.js";
import type { ServerMessage } from "../../server/protocol.js";

function fixture() { return realpathSync(mkdtempSync(join(tmpdir(),"pi-one-services-"))); }
describe("Pi 1.0 image jobs", () => {
	it("persists results without bytes in metadata, isolates projects and recovers interrupted work", async () => {
		const root = fixture(), cwd = join(root,"project"); mkdirSync(cwd);
		try {
			const service = new ImageService(join(root,"images")), wire: ServerMessage[] = [];
			const runtime = { getAvailableOfType: async () => [{id:"fixture",provider:"fixture",name:"Fixture"}], generateImages: async () => ({stopReason:"stop",output:[{type:"image",mimeType:"image/png",data:"aGVsbG8="}]}) } as unknown as ModelRuntime;
			await service.handle("client",runtime,{type:"image_request",requestId:"request",cwd,action:"create",prompt:"Fixture",model:"fixture",provider:"fixture"},msg => wire.push(msg));
			await new Promise(resolve => setImmediate(resolve));
			const response = wire.at(-1); expect(response?.type).toBe("image_result");
			if (response?.type !== "image_result" || !response.record) throw new Error("Missing result");
			expect(response.record.status).toBe("done"); expect(JSON.stringify(wire)).not.toContain("aGVsbG8=");
			expect(readFileSync(service.file(cwd,response.record.id,0)!,"utf8")).toBe("hello"); expect(service.file(root,response.record.id,0)).toBeUndefined();
			const path = join(root,"images",response.record.id,"record.json"); writeFileSync(path,JSON.stringify({...response.record,status:"running"}));
			const restored = new ImageService(join(root,"images"));
			await restored.handle("client",runtime,{type:"image_request",requestId:"restore",cwd,action:"list"},msg => wire.push(msg));
			const last = wire.at(-1); expect(last?.type === "image_result" && last.records?.[0].status).toBe("interrupted");
		} finally { rmSync(root,{recursive:true,force:true}); }
	});
	it("reserves one slot per client, cancels without saving late images and releases capacity", async () => {
		const root = fixture();
		try {
			const service = new ImageService(join(root,"images")), wire: ServerMessage[] = [];
			let finish!: (value: unknown) => void;
			const runtime = { getAvailableOfType: async () => [{id:"fixture",provider:"fixture",name:"Fixture"}], generateImages: () => new Promise(resolve => { finish = resolve; }) } as unknown as ModelRuntime;
			const msg = {type:"image_request" as const, requestId:"request",cwd:root,action:"create" as const,prompt:"Fixture",model:"fixture",provider:"fixture"};
			await service.handle("client",runtime,msg,m => wire.push(m));
			await service.handle("client",runtime,msg,m => wire.push(m));
			expect(wire.at(-1)?.type === "image_result" && wire.at(-1)).toMatchObject({error:"Image generation busy"});
			const first = wire[0]; if(first.type !== "image_result" || !first.record) throw new Error("Missing record");
			await service.handle("client",runtime,{...msg,action:"cancel",id:first.record.id},m => wire.push(m));
			finish({stopReason:"stop",output:[{type:"image",mimeType:"image/png",data:"aGVsbG8="}]});
			await new Promise(resolve => setImmediate(resolve));
			expect(wire.at(-1)).toMatchObject({record:{status:"cancelled",images:[]}});
		} finally { rmSync(root,{recursive:true,force:true}); }
	});
});
describe("native MCP configuration", () => {
	it("preserves unknown fields, keeps/replaces/removes secrets and rejects stale saves and project provider auth", () => {
		const root = fixture();
		try {
			mkdirSync(join(root,".pi")); const path = join(root,".pi","mcp.json");
			writeFileSync(path,JSON.stringify({unknown:{keep:true},mcpServers:{test:{command:"echo",future:42,env:{TOKEN:"secret"}}}}));
			const service = new NativeMcpConfigService(), state = service.get(root,"project");
			expect(JSON.stringify(state)).not.toContain('"secret"');
			service.save(root,"project",state.version,state.document);
			expect(JSON.parse(readFileSync(path,"utf8"))).toMatchObject({unknown:{keep:true},mcpServers:{test:{future:42,env:{TOKEN:"secret"}}}});
			const current = service.get(root,"project");
			const document = current.document as {mcpServers:Record<string,Record<string,unknown>>}; document.mcpServers.test.env = {TOKEN:"new"};
			service.save(root,"project",current.version,document);
			expect(readFileSync(path,"utf8")).toContain('"new"');
			expect(() => service.save(root,"project",current.version,document)).toThrow(/changed externally/);
			const latest = service.get(root,"project");
			expect(() => service.save(root,"project",latest.version,{mcpServers:{remote:{url:"https://example.com/mcp",auth:{provider:"radius"}}}})).toThrow(/global/);
		} finally { rmSync(root,{recursive:true,force:true}); }
	});
});

describe("Pi 1.0 extension UI prompts", () => {
	it("keeps notifications when the SDK spreads the context, replays a pending prompt and closes it on abort", async () => {
		const { WebUIContext } = await import("../../server/webui-context.js");
		const wire: ServerMessage[] = [], replay: ServerMessage[] = [];
		const ui = new WebUIContext(msg => wire.push(msg));
		const wrapped = { ...ui }; wrapped.notify("MCP status", "info");
		expect(wire.at(-1)).toMatchObject({type:"notice",text:"MCP status"});
		const controller = new AbortController(); const pending = ui.input("Callback URL","",{signal:controller.signal});
		ui.replayDialogs(msg => replay.push(msg)); expect(replay.at(-1)?.type).toBe("dialog");
		controller.abort(); await expect(pending).resolves.toBeNull(); expect(wire.at(-1)?.type).toBe("dialog_closed");
		const after: ServerMessage[] = []; ui.replayDialogs(msg => after.push(msg)); expect(after).toEqual([]);
	});
});
