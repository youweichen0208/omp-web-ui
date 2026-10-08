/** Transcripts longer than the cache headroom keep stable message ids and reuse
 * cached objects between snapshots. No model requests. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-long-history-"));
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
	client = await ClientSession.create("long-history", cwd, new ClientStateStore(join(root, "client.json")), new ThinkingDurationStore(join(root, "thinking.json")));
	const conv = client.conv;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const messages = [];
	// 12,000 messages; pairs share a timestamp so user ids carry a per-timestamp seq.
	for (let i = 0; i < 6000; i++) {
		const timestamp = 1_700_000_000_000 + Math.floor(i / 2);
		messages.push({ role: "user", content: [{ type: "text", text: `question ${i}` }], timestamp });
		messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }], api: "openai-completions", provider: "fixture", model: "fixture", usage, stopReason: "stop", timestamp });
	}
	conv.session.agent.state.messages = messages;
	const first = client.currentMessages();
	const userIds = first.filter(m => m.role === "user").map(m => m.id);
	assert.equal(new Set(userIds).size, 6000, "user message ids are unique");
	const started = performance.now();
	const second = client.currentMessages();
	const elapsed = performance.now() - started;
	assert.deepEqual(second.filter(m => m.role === "user").map(m => m.id), userIds, "ids do not drift between snapshots");
	assert(second.every((m, i) => m === first[i]), "messages are served from the cache, so snapshots can send deltas");
	assert(elapsed < 1000, `second snapshot took ${elapsed.toFixed(0)} ms`);
	console.log(`PASS 12,000-message transcript keeps stable ids and cached objects (second walk ${elapsed.toFixed(0)} ms)`);
} finally {
	await client?.dispose();
	rmSync(root, { recursive: true, force: true });
}
