import { expect, test, vi } from "vitest";
import { parseUserAttachments, resolveNativeAttachments, frozenAttachmentText } from "../../server/user-attachments.js";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const file = '\n<file path="a.txt">\n```\n  "quoted"\nline two\n```\n</file>';
test("only standalone complete suffix attachments are projected", () => {
	const parsed = parseUserAttachments("question\n\n" + file + '\n\n<file path="b" size="123" />');
	expect(parsed.text).toBe("question");
	expect(parsed.attachments.map(a => a.path)).toEqual(["a.txt", "b"]);
	expect(parsed.attachments[0].raw).toBe(file);
	for (const text of ['```xml\n' + file + '\n```', 'question\n' + file + '\nexplanation', file.slice(0, -7)]) expect(parseUserAttachments(text)).toEqual({ text, attachments: [] });
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

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAttachmentMessages } from "../../server/attachments.js";
import { promptWithAttachments } from "../../server/prompt-delivery.js";

test("real file construction keeps Markdown fences, multiple cards and frozen restoration", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fence-test-"));
	const services = await createAgentSessionServices({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory() });
	const manager = SessionManager.inMemory(root);
	const { session } = await createAgentSessionFromServices({ services, sessionManager: manager });
	const markdown = '# title\n```ts\nconst s = "a  b";\n```\ninline `````` ticks\n';
	try {
		await writeFile(join(root, "a.ts"), 'const s = "a  b";');
		await writeFile(join(root, "b.md"), markdown);
		vi.stubEnv("PI_WEB_DATA_DIR", root);
		const ctx = { cwd: root, clientId: "fixture", session, emit: () => {} };
		const asides = await buildAttachmentMessages(ctx, [{ path: "a.ts", mode: "inline" }, { path: "b.md", mode: "inline" }, { path: "b.md", mode: "lines", lines: { start: 2, end: 4 } }, { path: "", name: "upload.md", fileData: Buffer.from(markdown).toString("base64") }]);
		const text = promptWithAttachments("question", asides).text;
		const parsed = parseUserAttachments(text);
		expect(parsed.text).toBe("question"); expect(parsed.attachments).toHaveLength(4);
		expect(parsed.attachments[3].preview).toBe(markdown);
		expect(parsed.attachments[1].preview).toBe(markdown);
		expect(parsed.attachments[1].raw).toContain("\n```````\n");
		expect(parsed.attachments[2].preview).toBe('```ts\nconst s = "a  b";\n```');
		const entryId = manager.appendMessage({ role: "user", content: text, timestamp: 1 });
		await rm(join(root, "b.md"));
		const restored = resolveNativeAttachments(session, [{ path: "ignored", nativeRef: { entryId, index: 1 } }]);
		expect(promptWithAttachments("again", await buildAttachmentMessages(ctx, restored)).text).toBe("again\n\n" + parsed.attachments[1].raw);
	} finally { vi.unstubAllEnvs(); session.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("legacy triple fences accept internal code blocks but reject ambiguous closing tags", () => {
	const body = '# title\n```ts\nconst s = "a  b";\n```\n';
	const legacy = '\n<file path="b.md">\n```\n' + body + '\n```\n</file>';
	const parsed = parseUserAttachments("question\n\n" + file + "\n\n" + legacy);
		expect(parsed.text).toBe("question"); expect(parsed.attachments).toHaveLength(2);
		expect(parsed.attachments[1]).toMatchObject({ raw: legacy, preview: body });
	for (const text of [legacy.replace(body, '```\n</file>\nmore'), '````xml\n' + legacy + '\n````', legacy.slice(0, -7)]) {
		expect(parseUserAttachments(text)).toEqual({ text, attachments: [] });
	}
});
