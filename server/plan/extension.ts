import { Type } from "typebox";
import type { ExtensionFactory, ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { editableState, latestPlan, snapshotFromDetails, transition } from "./state.js";

const string = (maxLength: number) => Type.String({ minLength: 1, maxLength });
export const planParameters = Type.Object({
	action: Type.Union([Type.Literal("create"), Type.Literal("update")]),
	planId: Type.Optional(string(128)), expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
	title: string(80), status: Type.Union([Type.Literal("active"), Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("failed")]),
	steps: Type.Array(Type.Object({ id: string(64), title: string(80), detail: Type.Optional(string(500)) }), { minItems: 1, maxItems: 16, description: "Required for BOTH create and update, including completion. Send every step with its id, title and detail; never omit unchanged steps." }),
	currentStepId: Type.Union([string(64), Type.Null()], { description: "Current step for active plans; terminal statuses clear it automatically." }), completedStepIds: Type.Array(string(64), { maxItems: 16, uniqueItems: true, description: "Completed step IDs. Explicit status completed completes all submitted steps; cancelled/failed preserve this list." }),
	completionCriteria: string(240), changeSummary: Type.Optional(string(240)),
});

export function restorePlanContext(messages: ContextEvent["messages"], branch: readonly SessionEntry[]): ContextEvent["messages"] {
	const latest = latestPlan(branch);
	if (!latest || latest.snapshot.status !== "active") return messages;
	const { snapshot, toolCallId } = latest;
	const visibleResult = messages.some(message => message.role === "toolResult" && message.toolName === "plan" && message.toolCallId === toolCallId && !message.isError && JSON.stringify(snapshotFromDetails(message.details)) === JSON.stringify(snapshot));
	const visibleCall = messages.some(message => message.role === "assistant" && message.content.some(block => {
		if (block.type !== "toolCall" || block.name !== "plan" || block.id !== toolCallId) return false;
		try {
			const args = block.arguments;
			const identity = args.action === "create" ? snapshot.revision === 1 : args.action === "update" && args.planId === snapshot.planId && args.expectedRevision === snapshot.revision - 1;
			return identity && JSON.stringify(editableState(args)) === JSON.stringify(editableState(snapshot));
		} catch { return false; }
	}));
	const lastUser = messages.findLastIndex(message => message.role === "user");
	const lastPlanResult = messages.slice(lastUser + 1).findLast(message => message.role === "toolResult" && message.toolName === "plan");
	const failedCall = lastPlanResult?.role === "toolResult" && lastPlanResult.isError;
	if (visibleResult && visibleCall && !failedCall) return messages;
	const content = `${failedCall ? "Plan call failed; the saved plan below is unchanged. To correct the call, submit the full state including steps, even if unchanged or marking completion. Use the saved planId and expectedRevision. This reminder does not authorize continuing work.\n" : ""}Historical plan background, not authorization to continue. Judge relevance to the current request yourself. For related, already authorized implementation, update this plan with its current identity and revision and continue without requesting separate plan approval. For unrelated multi-step work, create a new plan. Ordinary questions do not require a plan. Follow user/skill instructions and waiting requirements; this tool grants no extra permissions.\n${JSON.stringify({ action: "update", planId: snapshot.planId, expectedRevision: snapshot.revision, ...editableState(snapshot) })}`;
	const reminder: ContextEvent["messages"][number] = { role: "custom", customType: "pi-harness:plan-background", content, display: false, timestamp: 0 };
	const summary = messages.findLastIndex(message => message.role === "compactionSummary");
	const user = messages.findLastIndex(message => message.role === "user");
	let at = summary >= 0 ? summary + 1 : user >= 0 ? user : 0;
	// A user interruption may occur inside an outstanding call/result group.
	// Keep that entire group together when selecting the insertion boundary.
	const open = new Map<string, number>();
	for (let index = 0; index < at; index++) {
		const message = messages[index];
		if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") open.set(block.id, index);
		if (message.role === "toolResult") open.delete(message.toolCallId);
	}
	if (open.size) at = Math.min(at, ...open.values());
	return [...messages.slice(0, at), reminder, ...messages.slice(at)];
}

export const createPlanExtension = (): ExtensionFactory => pi => {
	pi.registerTool({
		name: "plan", label: "Plan", description: "Create or update a complete, versioned implementation plan on this session branch. Every call requires title, status, steps, currentStepId, completedStepIds and completionCriteria, even when completing or only changing status. Updates also require the latest planId and expectedRevision. This is full replacement, not a partial patch. Explicit completed status completes all submitted steps and clears currentStepId; cancelled/failed only clear currentStepId. Ended plans require create.",
		exposure: "model-only", executionMode: "sequential", defaultActive: false,
		annotations: { readOnlyHint: true, openWorldHint: false },
		promptSnippet: "Record and update a multi-step implementation plan.",
		promptGuidelines: ["For multi-step implementation, create or update a relevant plan before execution and update the current step before starting it. For already authorized work, proceed without requesting separate plan approval. Submit the full state each time. Wait for create to return its identity before updating. Follow user and skill instructions, including waiting; a plan does not grant authorization. Ordinary questions need no plan. When work is merged into another step or becomes unnecessary, update or remove the superseded step and explain the change instead of leaving a stale pending item. Never mark unfinished work completed. Mark completion explicitly; never infer it from a stopped run."],
		parameters: planParameters,
		async execute(_id, args, _signal, _update, ctx) {
			const snapshot = transition(args, latestPlan(ctx.sessionManager.getBranch())?.snapshot);
			return { content: [{ type: "text", text: `Plan ${snapshot.planId}, revision ${snapshot.revision}: ${snapshot.status}.` }], details: { planSnapshot: snapshot } };
		},
	});
	pi.on("context", (event, ctx) => {
		if (!pi.getActiveTools().includes("plan") || !["builtin:pi-harness-plan", "<inline:pi-harness-plan>"].includes(pi.getAllTools().find(tool => tool.name === "plan")?.sourceInfo.path ?? "")) return;
		return { messages: restorePlanContext(event.messages, ctx.sessionManager.getBranch()) };
	});
};
