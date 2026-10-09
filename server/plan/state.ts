import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PlanSnapshot, PlanState, PlanChange } from "../protocol.js";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function text(v: unknown, name: string, max: number): string {
	if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${name} must be non-empty and at most ${max} characters`);
	return v;
}
export function editableState(value: unknown): PlanState {
	if (!object(value)) throw new Error("Submit a complete plan object");
	const title = text(value.title, "title", 80), completionCriteria = text(value.completionCriteria, "completionCriteria", 240);
	if (!["active", "completed", "cancelled", "failed"].includes(String(value.status))) throw new Error("Invalid plan status");
	if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 16) throw new Error("steps must contain 1–16 items");
	const steps = value.steps.map(step => {
		if (!object(step)) throw new Error("Invalid step");
		return { id: text(step.id, "step.id", 64), title: text(step.title, "step.title", 80), ...(step.detail !== undefined ? { detail: text(step.detail, "step.detail", 500) } : {}) };
	});
	const ids = new Set(steps.map(step => step.id));
	if (ids.size !== steps.length) throw new Error("Step IDs must be unique");
	if (!Array.isArray(value.completedStepIds) || value.completedStepIds.some(id => typeof id !== "string" || !ids.has(id)) || new Set(value.completedStepIds).size !== value.completedStepIds.length) throw new Error("completedStepIds must be unique existing step IDs");
	const completedStepIds = value.completedStepIds as string[];
	if (value.currentStepId !== null && (typeof value.currentStepId !== "string" || !ids.has(value.currentStepId) || completedStepIds.includes(value.currentStepId))) throw new Error("currentStepId must be null or an incomplete existing step ID");
	if (value.status !== "active" && value.currentStepId !== null) throw new Error("Terminal plans must have currentStepId: null");
	if (value.status === "completed" && completedStepIds.length !== steps.length) throw new Error("Completed plans must complete every step");
	return { title, completionCriteria, status: value.status as PlanState["status"], steps, completedStepIds: [...completedStepIds], currentStepId: value.currentStepId as string | null,
		...(value.changeSummary !== undefined ? { changeSummary: text(value.changeSummary, "changeSummary", 240) } : {}) };
}

export function changesBetween(before: PlanSnapshot | undefined, after: PlanState): PlanChange[] {
	const changes: PlanChange[] = [];
	for (const [index, step] of after.steps.entries()) {
		const oldIndex = before?.steps.findIndex(old => old.id === step.id) ?? -1;
		const old = before?.steps[oldIndex];
		if (!old) changes.push({ kind: "added", stepId: step.id, title: step.title, position: index + 1 });
		else if (old.title !== step.title || old.detail !== step.detail || oldIndex !== index) changes.push({ kind: "updated", stepId: step.id, title: step.title, position: index + 1 });
		if (after.completedStepIds.includes(step.id) && !before?.completedStepIds.includes(step.id)) changes.push({ kind: "completed", stepId: step.id, title: step.title, position: index + 1 });
		else if (after.currentStepId === step.id && before?.currentStepId !== step.id) changes.push({ kind: "started", stepId: step.id, title: step.title, position: index + 1 });
		else if (old && !after.completedStepIds.includes(step.id) && after.currentStepId !== step.id && (before?.completedStepIds.includes(step.id) || before?.currentStepId === step.id)) changes.push({ kind: "pending", stepId: step.id, title: step.title, position: index + 1 });
	}
	for (const step of before?.steps ?? []) if (!after.steps.some(next => next.id === step.id)) changes.push({ kind: "removed", stepId: step.id, title: step.title });
	if (before && before.status !== after.status) changes.push({ kind: "status", status: after.status });
	return changes;
}

/** Terminal command intent is atomic; persisted snapshots remain strictly validated. */
function commandState(value: Record<string, unknown>): PlanState {
	if (!["completed", "cancelled", "failed"].includes(String(value.status))) return editableState(value);
	const state = editableState({ ...value, status: "active", currentStepId: null });
	if (value.currentStepId !== null && (typeof value.currentStepId !== "string" || !state.steps.some(step => step.id === value.currentStepId))) throw new Error("currentStepId must be null or an existing step ID");
	return { ...state, status: value.status as PlanState["status"],
		completedStepIds: value.status === "completed" ? state.steps.map(step => step.id) : state.completedStepIds };
}

export function transition(value: unknown, current?: PlanSnapshot, newId: () => string = randomUUID): PlanSnapshot {
	if (!object(value) || !["create", "update"].includes(String(value.action))) throw new Error("action must be create or update");
	if (value.action === "update") {
		const reason = !current ? "No plan exists on this branch" : current.status !== "active" ? "The latest plan has ended" : value.planId !== current.planId ? "planId does not match this branch's latest plan" : value.expectedRevision !== current.revision ? "expectedRevision is stale" : undefined;
		if (reason) throw new Error(`${reason}. ${!current || current.status !== "active" ? "Use create for a new plan." : "Use update with the current planId and expectedRevision and submit the full corrected plan."}\nCurrent editable state: ${current ? JSON.stringify({ action: current.status === "active" ? "update" : "create", planId: current.planId, expectedRevision: current.revision, ...editableState(current) }) : "none; use create"}`);
	}
	const state = commandState(value);
	const changes = changesBetween(value.action === "update" ? current : undefined, state);
	if (value.action === "create" && current?.status === "active") changes.unshift({ kind: "replaced", planId: current.planId, revision: current.revision, reason: "Replaced by a newly created plan" });
	return { schemaVersion: 3, planId: value.action === "create" ? newId() : current!.planId, revision: value.action === "create" ? 1 : current!.revision + 1, ...state, changes };
}

/** Validate and copy only known fields. Never forward arbitrary extension details. */
export function planSnapshot(value: unknown): PlanSnapshot | undefined {
	try {
		if (!object(value) || value.schemaVersion !== 3 || typeof value.planId !== "string" || !value.planId || value.planId.length > 128 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !Array.isArray(value.changes) || value.changes.length > 64) return;
		const state = editableState(value);
		const changes: PlanChange[] = value.changes.map(change => {
			if (!object(change)) throw new Error("Invalid change");
			if (change.kind === "replaced") {
				if (!Number.isSafeInteger(change.revision) || Number(change.revision) < 1) throw new Error("Invalid replacement revision");
				return { kind: "replaced", planId: text(change.planId, "planId", 128), revision: Number(change.revision), reason: text(change.reason, "reason", 240) };
			}
			if (change.kind === "status" && ["active", "completed", "cancelled", "failed"].includes(String(change.status))) return { kind: "status", status: change.status as PlanState["status"] };
			if (!["added", "updated", "removed", "completed", "started", "pending"].includes(String(change.kind))) throw new Error("Invalid change kind");
			if (change.position !== undefined && (!Number.isInteger(change.position) || Number(change.position) < 1 || Number(change.position) > 16)) throw new Error("Invalid position");
			return { kind: change.kind as "added", stepId: text(change.stepId, "stepId", 64), title: text(change.title, "title", 80), ...(change.position !== undefined ? { position: Number(change.position) } : {}) };
		});
		return { schemaVersion: 3, planId: value.planId, revision: Number(value.revision), ...state, changes };
	} catch { return; }
}
export function snapshotFromDetails(details: unknown): PlanSnapshot | undefined {
	return object(details) ? planSnapshot(details.planSnapshot) : undefined;
}
export function latestPlan(branch: readonly SessionEntry[]): { snapshot: PlanSnapshot; entryId: string; toolCallId: string } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "plan" || entry.message.isError) continue;
		const snapshot = snapshotFromDetails(entry.message.details);
		if (snapshot) return { snapshot, entryId: entry.id, toolCallId: entry.message.toolCallId };
	}
}
