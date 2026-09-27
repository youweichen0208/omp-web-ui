import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const parameters = Type.Object({
	steps: Type.Array(Type.Object({ id: Type.String(), title: Type.String() }), { minItems: 1, maxItems: 16 }),
	currentStepId: Type.Optional(Type.String()),
	completedStepIds: Type.Optional(Type.Array(Type.String())),
});

/** The transcript stores every revision; no separate mutable plan state is needed. */
export function makeTaskPlanTool(): ToolDefinition<typeof parameters> {
	let revision = 0;
	return {
		name: "task_plan",
		label: "Task plan",
		description: "For work expected to take at least three distinct steps, call this before other tools with a complete ordered plan. Give each step a stable short id and action title. Set currentStepId to the step being worked on; pass completedStepIds as work finishes. Call again with the full updated list when the plan changes. Continue execution immediately after planning; do not ask for approval just to start. Do not use for simple one-step tasks.",
		parameters,
		execute: async (_id, params) => {
			const ids = params.steps.map((step) => step.id.trim());
			if (new Set(ids).size !== ids.length || ids.some((id) => !id)) throw new Error("Plan step ids must be unique and nonempty");
			if (params.steps.some((step) => !step.title.trim() || step.title.length > 80)) throw new Error("Plan step titles must be 1–80 characters");
			if (params.currentStepId && !ids.includes(params.currentStepId)) throw new Error("currentStepId must name a plan step");
			if (params.completedStepIds?.some((id) => !ids.includes(id))) throw new Error("completedStepIds must name plan steps");
			revision++;
			return { content: [{ type: "text", text: `Plan revision ${revision} recorded: ${params.steps.length} steps. Continue execution.` }], details: undefined };
		},
	};
}
