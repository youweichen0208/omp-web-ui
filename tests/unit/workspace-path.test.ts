import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRealPathInWorkspace, workspacePath } from "../../server/files-service.js";

describe("workspacePath", () => {
	it("accepts files inside the workspace", () => {
		const cwd = process.cwd();
		expect(workspacePath(cwd, "a/b.txt")?.rel).toBe("a/b.txt");
	});

	it("rejects parent escapes", () => {
		expect(workspacePath(process.cwd(), "../x")).toBeNull();
		expect(workspacePath(process.cwd(), "a/../../x")).toBeNull();
	});

	it("allows names that merely start with two dots", () => {
		expect(workspacePath(process.cwd(), "..foo/a.txt")?.rel).toBe("..foo/a.txt");
	});

	it.skipIf(process.platform !== "win32")("rejects other drives and UNC paths on Windows", () => {
		expect(workspacePath("C:\\ws", "D:\\secret.txt")).toBeNull();
		expect(workspacePath("C:\\ws", "\\\\host\\share\\x")).toBeNull();
	});

	it("documents the win32 relative() behavior the guard relies on", () => {
		expect(win32.isAbsolute(win32.relative("C:\\ws", "D:\\secret.txt"))).toBe(true);
		expect(posix.isAbsolute(posix.relative("/ws", "/ws/a"))).toBe(false);
	});
});

describe.skipIf(process.platform === "win32")("isRealPathInWorkspace", () => {
	const base = mkdtempSync(join(tmpdir(), "ws-real-"));
	const root = join(base, "ws");
	const outside = join(base, "outside.txt");
	mkdirSync(root);
	writeFileSync(outside, "secret");
	writeFileSync(join(root, "ok.txt"), "ok");
	symlinkSync(outside, join(root, "link.txt"));
	symlinkSync(join(root, "ok.txt"), join(root, "inner.txt"));
	afterAll(() => rmSync(base, { recursive: true, force: true }));

	it("accepts regular files and links that stay inside", () => {
		expect(isRealPathInWorkspace(root, join(root, "ok.txt"))).toBe(true);
		expect(isRealPathInWorkspace(root, join(root, "inner.txt"))).toBe(true);
	});

	it("rejects links that point outside", () => {
		expect(isRealPathInWorkspace(root, join(root, "link.txt"))).toBe(false);
	});

	it("leaves missing files to the caller", () => {
		expect(isRealPathInWorkspace(root, join(root, "missing.txt"))).toBe(true);
	});
});
