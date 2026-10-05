import { describe, expect, it } from "vitest";
import { catalogInstallation, extensionDate, extensionDownloads } from "../../web/src/extensions-presentation.js";
import type { ExtensionPackage } from "../../server/protocol.js";
const pkg = (overrides: Partial<ExtensionPackage> = {}): ExtensionPackage => ({
	id: "user:npm:sample", source: "npm:sample", name: "sample", scope: "user", kind: "npm",
	enabled: true, pinned: false, trusted: true, resources: { extensions: [], skills: [], prompts: [], themes: [] }, ...overrides,
});
describe("extension catalog presentation", () => {
	it("formats download counts without fabricating missing metrics", () => {
		expect(extensionDownloads(undefined, "zh")).toBe("—");
		expect(extensionDownloads(9999, "zh")).toBe("9,999 / 月");
		expect(extensionDownloads(12500, "zh")).toBe("1.3 万 / 月");
		expect(extensionDownloads(42000, "en")).toBe("42K / mo");
	});
	it("uses calendar days at midnight and week/date boundaries", () => {
		const now = new Date(2026, 9, 5, 0, 1).getTime();
		expect(extensionDate(new Date(2026, 9, 4, 23, 59).getTime(), "zh", now)).toBe("昨天");
		expect(extensionDate(new Date(2026, 9, 2).getTime(), "en", now)).toBe("3 days ago");
		expect(extensionDate(new Date(2026, 8, 28).getTime(), "zh", now)).toBe("1 周前");
		expect(extensionDate(new Date(2026, 8, 4).getTime(), "en", now)).toBe("9/4/2026");
		expect(extensionDate(undefined, "zh", now)).toBe("");
	});
	it("selects the eligible native scope and respects pins, protection and trust", () => {
		const pinned = pkg({ pinned: true, update: true });
		const project = pkg({ id: "project:npm:sample", scope: "project", update: true });
		expect(catalogInstallation([pinned, project], "sample")).toBe(project);
		expect(catalogInstallation([pkg({ trusted: false, update: true }), project], "sample")).toBe(project);
		expect(catalogInstallation([pkg({ protected: true, update: true }), project], "sample")).toBe(project);
		expect(catalogInstallation([pinned], "sample")).toBe(pinned);
		expect(catalogInstallation([pkg({ kind: "local" })], "sample")).toBeUndefined();
		expect(catalogInstallation([project], "different")).toBeUndefined();
	});
});
