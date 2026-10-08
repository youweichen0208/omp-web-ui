/** Forced recovery of one conversation reopens that conversation's own session file,
 * even when another chat in the same project was written more recently. No model requests. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-force-reset-"));
const agent = join(root, "agent"), cwd = join(root, "work");
mkdirSync(agent); mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_WEB_DATA_DIR = join(root, "data");
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultTools: ["read"], retry: { enabled: false } }));
const { ClientSession } = await import("../dist/server/agent-service.js");
const { ClientStateStore } = await import("../dist/server/client-state.js");
const { ThinkingDurationStore } = await import("../dist/server/thinking-timing.js");
let client;
try {
	client = await ClientSession.create("force-reset", cwd, new ClientStateStore(join(root, "client.json")), new ThinkingDurationStore(join(root, "thinking.json")));
	const seed = (conv, text) => {
		const message = { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
		conv.session.sessionManager.appendMessage(message);
		conv.session.agent.state.messages = [message];
	};
	const text = conv => conv.session.messages.flatMap(m => m.content).map(b => b.text ?? "").join("");
	const a = client.conv;
	seed(a, "ORIGINAL_A");
	const fileA = a.session.sessionFile;
	assert(await client.newChat());
	const b = client.conv;
	seed(b, "RECENT_B");
	const fileB = b.session.sessionFile;
	assert.notEqual(fileA, fileB);
	// B is the most recently written session of the project.
	utimesSync(fileA, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
	utimesSync(fileB, new Date(), new Date());

	await client.forceResetConversation(a, "forced reset");
	assert.equal(client.convs.get(a.id), a, "the retained A record is recovered in place");
	assert.equal(a.session.sessionFile, fileA, "A reopens its own session file");
	assert.match(text(a), /ORIGINAL_A/, "A keeps its own history");
	assert.doesNotMatch(text(a), /RECENT_B/);
	assert.equal(typeof a.unsubscribe, "function", "background A is subscribed to its new session");
	assert.equal(client.activeId, b.id, "the active chat is unchanged");
	assert.equal(b.session.sessionFile, fileB);
	assert.match(text(b), /RECENT_B/);
	console.log("PASS forced recovery reopens the conversation's own session and rebinds it in the background");
} finally {
	await client?.dispose();
	rmSync(root, { recursive: true, force: true });
}
