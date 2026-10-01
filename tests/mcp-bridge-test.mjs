/** Native OMP MCP discovery. No compatibility bridge or user profile. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession } from "../dist/server/omp/index.js";

const root = mkdtempSync(join(tmpdir(), "omp-mcp-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
	csrv: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url))] },
	badsrv: { command: "definitely-not-a-real-cmd-xyz", args: [] },
} }));
let session;
try {
	session = await AgentSession.create({ cwd: root, agentDir });
	for (let i = 0; i < 100 && !session.getAllToolNames().some(name => name.includes("csrv")); i++) {
		await new Promise(resolve => setTimeout(resolve, 100));
		await session.refresh();
	}
	const tools = session.getAllToolNames();
	assert.ok(tools.some(name => name.includes("csrv") && name.includes("echo")), JSON.stringify(tools));
	assert.ok(tools.some(name => name.includes("csrv") && name.includes("add")));
	assert.equal(session.isStreaming, false);
	console.log("PASS native OMP MCP discovery and failed-server isolation");
} finally {
	await session?.dispose();
	rmSync(root, { recursive: true, force: true });
}
