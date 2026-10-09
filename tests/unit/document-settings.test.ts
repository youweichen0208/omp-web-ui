import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocumentSettings, updateDocumentSettings } from "../../server/document-conversion/settings.js";

const folders: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function settingsFile() {
	const folder = mkdtempSync(join(tmpdir(), "document-settings-"));
	folders.push(folder); vi.stubEnv("PI_WEB_DATA_DIR", folder);
	return join(folder, "document-extensions.json");
}
describe("document extension settings", () => {
	it("defaults to lazy enabled and observes external disables while retaining other settings", () => {
		const file = settingsFile();
		expect(getDocumentSettings()).toEqual({ pdfEnabled: true, okfEnabled: true });
		writeFileSync(file, JSON.stringify({ pdfEnabled: false, okfEnabled: true, futureOption: "keep" }));
		expect(getDocumentSettings().pdfEnabled).toBe(false);
		updateDocumentSettings({ okfEnabled: false, pythonPath: join(tmpdir(), "python with spaces") });
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pdfEnabled: false, okfEnabled: false, futureOption: "keep" });
		updateDocumentSettings({ pythonPath: "" });
		expect(getDocumentSettings().pythonPath).toBeUndefined();
	});
	it("does not enable features or replace configuration when a saved file is invalid", () => {
		const file = settingsFile();
		writeFileSync(file, "broken");
		expect(() => getDocumentSettings()).toThrow(/document-extensions/);
		expect(() => updateDocumentSettings({ pdfEnabled: true })).toThrow();
		expect(readFileSync(file, "utf8")).toBe("broken");
		writeFileSync(file, "{}");
		expect(() => updateDocumentSettings({ pythonPath: "python -c command" })).toThrow(/absolute/);
	});
});
