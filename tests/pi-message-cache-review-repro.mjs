/** Audit-only known-defect assertions. No model, server, browser or sockets.
 * Run after build: node tests/pi-message-cache-review-repro.mjs [evidence.json]
 * Uses real cache/projection/snapshot methods on a minimal controlled host;
 * light-state construction and timing annotation are bypassed explicitly.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { ClientSession } from "../dist/server/agent-service.js";
import { resolveNativeAttachments, frozenAttachmentText } from "../dist/server/user-attachments.js";

const timestamp = 1_700_000_000_000;
const assistant = index => ({ role: "assistant", timestamp: timestamp + index + 1, content: [{ type: "text", text: `unique-${index}` }], api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop" });
const user = path => ({ role: "user", timestamp, content: [{ type: "text", text: `question-${path}\n\n<file path="${path}.txt" />` }] });

function host(messages) {
	const manager = SessionManager.inMemory(process.cwd());
	const entries = messages.map(message => manager.appendMessage(message));
	const conv = {
		id: "fixture", msgIds: new Map(), nextMsgId: 1, uiMessageCache: new Map(), userSeqByTs: new Map(),
		lastMessagesArray: [], thinkingTimings: { annotate: value => value },
		session: { sessionManager: manager, agent: { state: { messages } } },
	};
	const client = Object.create(ClientSession.prototype);
	const events = [];
	Object.assign(client, { activeId: conv.id, convs: new Map([[conv.id, conv]]), disposed: false, snapRev: 0,
		emittedMessages: null, emittedConvId: null, sinks: new Set([event => events.push(event)]),
		thinkingDurationStore: { annotate: value => value },
		buildLightState: rev => ({ conversationId: conv.id, rev }),
	});
	return { client, conv, events, entries };
}

const cases = [];
for (const size of [64, 4096, 4100]) {
	const { client, events, entries } = host([user("A"), user("B"), ...Array.from({ length: size - 2 }, (_, index) => assistant(index))]);
	client.emitSnapshotNow();
	const first = client.emittedMessages;
	assert.equal(client.resolveUserMessageEntryId(first[0].id), entries[0]);
	assert.equal(client.resolveUserMessageEntryId(first[1].id), entries[1]);
	client.emitSnapshotNow();
	const second = client.emittedMessages;
	const changedReferences = first.filter((message, index) => message !== second[index]).length;
	const changedIds = first.filter((message, index) => message.id !== second[index].id).length;
	const overCapacity = size > 4096;
	assert.equal(events[0].type, "snapshot");
	assert.equal(events[1].type, overCapacity ? "snapshot" : "snapshot_delta");
	assert.equal(changedReferences, overCapacity ? size : 0);
	assert.equal(changedIds, overCapacity ? 2 : 0, "only user seq increments on cache miss; assistant IDs retain msgIds");
	assert.equal(client.resolveUserMessageEntryId(second[0].id), overCapacity ? null : entries[0]);
	assert.equal(client.resolveUserMessageEntryId(second[1].id), overCapacity ? null : entries[1]);
	cases.push({ id: "cache-working-set", size, snapshotTypes: events.map(event => event.type), changedReferences, changedIds, userIdsBefore: first.slice(0, 2).map(message => message.id), userIdsAfter: second.slice(0, 2).map(message => message.id), fallbackResolvesAfterSecondSnapshot: client.resolveUserMessageEntryId(second[0].id) !== null });
}

// The first 512 characters and full text length match, but the attachment path
// differs afterward. The cache fingerprint cannot distinguish these entries.
const common = "p".repeat(520);
const colliding = ["a", "b"].map(path => ({ role: "user", timestamp, content: [{ type: "text", text: `${common}\n\n<file path="${path}.txt" />` }] }));
const { client, conv, entries } = host(colliding);
const projection = client.currentMessages();
assert.equal(projection[0], projection[1]);
assert.equal(projection[0].id, projection[1].id);
assert.equal(client.resolveUserMessageEntryId(projection[1].id), entries[0]);
// Native entry references bypass timestamp-based IDs and preserve the source.
const restored = resolveNativeAttachments(conv.session, entries.map(entryId => ({ path: "", nativeRef: { entryId, index: 0 } })));
assert.deepEqual(restored.map(attachment => attachment.path), ["a.txt", "b.txt"]);
assert(frozenAttachmentText(restored[0]).includes('path="a.txt"'));
assert(frozenAttachmentText(restored[1]).includes('path="b.txt"'));
cases.push({ id: "same-timestamp-fingerprint-collision", duplicateUiId: true, sharedSerializedObject: true, secondFallbackResolvesFirstEntry: true, nativeEntryAttachmentOrderPreserved: true });

const evidence = { sdk: VERSION, node: process.version, timestamp: new Date().toISOString(), boundary: "controlled ClientSession host; real serializeCached/currentMessages/emitSnapshotNow and native in-memory entries; no full service, tree decoration or UI", cases };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
