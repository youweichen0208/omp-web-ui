import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("odd untracked files do not fail the work view, and large listings are capped", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-scm-untracked-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	try {
		git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
		writeFileSync(join(cwd, "a.txt"), "first\n"); git("add", "."); git("commit", "-m", "initial");
		writeFileSync(join(cwd, "a.txt"), "second\n");
		symlinkSync(tmpdir(), join(cwd, "outside-link"));
		symlinkSync(join(cwd, "missing-target"), join(cwd, "broken-link"));
		writeFileSync(join(cwd, "note.txt"), "kept\n");
		let work = await scmDiff(cwd, { scope: "work" });
		expect(work.text).toContain("-first\n+second");
		expect(work.text).toContain("+kept\n");
		expect(work.text).toContain('Binary files /dev/null and "b/outside-link" differ');
		expect(work.text).toContain('Binary files /dev/null and "b/broken-link" differ');
		expect(work.omittedUntracked).toBeUndefined();
		mkdirSync(join(cwd, "generated"));
		for (let i = 0; i < 1200; i++) writeFileSync(join(cwd, "generated", `f${i}.txt`), `x${i}\n`);
		const started = performance.now();
		work = await scmDiff(cwd, { scope: "work" });
		// One git process per scope instead of three per untracked file.
		expect(performance.now() - started).toBeLessThan(5000);
		expect(work.omittedUntracked).toBe(1203 - 500);
		expect(work.text.match(/^diff --git /gm)).toHaveLength(501);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
}, 30000);

test("a diff over the output cap falls back to normal context instead of failing", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-scm-large-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	try {
		git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
		const lines = Array.from({ length: 300000 }, (_, i) => `line ${String(i).padStart(7, "0")} ${"x".repeat(110)}`);
		writeFileSync(join(cwd, "big.txt"), lines.join("\n") + "\n"); git("add", "."); git("commit", "-m", "initial");
		git("checkout", "-b", "feature");
		lines[150000] = "changed";
		writeFileSync(join(cwd, "big.txt"), lines.join("\n") + "\n"); git("commit", "-am", "change");
		const branch = await scmDiff(cwd, { scope: "branch", base: "main" });
		expect(branch.reducedContext).toBe(true);
		expect(branch.text).toContain("+changed");
		expect(branch.text.length).toBeLessThan(10000);
		const small = await scmDiff(cwd, { scope: "work" });
		expect(small.reducedContext).toBeUndefined();
	} finally { rmSync(cwd, { recursive: true, force: true }); }
}, 60000);
