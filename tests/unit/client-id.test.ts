import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isValidClientId } from "../../server/client-id.js";
import { saveUpload } from "../../server/uploads.js";

describe("isValidClientId", () => {
	it("accepts UUIDs and plain slugs", () => {
		for (const id of ["3f2b8a52-1d0c-4a37-9a1e-8f7b6c5d4e3a", "tester", "settings-test-client", "a.b_c-d", "A".repeat(128)]) {
			expect(isValidClientId(id), id).toBe(true);
		}
	});

	it("rejects anything that could leave the uploads directory or is not a string", () => {
		for (const id of ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "-x", "a b", "x\0y", "A".repeat(129), 5, null, {}, []]) {
			expect(isValidClientId(id), String(id)).toBe(false);
		}
	});
});

describe("saveUpload", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "upload-"));
	afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

	it("stores files under uploads/<clientId>/", () => {
		const { abs } = saveUpload("tester", "a.txt", Buffer.from("x"), dataDir);
		expect(abs.startsWith(join(dataDir, "uploads", "tester"))).toBe(true);
	});

	it("refuses an id that escapes the uploads directory", () => {
		expect(() => saveUpload("../../escaped", "a.txt", Buffer.from("x"), dataDir)).toThrow(/invalid upload location/);
		expect(() => saveUpload("", "a.txt", Buffer.from("x"), dataDir)).toThrow(/invalid upload location/);
	});
});
