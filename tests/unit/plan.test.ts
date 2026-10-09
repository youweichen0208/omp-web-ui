import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { transition, planSnapshot, latestPlan } from "../../server/plan/state.js";
import { restorePlanContext } from "../../server/plan/extension.js";
import { PlanSettings } from "../../server/plan/settings.js";
import { deriveTaskProgress } from "../../server/task-progress.js";
import { serializeMessage, type AgentMessage } from "../../server/serialize.js";
import { planPresentation } from "../../web/src/plan-presentation.js";
import type { PlanSnapshot, UiMessage } from "../../server/protocol.js";

const input = { action: "create", title: "Build", status: "active", steps: [{ id: "a", title: "Inspect", detail: "Read everything" }, { id: "b", title: "Implement", detail: "Run checks" }], currentStepId: "a", completedStepIds: [], completionCriteria: "Tests pass" };
const create = () => transition(input, undefined, () => "p1");
const update = (plan = create(), patch = {}) => ({ ...plan, action: "update", expectedRevision: plan.revision, ...patch });
const user = (id: string): UiMessage => ({ id, role: "user", timestamp: 1, content: [{ type: "text", text: "Implement" }] });
const call = (id: string, name = "plan") => ({ type: "toolCall" as const, id, name, argumentsText: "{}" });
const assistant = (...ids: string[]): UiMessage => ({ id: `a-${ids.join()}`, role: "assistant", content: ids.map(id => call(id, id.startsWith("p") ? "plan" : "read")), timestamp: 2 });
const result = (id: string, plan: PlanSnapshot, isError = false): UiMessage => ({ id: `r-${id}`, role: "toolResult", toolName: "plan", toolCallId: id, content: [], planSnapshot: plan, isError, timestamp: 3 });

test("explicit completion closes the current step and completes the checklist (#37)", () => {
	const before = transition(update(create(), { currentStepId: "b", completedStepIds: ["a"] }), create());
	const command = update(before, { status: "completed" });
	const done = transition(command, before);
	expect(done).toMatchObject({ status: "completed", currentStepId: null, completedStepIds: ["a", "b"], revision: 3 });
	expect(done.changes).toContainEqual({ kind: "completed", stepId: "b", title: "Implement", position: 2 });
	expect(planSnapshot(done)).toEqual(done);
	expect(command.currentStepId).toBe("b");
	for (const patch of [{ currentStepId: "unknown" }, { completedStepIds: ["unknown"] }, { expectedRevision: 1 }, { planId: "other" }]) expect(() => transition({ ...command, ...patch }, before)).toThrow();
	expect(planSnapshot({ ...done, currentStepId: "b" })).toBeUndefined();
	expect(planSnapshot({ ...done, completedStepIds: ["a"] })).toBeUndefined();
	expect(before.status).toBe("active");
	for (const status of ["cancelled", "failed"]) expect(transition(update(before, { status }), before)).toMatchObject({ status, currentStepId: null, completedStepIds: ["a"] });
});

test("validation rejects invalid full states without changing previous state", () => {
	const before = create(), unchanged = structuredClone(before);
	for (const patch of [ { title: " " }, { title: "x".repeat(81) }, { completionCriteria: "x".repeat(241) }, { steps: [] }, { steps: Array(17).fill(input.steps[0]) }, { steps: [input.steps[0], input.steps[0]] }, { steps: [{ id: "x".repeat(65), title: "x" }] }, { steps: [{ id: "a", title: "x", detail: "x".repeat(501) }] }, { completedStepIds: ["missing"] }, { completedStepIds: ["b", "b"] }, { completedStepIds: ["a"] }, { currentStepId: "missing" }, { currentStepId: undefined }, { changeSummary: "x".repeat(241) } ]) expect(() => transition(update(before, patch), before)).toThrow();
	expect(before).toEqual(unchanged);
	for (const status of ["cancelled", "failed"]) expect(transition(update(before, { status, currentStepId: null }), before).status).toBe(status);
});

test("conflicts supply complete branch-local editable correction; ended plans require create", () => {
	const first = create(), second = transition(update(first, { currentStepId: "b", completedStepIds: ["a"] }), first);
	for (const patch of [{ planId: "other" }, { expectedRevision: 1 }]) {
		try { transition(update(second, patch), second); throw new Error("not rejected"); } catch (error) {
			expect(String(error)).toContain('"expectedRevision":2'); expect(String(error)).toContain("Read everything"); expect(String(error)).toContain('"completedStepIds":["a"]');
		}
	}
	expect(transition(update(second), second).revision).toBe(3);
	expect(() => transition(update(first))).toThrow(/none; use create/);
	const done = transition(update(second, { status: "completed", currentStepId: null, completedStepIds: ["a", "b"] }), second);
	expect(() => transition(update(done), done)).toThrow(/Use create/);
	const next = transition(input, first, () => "p2");
	expect(next.changes[0]).toEqual({ kind: "replaced", planId: "p1", revision: 1, reason: "Replaced by a newly created plan" });
	expect(first.status).toBe("active");
	expect(transition(input, done).changes.some(c => c.kind === "replaced")).toBe(false);
});

