/** Forced recovery of one conversation reopens that conversation's own session file,
 * even when another chat in the same project was written more recently. No model requests. */
import { readFileSync, existsSync } from "node:fs";
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
	// Public Stop entry, with deterministic disposal scheduling. Shorten only
	// the settle duration; retain the actual abort/rebuild/bind lifecycle.
	ClientSession.HARD_ABORT_SETTLE_MS = 5;
	for (const mode of ["delete", "dispose"]) {
		const work = join(root, mode); mkdirSync(work);
		const victim = await ClientSession.create(`reset-${mode}`, work, new ClientStateStore(join(root, `${mode}.json`)), new ThinkingDurationStore(join(root, `${mode}-thinking.json`)));
		try {
			const target = victim.conv; seed(target, "ORIGINAL");
			const file = target.session.sessionFile;
			await victim.newChat(); const other = victim.conv; seed(other, "OTHER");
			const otherFile = other.session.sessionFile, otherBytes = readFileSync(otherFile, "utf8");
			const original = target.runtime, dispose = original.dispose.bind(original);
			let release, entered, count = 0;
			const gate = new Promise(resolve => { release = resolve; });
			const started = new Promise(resolve => { entered = resolve; });
			original.dispose = async () => { if (++count === 1) { entered(); await gate; } await dispose(); };
			target.session.abort = async () => {};
			await victim.switchConversation(target.id);
			const stopping = victim.abort();
			await victim.switchConversation(other.id);
			await started;
			if (mode === "delete") await victim.deleteSession(file); else await victim.dispose();
			release(); await stopping;
			assert.equal(target.runtime, original, "removed/disposed conversation must not acquire a new runtime");
			assert.equal(target.unsubscribe, undefined);
			assert.equal(readFileSync(otherFile, "utf8"), otherBytes);
			if (mode === "delete") assert(!existsSync(file));
			else { assert.equal(victim.widgetsTimer, null); assert.equal(victim.stallTimer, null); }
		} finally { await victim.dispose(); }
	}
	// Real SDK extension: shutdown can precede an awaited session_start.
	const extension = join(agent, "lifecycle.mjs");
	writeFileSync(extension, `export default pi => {
		pi.on("session_start", async () => { const s = globalThis.__resetLifecycle; if (!s) return; s.enter(); await s.gate; s.resource = setInterval(() => {}, 60000); s.resource.unref(); s.events.push("start"); });
		pi.on("session_shutdown", () => { const s = globalThis.__resetLifecycle; if (!s) return; clearInterval(s.resource); s.resource = null; s.events.push("shutdown"); });
	};`);
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultTools: ["read"], extensions: [extension] }));
	for (const mode of ["delete", "dispose"]) {
		const work = join(root, `binding-${mode}`); mkdirSync(work);
		const victim = await ClientSession.create(`binding-${mode}`, work, new ClientStateStore(join(root, `binding-${mode}.json`)), new ThinkingDurationStore(join(root, `binding-${mode}-timing.json`)));
		let release;
		try {
			const target = victim.conv; seed(target, "BINDING_TARGET");
			const file = target.session.sessionFile;
			await victim.newChat(); const survivor = victim.conv;
			let enter; const entered = new Promise(resolve => { enter = resolve; });
			const state = globalThis.__resetLifecycle = { gate: new Promise(resolve => { release = resolve; }), enter, events: [], resource: null };
			const reset = victim.forceResetConversation(target, "binding race");
			await entered;
			if (mode === "delete") await victim.deleteSession(file); else await victim.dispose();
			release(); await reset;
			assert.equal(state.resource, null, "late extension resources are disposed");
			assert.equal(state.events.at(-1), "shutdown");
			assert.equal(target.unsubscribe, undefined);
			if (mode === "delete") { assert(!victim.convs.has(target.id)); assert.equal(victim.conv, survivor); assert(!existsSync(file)); }
		} finally { release?.(); clearInterval(globalThis.__resetLifecycle?.resource); delete globalThis.__resetLifecycle; await victim.dispose(); }
	}
	console.log("PASS forced recovery reopens the conversation's own session and rebinds it in the background");
} finally {
	await client?.dispose();
	rmSync(root, { recursive: true, force: true });
}
