import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const TASK_PLAN_GUIDANCE = [
	"task_plan records task progress; it does not select a workflow or authorize execution.",
	"When the user has asked you to implement a long task with multiple stages and the scope is clear, call task_plan before the main implementation work with a short task title, completionCriteria, and an ordered outline. Aim for 3–7 meaningful steps; use fewer or more when appropriate rather than padding or splitting steps to meet a quota.",
	"Questions, explanations, small changes, clarification interviews, and design discussions do not require an implementation plan. Follow the user's instructions and the active skill's workflow: when clarification, answers, or confirmation are required, wait for them even if a plan has already been recorded. Recording a plan neither grants permission to implement a discussed design nor introduces a new approval requirement for already-authorized work.",
	"Step titles are short action or noun phrases in the user's language (aim for at most 12 Chinese characters; keep necessary code identifiers). Put module names, file paths, commands, and implementation explanations in optional detail rather than title prefixes or parentheses. Keep step IDs stable. Update currentStepId and completedStepIds as work proceeds. When adding, removing, merging, reordering, or renaming steps, supply changeSummary explaining the change.",
].join("\n");

const parameters = Type.Object({
	title: Type.String({ description: "Short task outcome", minLength: 1, maxLength: 80 }),
	completionCriteria: Type.String({ description: "One sentence defining when the task is complete", minLength: 1, maxLength: 240 }),
	changeSummary: Type.Optional(Type.String({ description: "One-line explanation required when changing the outline", maxLength: 240 })),
	steps: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), detail: Type.Optional(Type.String({ maxLength: 500 })) }), { description: "Ordered task steps; 3–7 recommended, adapt to the actual work", minItems: 1, maxItems: 16 }),
	currentStepId: Type.Optional(Type.String()),
	completedStepIds: Type.Optional(Type.Array(Type.String())),
});

/** Revisions persist in the transcript; local state validates consecutive calls in this task. */
export function makeTaskPlanTool(): ToolDefinition<typeof parameters> {
	let revision = 0;
	let previousOutline: string | undefined;
	let previousTask: string | undefined;
	return {
		name: "task_plan",
		label: "Task plan",
		description: TASK_PLAN_GUIDANCE,
		parameters,
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const task = ctx.sessionManager?.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")?.id;
			if (task !== previousTask) { previousOutline = undefined; revision = 0; previousTask = task; }
			const ids = params.steps.map((step) => step.id.trim());
			if (new Set(ids).size !== ids.length || ids.some((id) => !id)) throw new Error("Plan step ids must be unique and nonempty");
			if (params.steps.some((step) => !step.title.trim() || step.title.length > 80)) throw new Error("Plan step titles must be 1–80 characters");
			if (params.currentStepId && !ids.includes(params.currentStepId)) throw new Error("currentStepId must name a plan step");
			if (params.completedStepIds?.some((id) => !ids.includes(id))) throw new Error("completedStepIds must name plan steps");
			if (params.steps.length < 1 || params.steps.length > 16) throw new Error("Plan must contain 1–16 steps");
			if (!params.title.trim() || !params.completionCriteria.trim()) throw new Error("Plan title and completionCriteria are required");
			if (params.currentStepId && params.completedStepIds?.includes(params.currentStepId)) throw new Error("currentStepId cannot already be completed");
			const outline = JSON.stringify(params.steps.map((step) => [step.id.trim(), step.title.trim()]));
			if (previousOutline && previousOutline !== outline && !params.changeSummary?.trim()) throw new Error("Explain outline changes in changeSummary");
			previousOutline = outline;
			revision++;
			return { content: [{ type: "text", text: `Plan revision ${revision} recorded: ${params.steps.length} steps.` }], details: undefined };
		},
	};
}
