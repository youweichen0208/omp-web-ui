import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { workspacePath } from "../../server/files-service.js";

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
