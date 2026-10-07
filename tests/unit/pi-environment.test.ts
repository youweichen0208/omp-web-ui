import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { browseDirs } from "../../server/dir-browser.js";
import { PiConfigProbe, compareVersions } from "../../server/pi-environment.js";
import type { ServerMessage } from "../../server/protocol.js";

const base = mkdtempSync(join(tmpdir(), "pi-env-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("compareVersions", () => {
	it("orders numeric semver parts", () => {
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
		expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareVersions("0.99.9", "1.0.0")).toBeLessThan(0);
	});
});

describe("PiConfigProbe", () => {
	it("is configured only when auth.json has a provider, and can be invalidated", () => {
		const dir = join(base, "agent");
		mkdirSync(dir);
		const probe = new PiConfigProbe(dir);
		expect(probe.isConfigured()).toBe(false);
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: {} }));
		expect(probe.isConfigured()).toBe(false); // cached for 2s
		probe.invalidate();
		expect(probe.isConfigured()).toBe(true);
	});
});

describe("browseDirs", () => {
	it("lists visible subdirectories only, sorted", async () => {
		const root = join(base, "browse");
		for (const d of ["b", "a", ".hidden"]) mkdirSync(join(root, d), { recursive: true });
		writeFileSync(join(root, "file.txt"), "x");
		const sent: ServerMessage[] = [];
		await browseDirs(root, (m) => sent.push(m));
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ type: "dir_browse", path: root, dirs: ["a", "b"], truncated: false });
	});

	it("reports unreadable directories as an error notice", async () => {
		const sent: ServerMessage[] = [];
		await browseDirs(join(base, "missing"), (m) => sent.push(m));
		expect(sent[0]).toMatchObject({ type: "notice", level: "error" });
	});
});
