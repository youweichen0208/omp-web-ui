import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { scmDiff } from "../../server/scm.js";

test("scope diff uses merge base, combines staged/worktree and includes untracked files", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-scm-diff-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	try {
		git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
		writeFileSync(join(cwd, "a.txt"), "first\n"); git("add", "."); git("commit", "-m", "initial");
		git("checkout", "-b", "feature"); writeFileSync(join(cwd, "a.txt"), "second\n"); git("commit", "-am", "change");
		expect((await scmDiff(cwd, { scope: "branch", base: "main" })).text).toContain("-first\n+second");
		writeFileSync(join(cwd, "a.txt"), "staged\n"); git("add", "."); writeFileSync(join(cwd, "a.txt"), "working\n"); writeFileSync(join(cwd, "new file.txt"), "new\n");
		const work = await scmDiff(cwd, { scope: "work" });
		expect(work.text).toContain("-second\n+working"); expect(work.text).not.toContain("+staged"); expect(work.text).toContain("+new\n");
		await expect(scmDiff(cwd, { scope: "branch", base: "--output=evil" })).rejects.toThrow();
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("unborn repository compares the final working tree to empty and counts an empty file as zero", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-scm-unborn-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	try {
		git("init", "-b", "main");
		writeFileSync(join(cwd, "a.txt"), "staged\n"); git("add", ".");
		writeFileSync(join(cwd, "a.txt"), "working\n"); writeFileSync(join(cwd, "empty.txt"), "");
		const { parseUnifiedDiff } = await import("../../web/src/changes.js");
		const files = parseUnifiedDiff((await scmDiff(cwd, { scope: "work" })).text);
		expect(files.map(file => [file.path, file.added, file.removed])).toEqual([["a.txt", 1, 0], ["empty.txt", 0, 0]]);
		expect(files[0].lines[0].text).toBe("working");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
