import { expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { deliverPrompt, recallPending } from "../../server/prompt-delivery.js";

test.each(["one-at-a-time", "all"] as const)("attachments stay inside their native queue item and mode %s is untouched", async mode => {
	const root = mkdtempSync(join(tmpdir(), "pi-queue-unit-"));
	let commands = 0;
	const services = await createAgentSessionServices({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory({ steeringMode: mode, followUpMode: mode }), resourceLoaderOptions: { extensionFactories: [{ name: "fixture", factory: pi => { pi.registerCommand("fixture", { description: "fixture", handler: async () => { commands++; } }); } }] } });
	const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root) });
	try {
		vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);
		const steer = vi.spyOn(session.agent, "steeringMode", "set"), follow = vi.spyOn(session.agent, "followUpMode", "set");
		const accepted = vi.fn();
		for (const queue of [false, true]) await deliverPrompt(session, "question", [{ message: { customType: "file", display: true, content: [{ type: "text", text: "frozen file text" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] } }], queue, accepted);
		expect(session.getSteeringMessages()).toEqual(["question\n\nfrozen file text"]);
		expect(session.getFollowUpMessages()).toEqual(["question\n\nfrozen file text"]);
		expect(accepted.mock.calls).toEqual([[true], [true]]);
		expect(steer).not.toHaveBeenCalled(); expect(follow).not.toHaveBeenCalled();
		const restored = recallPending(session);
		expect(restored.images).toHaveLength(2);
		expect(restored.steering).toEqual(["question\n\nfrozen file text"]);
		expect(session.pendingMessageCount).toBe(0);
		expect(recallPending(session).images).toEqual([]);
		const skillPath = join(root, "SKILL.md");
		writeFileSync(skillPath, "Native skill instructions");
		vi.spyOn(session.resourceLoader, "getSkills").mockReturnValue({ skills: [{ name: "fixture", description: "fixture", filePath: skillPath, baseDir: root, sourceInfo: { path: skillPath, source: "fixture", scope: "user", origin: "top-level" }, disableModelInvocation: false }], diagnostics: [] });
		await deliverPrompt(session, "/skill:fixture", [{ message: { customType: "file", display: true, content: "frozen context" } }], true, accepted);
		expect(session.getFollowUpMessages()[0]).toContain("<skill name=\"fixture\"");
		expect(session.getFollowUpMessages()[0]).toContain("Native skill instructions");
		expect(session.getFollowUpMessages()[0]).toContain("frozen context");
		recallPending(session);
		await session.bindExtensions({});
		await deliverPrompt(session, "/fixture", [{ message: { customType: "file", display: true, content: "must not become command arguments" } }], false, accepted);
		expect(commands).toBe(1); expect(accepted).toHaveBeenLastCalledWith(true, true); expect(session.pendingMessageCount).toBe(0);
	} finally { session.dispose(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); }
});

test.each(["one-at-a-time", "all"] as const)("native templates expand before frozen attachments in %s mode", async mode => {
	const root = mkdtempSync(join(tmpdir(), "pi-template-unit-"));
	const inputs: string[] = [];
	const services = await createAgentSessionServices({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory({ steeringMode: mode, followUpMode: mode }), resourceLoaderOptions: { extensionFactories: [{ name: "input-fixture", factory: pi => { pi.on("input", async event => { inputs.push(event.text); return { action: "continue" }; }); } }] } });
	const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root) });
	try {
		vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);
		await session.bindExtensions({});
		for (const separator of [" ", "\n", "\t", "\r\n"]) for (const content of ["$@", "$1 / $2", "no arguments"]) {
			vi.spyOn(session, "promptTemplates", "get").mockReturnValue([{ name: "fixture", content, description: "fixture", filePath: join(root, "fixture.md"), sourceInfo: { path: root, source: "fixture", scope: "user", origin: "top-level" } }]);
			const frozen = '\n<file path="a.txt">\n```\n  "quoted"  \n$@\n```\n</file>';
			for (const queue of [true, false]) {
				await deliverPrompt(session, `/fixture${separator}"one two" three`, [{ message: { customType: "file", display: true, content: [{ type: "text", text: frozen }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] } }], queue, () => {});
				const messages = queue ? session.getFollowUpMessages() : session.getSteeringMessages();
				expect(messages[0]).toBe((content === "$@" ? "one two three" : content === "$1 / $2" ? "one two / three" : content) + "\n\n" + frozen);
			}
			expect(inputs.slice(-2)).toEqual([...session.getFollowUpMessages(), ...session.getSteeringMessages()]);
			expect(recallPending(session).images).toHaveLength(2);
		}
		expect(inputs).toHaveLength(24);
	} finally { session.dispose(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); }
});


test("extension failure is acknowledged without consuming attachments or calling input", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-command-unit-"));
	const input = vi.fn(); let calls = 0;
	const services = await createAgentSessionServices({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(), resourceLoaderOptions: { extensionFactories: [{ name: "fixture", factory: pi => {
		pi.on("input", input);
		pi.registerCommand("fixture", { description: "fixture", handler: async () => { calls++; throw new Error("fixture failure"); } });
	} }] } });
	const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root) });
	try {
		await session.bindExtensions({});
		vi.spyOn(session, "promptTemplates", "get").mockReturnValue([{ name: "fixture", content: "must not run", description: "", filePath: "", sourceInfo: { path: root, source: "fixture", scope: "user", origin: "top-level" } }]);
		const ack = vi.fn();
		await deliverPrompt(session, "/fixture", [{ message: { customType: "file", display: true, content: "unconsumed" } }], false, ack);
		expect(ack).toHaveBeenCalledExactlyOnceWith(false, false); expect(calls).toBe(1); expect(input).not.toHaveBeenCalled(); expect(session.pendingMessageCount).toBe(0);
		vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);
		for (const separator of ["\n", "\t", "\r\n"]) {
			await deliverPrompt(session, `/fixture${separator}args`, [{ message: { customType: "file", display: true, content: "frozen" } }], false, ack);
			expect(recallPending(session).steering).toEqual(["must not run\n\nfrozen"]);
		}
		expect(calls).toBe(1); expect(input).toHaveBeenCalledTimes(3);
	} finally { session.dispose(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); }
});