test("allowlist rejects unknown schemas, malformed changes, error results and third-party todo", () => {
	const snapshot = create();
	expect(planSnapshot({ ...snapshot, schemaVersion: 4 })).toBeUndefined();
	expect(planSnapshot({ ...snapshot, changes: [{ kind: "replaced", planId: "x", revision: 0, reason: "x" }] })).toBeUndefined();
	expect(planSnapshot({ ...snapshot, secret: "hidden", steps: snapshot.steps.map(s => ({ ...s, secret: "hidden" })) })).toEqual(snapshot);
	const raw = { role: "toolResult", toolName: "plan", toolCallId: "x", content: [], isError: false, timestamp: 1, details: JSON.parse(JSON.stringify({ planSnapshot: snapshot, secret: "hidden" })) } as AgentMessage;
	expect(serializeMessage(raw, 0)?.planSnapshot).toEqual(snapshot);
	expect(serializeMessage({ ...raw, isError: true } as AgentMessage, 0)?.planSnapshot).toBeUndefined();
	expect(serializeMessage({ ...raw, toolName: "todo" } as AgentMessage, 0)?.planSnapshot).toBeUndefined();
});

test("same-batch replay, failed updates, waiting, terminal tombstones and plan identity", () => {
	const first = create(), second = transition(update(first, { currentStepId: "b", completedStepIds: ["a"] }), first);
	const messages = [user("u"), assistant("p1", "read-a", "p2", "read-b", "p3", "read-c"), result("p1", first), result("p2", second), result("p3", first, true)];
	const task = deriveTaskProgress("c", messages, null, false)!;
	expect(task.plan?.items.map(i => i.toolCallIds)).toEqual([["read-a"], ["read-b", "read-c"]]);
	expect(task.status).toBe("failed");
	const next = deriveTaskProgress("c", [...messages, user("u2"), assistant("read-unrelated")], null, true)!;
	expect(next.plan?.awaitingConfirmation).toBe(true); expect(next.plan?.items.map(i => i.toolCallIds)).toEqual([["read-a"], ["read-b", "read-c"]]);
	expect(next.plan?.items.flatMap(i => i.toolCallIds ?? [])).not.toContain("read-unrelated");
	expect(next.steps.flatMap(s => s.artifacts.map(a => a.toolCallId))).toContain("read-unrelated");
	const done = transition(update(second, { status: "cancelled", currentStepId: null }), second);
	const ended = [...messages, assistant("p4"), result("p4", done)];
	expect(deriveTaskProgress("c", ended, null, false)?.status).toBe("cancelled");
	expect(deriveTaskProgress("c", [...ended, user("next")], null, false)).toBeNull();
	const replaced = transition(input, second, () => "new");
	const views = planPresentation([...messages, assistant("p5"), result("p5", replaced)], new Map([...messages, result("p5", replaced)].filter(m => m.toolCallId).map(m => [m.toolCallId!, m])), "c");
	expect(views.get("p1")).toMatchObject({ kind: "card", snapshot: { planId: "p1", status: "cancelled" } });
	expect(views.get("p2")).toMatchObject({ kind: "update" });
	expect(views.has("p3")).toBe(false);
	expect(views.get("p5")).toMatchObject({ kind: "card", snapshot: { planId: "new" } });
});

