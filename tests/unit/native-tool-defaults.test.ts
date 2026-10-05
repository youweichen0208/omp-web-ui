import { expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationSettings, setConversationRunSettings } from "../../server/native-tools.js";

test("new installations use native Codemode/search defaults across SDK reloads", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-native-defaults-"));
	try {
		const settings = conversationSettings(agentDir, agentDir);
		expect(settings.getDefaultTools()).toEqual(["read", "bash", "edit", "write", "codemode", "tool_search"]);
		await settings.reload();
		expect(settings.getDefaultTools()).toContain("tool_search");
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	} finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("an existing native tool selection and unrelated settings survive initialization", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-native-selection-"));
	try {
		const path = join(agentDir, "settings.json");
		const original = JSON.stringify({ defaultTools: ["+tool_search", "-codemode"], retry: { enabled: false } });
		writeFileSync(path, original);
		const settings = conversationSettings(agentDir, agentDir);
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(settings.getDefaultTools()).not.toContain("codemode");
		expect(settings.getDefaultTools()).toContain("tool_search");
		expect(settings.getSettings().retry?.enabled).toBe(false);
	} finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("malformed native settings are never replaced", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-native-invalid-"));
	try {
		const path = join(agentDir, "settings.json");
		writeFileSync(path, "broken config");
		conversationSettings(agentDir, agentDir);
		expect(readFileSync(path, "utf8")).toBe("broken config");
	} finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("explicit empty defaults and per-conversation run overrides survive reload/trust without writes", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-run-settings-"));
	try {
		const original = JSON.stringify({ defaultTools: [], compaction: { enabled: true }, retry: { enabled: true } });
		writeFileSync(join(root, "settings.json"), original);
		mkdirSync(join(root, ".pi"));
		writeFileSync(join(root, ".pi/settings.json"), '{"defaultTools":["read"]}');
		const a = conversationSettings(root, root), b = conversationSettings(root, root);
		a.setProjectTrusted(false);
		expect(a.getDefaultTools()).toEqual([]);
		setConversationRunSettings(a, { autoCompaction: false, autoRetry: false });
		await a.reload(); a.setProjectTrusted(true);
		expect(a.getDefaultTools()).toEqual(["read"]);
		expect(a.getCompactionEnabled()).toBe(false);
		expect(a.getRetryEnabled()).toBe(false);
		expect(b.getCompactionEnabled()).toBe(true);
		expect(readFileSync(join(root, "settings.json"), "utf8")).toBe(original);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a third-party extension replaces the native codemode tool", async () => {
	const { createAgentSessionServices, createAgentSessionFromServices, SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { Type } = await import("typebox");
	const { nativeToolExtensions } = await import("../../server/native-tools.js");
	const root = mkdtempSync(join(tmpdir(), "pi-replaceable-tool-"));
	let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
	try {
		const services = await createAgentSessionServices({ cwd: root, agentDir: root, settingsManager: conversationSettings(root, root), resourceLoaderOptions: { extensionFactories: [...nativeToolExtensions(), { name: "third-party", factory: pi => {
			pi.registerTool({ name: "codemode", label: "Replacement", description: "third-party sentinel", parameters: Type.Object({}), execute: async () => ({ details: {}, content: [{ type: "text", text: "replacement" }] }) });
		} }] } });
		({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root) }));
		expect(session.getAllTools().filter(tool => tool.name === "codemode")).toMatchObject([{ description: "third-party sentinel" }]);
	} finally { session?.dispose(); rmSync(root, { recursive: true, force: true }); }
});
