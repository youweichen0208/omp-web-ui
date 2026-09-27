import { expect, test } from "vitest";
import type { TaskProgress, TaskStep, UiMessage } from "../../server/protocol.js";
import { phaseSummary, plainTitle, progressPhases, progressResult } from "../../web/src/task-progress-view.js";

const makeStep = (id: string, title: string, kind: string, timestamp: number): TaskStep => ({ id, messageId: id, title, status: "done", startedAt: timestamp, endedAt: timestamp + 1000, artifacts: [{ toolCallId: id, kind, label: title }] });

test("consecutive raw steps become phases without losing source steps", () => {
	const steps = [makeStep("r1", "读取约定", "read", 100), makeStep("r2", "读取文件", "read", 200), makeStep("w1", "实现 jobs 服务", "write", 300), makeStep("m1", "补 migrations", "write", 400), makeStep("t1", "运行 pytest", "bash", 500), makeStep("e1", "修复测试", "edit", 600), makeStep("c1", "git commit", "bash", 700)];
	const task: TaskProgress = { id: "task", conversationId: "c", sourceMessageId: "u", title: "继续：S02b 主体实现", status: "done", startedAt: 100, completed: steps.length, steps };
	const phases = progressPhases(task);
	expect(phases.map((phase) => phase.kind)).toEqual(["read", "build", "migration", "test", "fix", "commit"]);
	expect(phases[0].steps.map((step) => step.id)).toEqual(["r1", "r2"]);
	expect(plainTitle("**补** `migrations`")).toBe("补 migrations");
});

test("result card only uses values found in the task transcript", () => {
	const task: TaskProgress = { id: "task", conversationId: "c", sourceMessageId: "u", title: "继续：S02b", status: "done", startedAt: 100, completed: 0, steps: [] };
	const messages: UiMessage[] = [{ id: "u", role: "user", content: [{ type: "text", text: "继续" }] }, { id: "a", role: "assistant", content: [{ type: "text", text: "提交 f9c3a1e feat: S02b 主体\n测试 48 / 48 通过\n改动 +312 −40 · 11 个文件" }] }];
	expect(progressResult(task, messages)).toEqual({ commit: { hash: "f9c3a1e", subject: "feat: S02b 主体" }, tests: { passed: 48, total: 48 }, changes: { added: 312, deleted: 40, files: 11 } });
	expect(progressResult(task, messages.slice(0, 1))).toEqual({});
});

test("inferred phases use concrete titles and command summaries", () => {
	const steps: TaskStep[] = [
		{ ...makeStep("r", "读取进度与测试约定", "read", 100), artifacts: [{ toolCallId: "r", kind: "read", label: "docs/progress.md", path: "docs/progress.md" }] },
		{ ...makeStep("e", "修复测试配置", "edit", 200), artifacts: [{ toolCallId: "e", kind: "edit", label: "tests/conftest.py", path: "tests/conftest.py" }] },
		{ ...makeStep("b", "运行测试", "bash", 300), artifacts: [{ toolCallId: "b", kind: "bash", label: "pytest tests/test_jobs.py" }] },
	];
	const task: TaskProgress = { id: "task", conversationId: "c", sourceMessageId: "u", title: "S02b 主体实现", status: "running", startedAt: 100, completed: 2, steps };
	const phases = progressPhases(task);
	expect(phases[0].title).toBe("读取进度与测试约定");
	expect(phases[0].title).not.toBe("处理任务");
	expect(phaseSummary(phases.at(-1)!, { passed: 48, total: 48 })).toContain("运行 1 条命令");
	expect(phaseSummary(phases.at(-1)!, { passed: 48, total: 48 }, "en")).toContain("Ran 1 command · 48/48 passed");
	expect(phaseSummary(phases[1])).toContain("tests/conftest.py");
});
