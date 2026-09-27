import { useEffect, useState } from "react";
import { FiChevronRight } from "react-icons/fi";
import type { ServerMessage, TaskProgress, TaskStep } from "../types";
import { useT } from "../i18n";

type Silence = Extract<ServerMessage, { type: "agent_silence" }> | null;

export function TaskProgressPanel({ task, silence, cwd, onPreview }: { task: TaskProgress; silence: Silence; cwd: string; onPreview: (path: string, name: string) => void }) {
	const t = useT();
	const [expanded, setExpanded] = useState<string | null>(null);
	const [showCompleted, setShowCompleted] = useState(false);
	const [hoveredTool, setHoveredTool] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	useEffect(() => { setExpanded(null); setShowCompleted(false); }, [task.id]);
	useEffect(() => { const handler = (event: Event) => setHoveredTool((event as CustomEvent<{ toolCallId?: string | null }>).detail?.toolCallId ?? null); window.addEventListener("pi:tool-hover", handler); return () => window.removeEventListener("pi:tool-hover", handler); }, []);
	useEffect(() => { if (task.status !== "running") return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [task.status]);
	const finishedAt = task.status === "running" ? now : Math.max(task.startedAt, ...task.steps.map((step) => step.endedAt ?? step.startedAt));
	const elapsed = task.startedAt > 0 ? Math.max(0, Math.floor((finishedAt - task.startedAt) / 1000)) : 0;
	const duration = elapsed >= 3600 ? `${Math.floor(elapsed / 3600)}h ${Math.floor(elapsed % 3600 / 60)}m` : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
	const lastActive = task.steps.findLastIndex((step) => step.status === "running");
	const completedCount = task.steps.filter((step) => step.status === "done").length;
	const recentStart = lastActive >= 0 ? Math.max(0, lastActive - 2) : Math.max(0, task.steps.length - 3);
	const visible = task.steps.map((step, index) => ({ step, index })).filter(({ step, index }) => showCompleted || step.status !== "done" || completedCount <= 5 || index >= recentStart);
	const hidden = task.steps.length - visible.length;
	const jump = (messageId: string) => window.dispatchEvent(new CustomEvent("pi:jump-message", { detail: { messageId } }));
	const statusLabel = silence?.conversationId === task.conversationId ? silence.activity === "tool" ? t("taskLongTool") : t("taskWaitingModel") : task.status === "running" ? t("working") : task.status === "cancelled" ? t("taskCancelled") : task.status === "failed" ? t("error") : t("done");
	return <div className="task-progress" aria-label={t("taskProgress")}>
		<div className="task-progress-head"><span className="task-progress-eyebrow">{t("taskProgress")} <small>{t("taskInferred")}</small></span><strong title={task.title}>{task.title}</strong><span className="task-progress-meta">{task.completed}/{task.steps.length} {t("taskSteps")} · {duration} · {statusLabel}</span><div className="task-progress-track" aria-hidden="true">{task.steps.map((step, index) => <span key={step.id} className={silence && index === lastActive ? "stalled" : step.status} />)}</div></div>
		<div className="task-progress-list">{hidden > 0 && <button type="button" className="task-completed-toggle" onClick={() => setShowCompleted(true)}>{t("taskCompletedHidden", { n: hidden })}</button>}{visible.map(({ step, index }) => <TaskStepRow key={step.id} step={step} index={index} current={index === lastActive} linked={!!hoveredTool && step.artifacts.some((item) => item.toolCallId === hoveredTool)} stalled={!!silence && index === lastActive} open={expanded === step.id} onToggle={() => setExpanded((value) => value === step.id ? null : step.id)} onJump={() => jump(step.messageId)} onPreview={(path) => { const relative = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path; onPreview(relative, relative.split("/").at(-1) ?? relative); }} />)}{showCompleted && hidden === 0 && task.steps.length > 5 && <button type="button" className="task-completed-toggle" onClick={() => setShowCompleted(false)}>{t("collapseCode")}</button>}</div>
	</div>;
}

function TaskStepRow({ step, index, current, linked, stalled, open, onToggle, onJump, onPreview }: { step: TaskStep; index: number; current: boolean; linked: boolean; stalled: boolean; open: boolean; onToggle: () => void; onJump: () => void; onPreview: (path: string) => void }) {
	const t = useT();
	const status = stalled ? "stalled" : step.status;
	return <div className={`task-step ${status}${current ? " current" : ""}${linked ? " linked" : ""}`}>
		<button type="button" className="task-step-head" aria-expanded={open} onClick={onToggle}><span className="task-step-mark" aria-hidden="true">{status === "done" ? "✓" : status === "failed" ? "×" : status === "stalled" ? "!" : status === "running" ? "●" : "○"}</span><span className="task-step-main"><span className="task-step-title" title={step.title}>{step.title}</span>{stalled ? <small>{t("taskStepSilent")}</small> : step.hint && <small>{step.hint}</small>}</span><span className="task-step-order">{index + 1}</span><FiChevronRight className={open ? "open" : ""} /></button>
		{open && <div className="task-step-detail">{step.artifacts.map((artifact) => artifact.path ? <button type="button" className="task-artifact" key={artifact.toolCallId} title={artifact.path} onClick={() => onPreview(artifact.path!)}><span>{artifact.kind}</span><code>{artifact.label}</code></button> : <div className="task-artifact command" key={artifact.toolCallId}><span>{artifact.kind}</span><code title={artifact.label}>{artifact.label}</code></div>)}<button type="button" className="task-step-jump" onClick={onJump}>{t("taskJumpToChat")} →</button></div>}
	</div>;
}
