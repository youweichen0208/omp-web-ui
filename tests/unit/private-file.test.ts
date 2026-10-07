import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import { PluginSecrets } from "../../server/plugin-facilities.js";
import { writeFileAtomic } from "../../server/private-file.js";

const base = mkdtempSync(join(tmpdir(), "private-file-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const mode = (p: string) => statSync(p).mode & 0o777;
const posix = process.platform !== "win32";

describe.skipIf(!posix)("writeFileAtomic", () => {
	it("creates private directories and files and leaves no temp file", () => {
		const path = join(base, "a", "b", "state.json");
		writeFileAtomic(path, "{}");
		expect(mode(path)).toBe(0o600);
		expect(mode(join(base, "a"))).toBe(0o700);
		expect(readdirSync(join(base, "a", "b"))).toEqual(["state.json"]);
	});

	it("tightens a previously world-readable file", () => {
		const path = join(base, "loose.json");
		writeFileSync(path, "old");
		chmodSync(path, 0o644);
		writeFileAtomic(path, "new");
		expect(mode(path)).toBe(0o600);
		expect(readFileSync(path, "utf8")).toBe("new");
	});

	it("keeps the owner's chosen mode when asked", () => {
		const path = join(base, "models.json");
		writeFileSync(path, "{}");
		chmodSync(path, 0o640);
		writeFileAtomic(path, "{\"x\":1}", { keepExistingMode: true });
		expect(mode(path)).toBe(0o640);
		writeFileAtomic(join(base, "fresh.json"), "{}", { keepExistingMode: true });
		expect(mode(join(base, "fresh.json"))).toBe(0o600);
	});
});

describe.skipIf(!posix)("data files written by the server", () => {
	it("client-state.json is private", () => {
		const file = join(base, "data", "client-state.json");
		new ClientStateStore(file).remember("c1", "/work");
		expect(mode(file)).toBe(0o600);
	});

	it("secrets.key and secrets.bin are created private", () => {
		const dataDir = join(base, "secrets-data");
		const secrets = new PluginSecrets(dataDir, join(dataDir, "plugin"));
		secrets.set("token", "value");
		expect(mode(join(dataDir, "secrets.key"))).toBe(0o600);
		expect(mode(join(dataDir, "plugin", "secrets.bin"))).toBe(0o600);
		expect(secrets.get("token")).toBe("value");
	});
});
