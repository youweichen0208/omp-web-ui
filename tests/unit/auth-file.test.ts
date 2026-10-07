import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { updateAuthFile } from "../../server/auth-file.js";

const base = mkdtempSync(join(tmpdir(), "auth-file-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("updateAuthFile", () => {
	it("creates a missing file as 0600 and keeps other providers", async () => {
		const path = join(base, "new", "auth.json");
		await updateAuthFile(path, (d) => ({ ...d, a: { type: "api_key", key: "1" } }));
		await updateAuthFile(path, (d) => ({ ...d, b: { type: "api_key", key: "2" } }));
		expect(Object.keys(read(path))).toEqual(["a", "b"]);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("never replaces an unreadable file", async () => {
		const path = join(base, "broken.json");
		writeFileSync(path, "{ oauth tokens ... not json", { mode: 0o600 });
		await expect(updateAuthFile(path, (d) => ({ ...d, x: 1 }))).rejects.toThrow(/无法解析/);
		expect(readFileSync(path, "utf8")).toBe("{ oauth tokens ... not json");
		writeFileSync(path, "[1,2]");
		await expect(updateAuthFile(path, (d) => ({ ...d, x: 1 }))).rejects.toThrow(/格式不正确/);
	});

	it("leaves the file alone when mutate returns undefined", async () => {
		const path = join(base, "keep.json");
		writeFileSync(path, '{"a":{"type":"oauth"}}');
		expect(await updateAuthFile(path, () => undefined)).toBe(false);
		expect(readFileSync(path, "utf8")).toBe('{"a":{"type":"oauth"}}');
	});

	it("keeps the mode of an existing file and releases the lock", async () => {
		const path = join(base, "mode.json");
		writeFileSync(path, "{}");
		chmodSync(path, 0o640);
		await updateAuthFile(path, () => ({ k: 1 }));
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o640);
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	it("serializes concurrent updates without losing writes", async () => {
		const path = join(base, "race.json");
		await Promise.all(
			Array.from({ length: 12 }, (_, i) => updateAuthFile(path, (d) => ({ ...d, [`p${i}`]: i }))),
		);
		expect(Object.keys(read(path))).toHaveLength(12);
	});
});
