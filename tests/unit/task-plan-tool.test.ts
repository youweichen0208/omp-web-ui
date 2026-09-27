import { expect, test } from "vitest";
import { makeTaskPlanTool } from "../../server/task-plan-tool.js";

test("plan tool records revisions and rejects invalid step references", async () => {
	const tool = makeTaskPlanTool();
	const context = {} as Parameters<typeof tool.execute>[4];
	const steps = [{ id: "read", title: "读取约定" }, { id: "build", title: "实现服务" }, { id: "test", title: "运行测试" }];
	const first = await tool.execute("p1", { steps, currentStepId: "read" }, undefined, undefined, context);
	const second = await tool.execute("p2", { steps, currentStepId: "build", completedStepIds: ["read"] }, undefined, undefined, context);
	expect(first.content[0]).toMatchObject({ text: "Plan revision 1 recorded: 3 steps. Continue execution." });
	expect(second.content[0]).toMatchObject({ text: "Plan revision 2 recorded: 3 steps. Continue execution." });
	await expect(tool.execute("bad", { steps, currentStepId: "missing" }, undefined, undefined, context)).rejects.toThrow("currentStepId");
	await expect(tool.execute("dup", { steps: [steps[0], steps[0]] }, undefined, undefined, context)).rejects.toThrow("unique");
});
