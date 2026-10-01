import { useT, type Translate } from "../i18n";
import type { TodoChange, TodoPresentation } from "../todo-presentation";

function changeLabel(change: TodoChange, t: Translate): string {
	const keys = { added: "todoItemAdded", updated: "todoItemUpdated", pending: "todoItemPending", in_progress: "todoItemStarted", completed: "todoItemCompleted", deleted: "todoItemDeleted", blocked: "todoItemBlocked" } as const;
	return t(keys[change.kind], { n: change.position });
}

export function TodoChecklist({ view, toolCallId }: { view: TodoPresentation; toolCallId: string }) {
	const t = useT();
	if (view.kind === "hidden") return null;
	if (view.kind === "update") return <div className="todo-update" data-tool-call-id={toolCallId}>
		<span className="todo-update-dot" aria-hidden="true" />
		<span>{view.cleared ? t("todoCleared") : t("todoChanges", { changes: view.changes.map((change) => changeLabel(change, t)).join(t("todoChangeSeparator")) })}</span>
		{view.target && <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("pi:jump-tool", { detail: { ...view.target, todoItemIds: view.changes.map((change) => change.id) } }))}>{t("todoView")}</button>}
	</div>;
	const active = view.tasks.filter((task) => task.status !== "deleted");
	const completed = active.filter((task) => task.status === "completed").length;
	const status = active.some((task) => task.status === "in_progress") ? "running" : active.length > 0 && completed === active.length ? "done" : "todoCreated";
	return <section className="todo-checklist" data-tool-call-id={toolCallId} aria-label={t("taskPlanSource")}>
		<header className="todo-checklist-head"><strong>{t("taskPlanSource")}</strong><span>{t("todoCounts", { total: active.length, completed })}</span><span className="todo-checklist-state">{t(status)}</span></header>
		<ol className="todo-checklist-items">{view.tasks.map((task) => <li key={task.id} className={`todo-checklist-item ${task.status}`} data-todo-item-id={task.id} tabIndex={-1}>
			<span className="todo-checklist-mark" role="img" aria-label={t(task.status === "completed" ? "done" : task.status === "in_progress" ? "running" : task.status === "deleted" ? "todoRemoved" : "todoPending")}>{task.status === "completed" ? "✓" : task.status === "deleted" ? "−" : ""}</span>
			<span>{task.phase && <small className="todo-phase">{task.phase}</small>}{task.subject}{task.blocker && <small className="todo-blocker">{task.blocker}</small>}</span>
		</li>)}</ol>
	</section>;
}
