import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeMcpConfigService } from "../../server/native-mcp-config.js";
import type { ServerMessage } from "../../server/protocol.js";

function fixture() { return realpathSync(mkdtempSync(join(tmpdir(),"pi-one-services-"))); }
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
