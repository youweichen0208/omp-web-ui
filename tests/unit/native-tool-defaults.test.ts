import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { ensureNativeToolDefaults } from "../../server/native-tools.js";

test("new installations use native Codemode/search defaults across SDK reloads", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-native-defaults-"));
	try {
		ensureNativeToolDefaults(agentDir);
		const settings = SettingsManager.create(agentDir, agentDir);
		expect(settings.getDefaultTools()).toEqual(["read", "bash", "edit", "write", "codemode", "tool_search"]);
		await settings.reload();
		expect(settings.getDefaultTools()).toContain("tool_search");
	} finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("an existing native tool selection and unrelated settings survive initialization", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-native-selection-"));
	try {
		const path = join(agentDir, "settings.json");
		const original = JSON.stringify({ defaultTools: ["+tool_search", "-codemode"], retry: { enabled: false } });
		writeFileSync(path, original);
		ensureNativeToolDefaults(agentDir);
		expect(readFileSync(path, "utf8")).toBe(original);
		const settings = SettingsManager.create(agentDir, agentDir);
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
		expect(() => ensureNativeToolDefaults(agentDir)).toThrow();
		expect(readFileSync(path, "utf8")).toBe("broken config");
	} finally { rmSync(agentDir, { recursive: true, force: true }); }
});
