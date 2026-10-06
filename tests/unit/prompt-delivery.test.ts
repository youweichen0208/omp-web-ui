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
		expect(commands).toBe(1); expect(accepted).toHaveBeenLastCalledWith(false); expect(session.pendingMessageCount).toBe(0);
	} finally { session.dispose(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); }
});