test("branch reconstruction and context restoration use latest successful paired full state", () => {
	const manager = SessionManager.inMemory("/tmp"), snapshot = create();
	const tool: Extract<AgentMessage, { role: "toolResult" }> = { role: "toolResult", toolName: "plan", toolCallId: "p", content: [], isError: false, timestamp: 3, details: JSON.parse(JSON.stringify({ planSnapshot: snapshot })) };
	manager.appendMessage(tool);
	const id = manager.getLeafId();
	const second = transition(update(snapshot), snapshot);
	manager.appendMessage({ ...tool, toolCallId: "p2", details: JSON.parse(JSON.stringify({ planSnapshot: second })) });
	manager.appendMessage({ ...tool, isError: true });
	expect(latestPlan(manager.getBranch())?.snapshot.revision).toBe(2);
	const restored = restorePlanContext([tool, { role: "user", content: "Continue", timestamp: 4 }], manager.getBranch());
	expect(restored[1]).toMatchObject({ role: "custom", customType: "pi-harness:plan-background" });
	expect(JSON.stringify(restored[1])).toContain("Read everything");
	manager.branch(id!);
	expect(latestPlan(manager.getBranch())?.snapshot.revision).toBe(1);
	const assistantMessage: AgentMessage = { api: "openai-completions", provider: "test", model: "test", stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, role: "assistant", content: [{ type: "toolCall", name: "plan", id: "p", arguments: input }], timestamp: 2 };
	const visible = [assistantMessage, tool];
	expect(restorePlanContext(visible, manager.getBranch())).toBe(visible);
	const summary: AgentMessage = { role: "compactionSummary", summary: "compressed", tokensBefore: 100, timestamp: 4 };
	expect(restorePlanContext([summary, { role: "user", content: "Other question", timestamp: 5 }], manager.getBranch())[1].role).toBe("custom");
	expect(manager.getBranch()).toHaveLength(1);
});

