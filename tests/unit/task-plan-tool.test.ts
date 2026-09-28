import { expect, test } from "vitest";
import { Check } from "typebox/value";
import { makeTaskPlanTool } from "../../server/task-plan-tool.js";

test("plan tool records revisions and rejects invalid step references", async () => {
	const tool = makeTaskPlanTool();
	const context = {} as Parameters<typeof tool.execute>[4];
	const steps = [{ id: "read", title: "读取约定" }, { id: "build", title: "实现服务" }, { id: "test", title: "运行测试" }];
	const meta = { title: "实现服务", completionCriteria: "服务可用且测试通过" };
	const first = await tool.execute("p1", { ...meta, steps, currentStepId: "read" }, undefined, undefined, context);
	const second = await tool.execute("p2", { ...meta, steps, currentStepId: "build", completedStepIds: ["read"] }, undefined, undefined, context);
	expect(first.content[0]).toMatchObject({ text: "Plan revision 1 recorded: 3 steps." });
	expect(second.content[0]).toMatchObject({ text: "Plan revision 2 recorded: 3 steps." });
	await expect(tool.execute("bad", { ...meta, steps, currentStepId: "missing" }, undefined, undefined, context)).rejects.toThrow("currentStepId");
	await expect(tool.execute("dup", { ...meta, steps: [steps[0], steps[0]] }, undefined, undefined, context)).rejects.toThrow("unique");
	const revised = [...steps.slice(0, 2), { id: "schema", title: "修正校验" }, steps[2]];
	await expect(tool.execute("changed", { ...meta, steps: revised }, undefined, undefined, context)).rejects.toThrow("changeSummary");
	await expect(tool.execute("changed", { ...meta, steps: revised, changeSummary: "新增校验步骤" }, undefined, undefined, context)).resolves.toBeDefined();
});

test.each([1, 2, 8, 16])("plan accepts %i actual steps without enforcing the 3–7 suggestion", async (count) => {
	const tool = makeTaskPlanTool();
	const context = {} as Parameters<typeof tool.execute>[4];
	const steps = Array.from({ length: count }, (_, index) => ({ id: `step-${index}`, title: `Action ${index + 1}` }));
	const plan = { title: "Implement feature", completionCriteria: "Feature works", steps };
	expect(Check(tool.parameters, plan)).toBe(true);
	const result = await tool.execute("plan", plan, undefined, undefined, context);
	expect(result.content).toEqual([{ type: "text", text: `Plan revision 1 recorded: ${count} steps.` }]);
});

test.each([0, 17])("plan rejects %i steps outside transcript capacity", async (count) => {
	const tool = makeTaskPlanTool();
	const context = {} as Parameters<typeof tool.execute>[4];
	const steps = Array.from({ length: count }, (_, index) => ({ id: `step-${index}`, title: `Action ${index + 1}` }));
	await expect(tool.execute("plan", { title: "Implement feature", completionCriteria: "Feature works", steps }, undefined, undefined, context)).rejects.toThrow("1–16");
});
