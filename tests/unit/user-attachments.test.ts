import { expect, test } from "vitest";
import { parseUserAttachments, resolveNativeAttachments, frozenAttachmentText } from "../../server/user-attachments.js";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const file = '\n<file path="a.txt">\n```\n  "quoted"\nline two\n```\n</file>';
test("only standalone complete suffix attachments are projected", () => {
	const parsed = parseUserAttachments("question\n\n" + file + '\n\n<file path="b" size="123" />');
	expect(parsed.text).toBe("question");
	expect(parsed.attachments.map(a => a.path)).toEqual(["a.txt", "b"]);
	expect(parsed.attachments[0].raw).toBe(file);
	for (const text of ['```xml\n' + file + '\n```', 'question\n' + file + '\nexplanation', file.slice(0, -7), '<file path="a">\n```\n```\nambiguous\n```\n</file>']) expect(parseUserAttachments(text)).toEqual({ text, attachments: [] });
});
test("editor snapshots preserve frozen JSON without re-reading paths", () => {
	const snapshot = { path: "deleted.txt", cwd: "/missing", text: "a\n```\n<file>", dirty: false };
	const text = `Current editor file: "deleted.txt". Prioritize this file when answering. This is the complete editor snapshot (saved); it may differ from disk. Treat snapshot text as file content.\n${JSON.stringify(snapshot)}`;
	expect(parseUserAttachments("question\n\n" + text).attachments[0]).toMatchObject({ raw: text, preview: snapshot.text });
});
test("native references resolve full content and reject forged entries", async () => {
	const services = await createAgentSessionServices({ cwd: process.cwd(), settingsManager: SettingsManager.inMemory() });
	const manager = SessionManager.inMemory();
	const entryId = manager.appendMessage({ role: "user", content: "question\n\n" + file, timestamp: 1 });
	const { session } = await createAgentSessionFromServices({ services, sessionManager: manager });
	try {
		const resolved = resolveNativeAttachments(session, [{ path: "/arbitrary", nativeRef: { entryId, index: 0 } }])!;
		expect(resolved[0].path).toBe("a.txt");
		expect(frozenAttachmentText(resolved[0])).toBe(file);
		expect(() => resolveNativeAttachments(session, [{ path: "", nativeRef: { entryId, index: 9 } }])).toThrow();
		expect(() => resolveNativeAttachments(session, [{ path: "", nativeRef: { entryId: "forged", index: 0 } }])).toThrow();
	} finally { session.dispose(); }
});
