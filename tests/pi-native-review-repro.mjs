/** Regression checks for release-review findings.
 * Run after build: node tests/pi-native-review-repro.mjs [evidence.json]
 * No model requests. Force reset invokes the real recovery method directly;
 * reload uses a controlled host so the race is deterministic, not a browser E2E.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-native-review-"));
const agent = join(root, "agent"), cwd = join(root, "work");
mkdirSync(agent); mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_WEB_DATA_DIR = join(root, "data");
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultTools: ["read"], retry: { enabled: false } }));
const { VERSION } = await import("@earendil-works/pi-coding-agent");
const { ClientSession } = await import("../dist/server/agent-service.js");
const { ClientStateStore } = await import("../dist/server/client-state.js");
const { ThinkingDurationStore } = await import("../dist/server/thinking-timing.js");
const { SlashCommandsService } = await import("../dist/server/slash-commands.js");
const { queuePromptReload } = await import("../dist/server/system-prompt-files.js");
const evidence = { sdk: VERSION, node: process.version, platform: `${process.platform}/${process.arch}`, timestamp: new Date().toISOString(), cases: [] };
let client;
try {
	client = await ClientSession.create("review-isolated", cwd, new ClientStateStore(join(root, "client.json")), new ThinkingDurationStore(join(root, "thinking.json")));
	const seed = (conv, text) => {
		const message = { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
		conv.session.sessionManager.appendMessage(message);
		conv.session.agent.state.messages = [message];
	};
	const a = client.conv;
	seed(a, "ORIGINAL_A");
	const originalA = a.session.sessionFile;
	assert(await client.newChat());
	const b = client.conv;
	assert.equal(client.convs.get(a.id), a, "A remains a valid retained conversation");
	seed(b, "RECENT_B");
	const originalB = b.session.sessionFile;
	assert.notEqual(originalA, originalB);
	// Force an unambiguous recency ordering without sleeping or model requests.
	utimesSync(originalA, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
	utimesSync(originalB, new Date(), new Date());
	await client.forceResetConversation(a, "audit forced reset");
	assert.equal(client.convs.get(a.id), a, "recovery operated on the retained A record");
	// Fixed: see tests/force-reset-session-test.mjs.
	assert.equal(a.session.sessionFile, originalA, "A reopens its own file");
	assert.equal(typeof a.unsubscribe, "function", "background A is rebound");
	assert.equal(client.activeId, b.id);
	evidence.cases.push({ id: "force-reset-session-ownership", reproduced: false, boundary: "real ClientSession and SDK; direct recovery invocation, no stalled provider", restoredWrongSession: a.session.sessionFile !== originalA, restoredOtherOpenSession: a.session.sessionFile === b.session.sessionFile, resetConversationHasSubscriber: !!a.unsubscribe });
	await client.dispose(); client = undefined;

	const resources = name => ({ getExtensions: () => ({ extensions: [], errors: [] }), getSkills: () => ({ skills: [{ name }], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }) });
	let release, entered;
	const gate = new Promise(resolve => { release = resolve; });
	const started = new Promise(resolve => { entered = resolve; });
	const sessionA = { reload: async () => { entered(); await gate; }, resourceLoader: resources("A-only"), promptTemplates: [], extensionRunner: { getRegisteredCommands: () => [] } };
	const sessionB = { ...sessionA, resourceLoader: resources("B-only") };
	let active = sessionA;
	const events = [];
	const slash = new SlashCommandsService({ getSession: () => active, emit: event => events.push(event) });
	const reload = slash.exec("reload", "", { conversationId: "A", requestId: "reload-A" });
	await started; active = sessionB; release(); await reload;
	const done = events.find(event => event.type === "reload_status" && event.phase === "done");
	assert.equal(done.conversationId, "A"); assert.deepEqual(done.resources.skills, ["A-only"]);
	evidence.cases.push({ id: "reload-result-ownership", reproduced: false, boundary: "real SlashCommandsService, controlled session host", reportedConversation: done.conversationId, reportedSkills: done.resources.skills });

	let count = 0, peak = 0, finish, startedReload;
	const firstReload = new Promise(resolve => { startedReload = resolve; });
	const blocker = new Promise(resolve => { finish = resolve; });
	const session = { ...sessionA, isIdle: true, subscribe: () => () => {}, reload: async () => { peak = Math.max(peak, ++count); startedReload(); await blocker; count--; } };
	const concurrentSlash = new SlashCommandsService({ getSession: () => session, emit: () => {} });
	const fileReload = queuePromptReload(session, () => {});
	const slashReload = concurrentSlash.exec("reload", "", { conversationId: "A", requestId: "reload-parallel" });
	await firstReload;
	assert.equal(peak, 1, "different host reload paths share a session queue");
	finish(); await Promise.all([fileReload, slashReload]);
	assert.equal(peak, 1, "queued reloads never overlap");
	evidence.cases.push({ id: "reload-missing-shared-mutex", reproduced: false, boundary: "real prompt-file queue and SlashCommandsService; controlled reload, does not prove actual SDK corruption", concurrentReloadCalls: peak });
	if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(evidence, null, 2) + "\n");
	console.log(JSON.stringify(evidence, null, 2));
} finally {
	await client?.dispose();
	rmSync(root, { recursive: true, force: true });
}
