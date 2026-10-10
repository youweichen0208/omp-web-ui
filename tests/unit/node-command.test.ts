import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodeCommand } from "../../server/node-command.js";

describe("SSH command directory boundary", () => {
	it("rejects invalid working directories and NUL commands", () => {
		for (const path of ["relative", "/tmp\nwhoami", "/tmp\0no"]) expect(() => nodeCommand(path, "pwd")).toThrow();
		expect(() => nodeCommand("/tmp", "echo\0bad")).toThrow();
	});
	it.skipIf(process.platform === "win32")("quotes unusual paths and never executes after a failed cd", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-node-quote-' ; $()-"));
		try {
			expect(execFileSync("sh", ["-c", nodeCommand(root, "pwd")], { encoding: "utf8" }).trim()).toContain(root.split("/").at(-1));
			expect(() => execFileSync("sh", ["-c", nodeCommand(join(root, "missing"), "echo first; touch must-not-run")], { cwd: root, stdio: "ignore" })).toThrow();
			expect(existsSync(join(root, "must-not-run"))).toBe(false);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});
