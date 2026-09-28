import { describe, expect, it } from "vitest";
import { commandPresentation, gitStatusLine, gitStatusSummary } from "../../web/src/bash-presentation.js";
import { planStepPresentation } from "../../web/src/task-progress-view.js";

describe("running state presentation", () => {
	it("moves literal directories to badges without obscuring dynamic shell expressions", () => {
		const cwd = "/Users/alice/projects/app";
		expect(commandPresentation(`cd "${cwd}" && git status --short`, cwd)).toEqual({ command: "git status --short", directory: null });
		expect(commandPresentation("cd ../docs && ls", cwd)).toEqual({ command: "ls", directory: "~/projects/docs" });
		for (const command of ['cd "$TARGET" && ls', 'cd "$(pwd)" && ls', 'cd - && ls', 'cd ~bob && ls', 'cd .; ls', "cd '~/app' && ls", "cd 'price$' && ls", 'cd foo\\ bar && ls']) expect(commandPresentation(command, cwd).command).toBe(command);
	});
	it("aligns index/worktree status and counts only complete short-status output", () => {
		const lines = [" M docs/plan.md", "A  src/new.ts", "?? new folder/file.ts", " D old.ts", "UU conflict.ts"];
		expect(gitStatusLine(lines[0])).toEqual({ status: "M", path: "docs/plan.md", kind: "modified" });
		expect(gitStatusSummary("git add . && git status --short", lines)).toEqual({ files: 5, added: 2, modified: 1, deleted: 1, conflicts: 1 });
		expect(gitStatusSummary("git status --short", [...lines, "fatal: failed"])).toBeNull();
		expect(gitStatusSummary("echo 'git status'", lines)).toBeNull();
	});
	it("preserves authored plan details, extracting only a label and trailing parentheses", () => {
		expect(planStepPresentation("Core: 构建 FrozenEvidence（case plan + evidence snapshot 转换）")).toEqual({ tag: "core", title: "构建 FrozenEvidence", detail: "case plan + evidence snapshot 转换" });
		expect(planStepPresentation("agent-runtime: 实现子进程入口（stdin → stdout）").tag).toBe("runtime");
		expect(planStepPresentation("修复 foo(a(b)) 的错误").title).toBe("修复 foo(a(b)) 的错误");
	});
});
