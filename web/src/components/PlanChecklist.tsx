import { useT, type Translate } from "../i18n";
import type { PlanChange } from "../types";
import type { PlanPresentation } from "../plan-presentation";
function changeLabel(change: PlanChange, t: Translate): string {
	if (change.kind === "replaced") return t("planReplaced", { id: change.planId, revision: change.revision });
	if (change.kind === "status") return t("planStatusChanged", { status: t(change.status === "active" ? "running" : change.status === "completed" ? "done" : change.status === "failed" ? "error" : "cancelled") });
	const keys = { added: "todoItemAdded", updated: "todoItemUpdated", pending: "todoItemPending", started: "todoItemStarted", completed: "todoItemCompleted", removed: "todoItemDeleted" } as const;
	return change.position ? t(keys[change.kind], { n: change.position }) : `${t("todoRemoved")}: ${change.title}`;
}
export function PlanChecklist({ view, toolCallId }: { view: PlanPresentation; toolCallId: string }) {
	const t = useT();
	const changes = view.changes.map(change => changeLabel(change, t)).join(t("todoChangeSeparator"));
	if (view.kind === "update") return <div className="todo-update" data-tool-call-id={toolCallId}>
		<span className="todo-update-dot" aria-hidden="true" /><span>{changes || t("planRecorded")}</span>
		<button type="button" onClick={() => window.dispatchEvent(new CustomEvent("pi:jump-tool", { detail: { ...view.target, todoItemIds: view.changes.flatMap(change => "stepId" in change ? [change.stepId] : []) } }))}>{t("todoView")}</button>
	</div>;
	const plan = view.snapshot;
	return <section className="todo-checklist" data-tool-call-id={toolCallId} aria-label={t("taskPlanSource")}>
		<header className="todo-checklist-head"><strong>{plan.title}</strong><span>{t("todoCounts", { total: plan.steps.length, completed: plan.completedStepIds.length })}</span><span className="todo-checklist-state">{t(plan.status === "active" ? "planActive" : plan.status === "completed" ? "done" : plan.status === "failed" ? "error" : "cancelled")}</span></header>
		<ol className="todo-checklist-items">{plan.steps.map(step => {
			const status = plan.completedStepIds.includes(step.id) ? "completed" : plan.currentStepId === step.id ? "in_progress" : "pending";
			return <li key={step.id} className={`todo-checklist-item ${status}`} data-todo-item-id={step.id} tabIndex={-1}><span className="todo-checklist-mark" aria-hidden="true">{status === "completed" ? "✓" : ""}</span><div>{step.detail ? <details><summary>{step.title}</summary><p>{step.detail}</p></details> : step.title}</div></li>;
		})}</ol>
		<p className="task-outline-criteria">{t("taskCompletionCriteria")}：{plan.completionCriteria}</p>
		{changes && <p className="todo-update">{changes}</p>}
	</section>;
}