test("global preference defaults on and preserves explicit on/off choices", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-plan-unit-"));
	try {
		const settings = new PlanSettings(root); expect(settings.enabled).toBe(true);
		settings.set(false); expect(new PlanSettings(root).enabled).toBe(false);
		settings.set(true); expect(new PlanSettings(root).enabled).toBe(true);
		for (const invalid of ["{}", "null", '{"enabled":"false"}', "broken json"]) {
			writeFileSync(settings.path, invalid); expect(new PlanSettings(root).enabled).toBe(true);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovery is not blocked by stale/failed results or partial/incorrect call parameters", () => {
	const manager = SessionManager.inMemory("/tmp");
	const first = create(), second = transition(update(first), first);
	const raw = (plan: PlanSnapshot, id: string, isError = false): Extract<AgentMessage, { role: "toolResult" }> => ({ role: "toolResult", toolName: "plan", toolCallId: id, isError, content: [], details: JSON.parse(JSON.stringify({ planSnapshot: plan })), timestamp: 1 });
	manager.appendMessage(raw(first, "first")); manager.appendMessage(raw(second, "latest"));
	for (const messages of [[raw(first, "first")], [raw(second, "latest", true)], [raw(second, "latest")]]) {
		expect(restorePlanContext(messages, manager.getBranch()).some(message => message.role === "custom")).toBe(true);
	}
	const ended = transition(update(second, { status: "failed", currentStepId: null }), second);
	manager.appendMessage(raw(ended, "ended"));
	const messages: AgentMessage[] = [{ role: "user", content: "Continue?", timestamp: 4 }];
	expect(restorePlanContext(messages, manager.getBranch())).toBe(messages);
});

test("structural changes include detail edits, reordering, removal and explicit status", () => {
	const first = create();
	const second = transition(update(first, { steps: [{ id: "b", title: "Implement", detail: "Changed detail" }, { id: "a", title: "Inspect", detail: "Read everything" }], changeSummary: "Reordered" }), first);
	expect(second.changes.filter(change => change.kind === "updated")).toHaveLength(2);
	const third = transition(update(second, { steps: [second.steps[0]], currentStepId: null, status: "cancelled" }), second);
	expect(third.changes).toContainEqual({ kind: "removed", stepId: "a", title: "Inspect" });
	expect(third.changes).toContainEqual({ kind: "status", status: "cancelled" });
	const ordinary = transition(update(second, { currentStepId: "b" }), second);
	const task = deriveTaskProgress("c", [user("u"), assistant("p1", "p2", "p3"), result("p1", first), result("p2", second), result("p3", ordinary)], null, false);
	expect(task?.plan?.changeSummary).toBe("Reordered");
});

test("an unrelated failed tool stays outside the waiting historical plan", () => {
	const messages = [user("u1"), assistant("p1"), result("p1", create()), user("u2"), assistant("read-bad"), { id: "failed", role: "toolResult", toolName: "read", toolCallId: "read-bad", isError: true, content: [], timestamp: 5 }];
	const task = deriveTaskProgress("c", messages, null, false);
	expect(task?.status).toBe("failed");
	expect(task?.plan?.awaitingConfirmation).toBe(true);
	expect(task?.plan?.items.every(item => !item.toolCallIds?.length)).toBe(true);
});

test("an unrelated running request keeps its own status and title until plan confirmation", () => {
	const plan = { ...create(), title: "重构" };
	const request = { ...user("u2"), content: [{ type: "text", text: "解释一下 README 的安装步骤" }] };
	const messages = [user("u1"), assistant("p1"), result("p1", plan), request, assistant("read-readme")];
	const running = deriveTaskProgress("c", messages, null, true);
	expect(running).toMatchObject({ status: "running", title: "解释一下 README 的安装步骤", plan: { title: "重构", awaitingConfirmation: true } });
	expect(running?.plan?.items.flatMap(item => item.toolCallIds ?? [])).not.toContain("read-readme");
	const settled = deriveTaskProgress("c", messages, null, false);
	expect(settled).toMatchObject({ status: "waiting", title: "解释一下 README 的安装步骤" });
	const confirmed = deriveTaskProgress("c", [...messages, assistant("p2"), result("p2", transition(update(plan), plan))], null, true);
	expect(confirmed).toMatchObject({ status: "running", title: "重构", plan: { awaitingConfirmation: false } });
});


test("failed completion retains the last saved steps, and corrected completion clears the error", () => {
	const plan = create();
	const messages = [user("u"), assistant("p1"), result("p1", plan), assistant("p-bad"), { ...result("p-bad", plan), isError: true }];
	const failed = deriveTaskProgress("c", messages, null, false);
	expect(failed?.status).toBe("failed");
	expect(failed?.plan?.items.map(item => item.status)).toEqual(["running", "pending"]);
	const done = transition(update(plan, { status: "completed", currentStepId: null, completedStepIds: ["a", "b"] }), plan);
	const corrected = deriveTaskProgress("c", [...messages, assistant("p-fixed"), result("p-fixed", done)], null, false);
	expect(corrected?.status).toBe("done");
	expect(corrected?.plan?.items.every(item => item.status === "done")).toBe(true);
});

const recoveryPrompt = (): UiMessage => ({ ...user("recovery"), content: [{ type: "text", text: "你上一条回复里的工具调用是以普通文本输出的，没有被执行。请通过工具调用（不要写成文本）重新发起它，然后继续完成任务。" }] });
const toolTextReply = (): UiMessage => ({ id: "tool-text", role: "assistant", stopReason: "stop", content: [{ type: "text", text: '<invoke name="read"><parameter name="path">README.md</parameter></invoke>' }] });

test("tool-text recovery preserves the task, confirmed plan and tool attribution across transcript replay", () => {
	const messages = [user("original"), assistant("p1", "read-before"), result("p1", create()), toolTextReply(), recoveryPrompt(), assistant("read-after")];
	for (const streaming of [true, false]) {
		const task = deriveTaskProgress("c", JSON.parse(JSON.stringify(messages)), null, streaming)!;
		expect(task.sourceMessageId).toBe("original");
		expect(task.plan?.awaitingConfirmation).toBe(false);
		expect(task.plan?.items[0]).toMatchObject({ status: "running", toolCallIds: ["read-before", "read-after"] });
		expect(task.steps.flatMap(step => step.artifacts.map(a => a.toolCallId))).toEqual(["read-before", "read-after"]);
	}
});

test("new requests demote historical current steps without losing completion or reconfirmation", () => {
	const first = create(), second = transition(update(first, { currentStepId: "b", completedStepIds: ["a"] }), first);
	const messages = [user("original"), assistant("p1"), result("p1", second), user("new-request")];
	const task = deriveTaskProgress("c", messages, null, true)!;
	expect(task.plan?.awaitingConfirmation).toBe(true);
	expect(task.plan?.items.map(item => item.status)).toEqual(["done", "pending"]);
	const resumed = deriveTaskProgress("c", [...messages, assistant("p2"), result("p2", transition(update(second), second))], null, true)!;
	expect(resumed.plan?.items.map(item => item.status)).toEqual(["done", "running"]);
});

test("recovery cannot confirm an unrelated historical plan or swallow ordinary user messages", () => {
	const base = [user("original"), assistant("p1"), result("p1", create())];
	const unrelated = [...base, user("new-request"), toolTextReply(), recoveryPrompt(), assistant("read-other")];
	const task = deriveTaskProgress("c", unrelated, null, true)!;
	expect(task.sourceMessageId).toBe("new-request");
	expect(task.plan?.awaitingConfirmation).toBe(true);
	expect(task.plan?.items.flatMap(item => item.toolCallIds ?? [])).not.toContain("read-other");
	for (const reply of [assistant("read-real"), { ...toolTextReply(), stopReason: "aborted" }, { ...toolTextReply(), stopReason: "error" }, { ...toolTextReply(), content: [{ type: "text", text: "Finished" }] }]) {
		const ordinary = deriveTaskProgress("c", [...base, reply, recoveryPrompt()], null, true)!;
		expect(ordinary.sourceMessageId).toBe("recovery");
		expect(ordinary.plan?.awaitingConfirmation).toBe(true);
	}
});
