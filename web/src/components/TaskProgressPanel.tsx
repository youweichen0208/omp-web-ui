import { useEffect, useRef, useState } from "react";
import { FiChevronRight, FiMoreHorizontal } from "react-icons/fi";
import type { ServerMessage, TaskProgress, UiMessage } from "../types";
import { useT } from "../i18n";
import { progressPhases, progressResult, plainTitle, type ProgressPhase } from "../task-progress-view";

type Silence = Extract<ServerMessage, { type: "agent_silence" }> | null;
const duration = (seconds: number, underSecond: string) => seconds < 1 ? underSecond : seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function TaskProgressPanel({ task, silence, cwd, messages, conversationTitle, onPreview, onViewChanges }: { task: TaskProgress; silence: Silence; cwd: string; messages: UiMessage[]; conversationTitle: string; onPreview: (path: string, name: string) => void; onViewChanges: (hash?: string) => void }) {
	const t = useT();
	const [expanded, setExpanded] = useState<string | null>(null);
	const [showProcess, setShowProcess] = useState(task.status === "running");
	const [showRaw, setShowRaw] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const [hoveredTool, setHoveredTool] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	useEffect(() => { setExpanded(null); setShowRaw(false); setShowProcess(task.status === "running"); }, [task.id]);
	useEffect(() => { if (task.status !== "running" && !task.plan) setShowProcess(false); }, [task.status, !!task.plan]);
	useEffect(() => {
		if (!menuOpen) return;
		const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
		const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
		document.addEventListener("pointerdown", outside, true);
		document.addEventListener("keydown", escape);
		return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
	}, [menuOpen]);
	useEffect(() => { const handler = (event: Event) => setHoveredTool((event as CustomEvent<{ toolCallId?: string | null }>).detail?.toolCallId ?? null); window.addEventListener("pi:tool-hover", handler); return () => window.removeEventListener("pi:tool-hover", handler); }, []);
	useEffect(() => { if (task.status !== "running") return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [task.status]);
	const phases = progressPhases(task);
	const result = progressResult(task, messages);
	const finishedAt = task.status === "running" ? now : task.endedAt ?? Math.max(task.startedAt, ...task.steps.map((step) => step.endedAt ?? step.startedAt));
	const elapsed = task.startedAt > 0 ? Math.max(0, Math.floor((finishedAt - task.startedAt) / 1000)) : 0;
	const planItems = task.plan?.items.filter((item) => item.status !== "removed") ?? [];
	const completed = task.plan ? planItems.filter((item) => item.status === "done").length : phases.filter((phase) => phase.status === "done").length;
	const single = !task.plan && phases.length === 1;
	const total = task.plan ? planItems.length : phases.length;
	const percent = total ? completed / total * 100 : 0;
	const finalMessage = messages.slice(messages.findIndex((message) => message.id === task.sourceMessageId) + 1).findLast((message) => message.role === "assistant" && message.content.some((part) => part.type === "text"));
	const jump = (messageId: string) => window.dispatchEvent(new CustomEvent("pi:jump-message", { detail: { messageId } }));
	const statusLabel = silence?.conversationId === task.conversationId ? silence.activity === "tool" ? t("taskLongTool") : t("taskWaitingModel") : task.status === "running" ? t("working") : task.status === "cancelled" ? t("taskCancelled") : task.status === "failed" ? t("error") : t("done");
	const hasResult = task.status !== "running" && !single && !!(result.commit || result.tests || result.changes);
	const finalTestPhase = phases.findLast((phase) => phase.kind === "test" || phase.kind === "fix")?.id;
	const title = plainTitle(task.title);
	const showTitle = title !== plainTitle(conversationTitle);
	const preview = (path: string) => { const relative = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path; onPreview(relative, relative.split("/").at(-1) ?? relative); };
	const activeArtifact = task.steps.findLast((step) => step.status === "running" && step.artifacts.length)?.artifacts.at(-1)?.label;
	const copyMarkdown = () => {
		const lines = [`# ${title}`, `${statusLabel} · ${completed} ${t(task.plan ? "taskPlanSteps" : "taskPhases")} · ${t("taskDuration")} ${duration(elapsed, t("taskUnderSecond"))}`, ...(task.plan ? task.plan.items.map((item) => `- ${item.status === "done" ? "[x]" : "[ ]"} ${item.title}`) : phases.flatMap((phase) => [`## ${phase.title}`, ...phase.steps.flatMap((step) => step.artifacts.map((item) => `- ${item.kind}: ${item.label}`))]))];
		void navigator.clipboard.writeText(lines.join("\n"));
		setMenuOpen(false);
	};
	useEffect(() => { if (task.status !== "running" && (!hasResult || !!task.plan)) setShowProcess(true); }, [task.status, hasResult, !!task.plan]);
	return <div className="task-progress" aria-label={t("taskProgress")}>
		<div className="task-progress-head">
			<div className="task-progress-heading">
				{showTitle && <strong title={title}>{title}</strong>}
				<div className="task-progress-menu" ref={menuRef}>
					<button type="button" className="task-progress-menu-trigger" aria-label={t("more")} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><FiMoreHorizontal /></button>
					{menuOpen && <div className="task-progress-menu-list">
						{hasResult && <button type="button" onClick={() => { setShowProcess((value) => !value); setMenuOpen(false); }}>{t(showProcess ? "taskOnlyResult" : "taskShowProcess")}</button>}
						{!single && !task.plan && <button type="button" onClick={() => { setShowRaw((value) => !value); setShowProcess(true); setMenuOpen(false); }}>{t(showRaw ? "taskHideRaw" : "taskShowRaw", { n: task.steps.length })}</button>}
						<button type="button" onClick={copyMarkdown}>{t("taskCopyMarkdown")}</button>
					</div>}
				</div>
			</div>
			<div className="task-progress-meta"><span className={`task-progress-status ${task.status}`}>● {single && `${t("taskProgress")} · `}{statusLabel}</span>{task.plan && task.status === "running" ? <span>· {t("taskPlanPosition", { current: Math.min(completed + 1, total), total })}</span> : !single && <span>· {completed} {t(task.plan ? "taskPlanSteps" : "taskPhases")}</span>}<span>· {t("taskDuration")} {duration(elapsed, t("taskUnderSecond"))}</span><small title={t(task.plan ? "taskExplicitPlan" : "taskInferred")}>{t(task.plan ? "taskExplicitPlan" : "taskInferred")}</small></div>
			{!single && <div className="task-progress-track" aria-hidden="true"><span className={task.status} style={{ width: `${percent}%` }} /></div>}
		</div>
		{hasResult && <div className="task-result"><div className="task-result-label">{t("taskResult")}</div>{result.commit && <div className="task-result-row"><span>{t("taskCommit")}</span><code>{result.commit.hash}</code>{result.commit.subject && <span className="task-result-subject">{plainTitle(result.commit.subject)}</span>}</div>}{result.tests && <div className="task-result-row"><span>{t("taskTests")}</span><strong className="success">{result.tests.passed} / {result.tests.total} {t("taskPassed")}</strong></div>}{result.changes && <div className="task-result-row"><span>{t("taskChanges")}</span><strong className="success">+{result.changes.added}</strong><strong className="removed">−{result.changes.deleted}</strong><span>· {result.changes.files} {t("taskFiles")}</span></div>}<div className="task-result-actions"><button type="button" onClick={() => onViewChanges(result.commit?.hash)}>{t("taskViewChanges")}</button>{finalMessage && <button type="button" onClick={() => jump(finalMessage.id)}>{t("taskFinalReply")}</button>}</div></div>}
		{task.plan && (task.plan.added > 0 || task.plan.removed > 0) && <div className="task-plan-change">{t("taskPlanChanged")} · {task.plan.added > 0 && `+${task.plan.added} ${t("taskPlanSteps")}`}{task.plan.added > 0 && task.plan.removed > 0 && " · "}{task.plan.removed > 0 && `−${task.plan.removed} ${t("taskPlanSteps")}`}</div>}
		{single ? <div className="task-single-actions">{phases[0].steps.flatMap((step) => step.artifacts.map((item) => <ArtifactRow key={item.toolCallId} item={item} onPreview={preview} onJump={() => jump(step.messageId)} />))}</div> : task.plan && showProcess ? <div className="task-plan-list">{task.plan.items.map((item, index) => <PlanStepRow key={item.id} item={item} index={index} now={now} activeArtifact={activeArtifact} />)}</div> : showProcess && <div className="task-progress-list">{phases.map((phase) => <PhaseRow key={phase.id} phase={phase} showRaw={showRaw} testResult={phase.id === finalTestPhase ? result.tests : undefined} linked={!!hoveredTool && phase.steps.some((step) => step.artifacts.some((item) => item.toolCallId === hoveredTool))} stalled={!!silence && phase.status === "running"} open={expanded === phase.id} onToggle={() => setExpanded((value) => value === phase.id ? null : phase.id)} onJump={jump} onPreview={preview} />)}</div>}
	</div>;
}

function PlanStepRow({ item, index, now, activeArtifact }: { item: NonNullable<TaskProgress["plan"]>["items"][number]; index: number; now: number; activeArtifact?: string }) {
	const t = useT();
	const actions = item.actions ? [[item.actions.read, t("taskReadCount", { n: item.actions.read })], [item.actions.write, t("taskWriteCount", { n: item.actions.write })], [item.actions.edit, t("taskEditCount", { n: item.actions.edit })], [item.actions.command, t("taskCommandCount", { n: item.actions.command })]].filter(([count]) => Number(count) > 0).map(([, label]) => label).join(" · ") : "";
	return <div className={`task-plan-step ${item.status}`}>
		<span className="task-plan-mark">{item.status === "done" ? "✓" : item.status === "running" ? "●" : item.status === "removed" ? "−" : index + 1}</span>
		<div><span>{item.title}</span>{item.added && <small className="task-plan-added">{t("taskPlanAdded")}</small>}{actions && <small className="task-plan-actions">{actions}</small>}{item.status === "running" && activeArtifact && <small className="task-plan-current-file">{activeArtifact}</small>}</div>
		{item.startedAt && item.status !== "removed" && <small className="task-plan-step-duration">{duration(Math.max(0, Math.floor(((item.endedAt ?? now) - item.startedAt) / 1000)), t("taskUnderSecond"))}</small>}
	</div>;
}

function ArtifactRow({ item, onPreview, onJump }: { item: ProgressPhase["steps"][number]["artifacts"][number]; onPreview: (path: string) => void; onJump: () => void }) {
	const t = useT();
	const action = item.kind === "read" ? t("taskArtifactRead") : item.kind === "write" ? t("taskArtifactWrite") : item.kind === "edit" ? t("taskArtifactEdit") : item.kind === "bash" ? t("taskArtifactRun") : item.kind;
	return <div className="task-artifact-row"><span>{action}</span>{item.path ? <button type="button" title={item.path} onClick={() => onPreview(item.path!)}><code>{item.label}</code></button> : <button type="button" title={item.label} onClick={onJump}><code>{item.label}</code></button>}{item.outputLines && <small>· {item.outputLines} {t("taskLines")}</small>}</div>;
}

function PhaseRow({ phase, showRaw, testResult, linked, stalled, open, onToggle, onJump, onPreview }: { phase: ProgressPhase; showRaw: boolean; testResult?: { passed: number; total: number }; linked: boolean; stalled: boolean; open: boolean; onToggle: () => void; onJump: (messageId: string) => void; onPreview: (path: string) => void }) {
	const t = useT();
	const counts = phase.counts;
	const summary = [[counts.read, t("taskReadCount", { n: counts.read })], [counts.write, t("taskWriteCount", { n: counts.write })], [counts.edit, t("taskEditCount", { n: counts.edit })], [counts.command, t("taskCommandCount", { n: counts.command })]].filter(([count]) => Number(count) > 0).map(([, label]) => label).join(" · ");
	const seconds = phase.endedAt && phase.startedAt ? Math.max(0, Math.floor((phase.endedAt - phase.startedAt) / 1000)) : null;
	return <div className={`task-step ${stalled ? "stalled" : phase.status}${linked ? " linked" : ""}`}><button type="button" className="task-step-head" aria-expanded={open || showRaw} onClick={onToggle}><span className="task-step-mark" aria-hidden="true">{phase.status === "done" ? "✓" : phase.status === "failed" ? "×" : "●"}</span><span className="task-step-main"><span className="task-step-title">{phase.title}</span>{(summary || testResult) && <small>{testResult && <span className="success">{testResult.passed} / {testResult.total} {t("taskPassed")}</span>}{testResult && summary ? " · " : ""}{summary}</small>}</span><span className="task-step-duration">{seconds === null ? "" : duration(seconds, t("taskUnderSecond"))}</span><FiChevronRight className={open || showRaw ? "open" : ""} /></button>{(open || showRaw) && <div className="task-step-detail">{phase.steps.map((step) => <div className="task-raw-step" key={step.id}><div className="task-raw-summary">{plainTitle(step.title).slice(0, 24)}</div>{step.artifacts.map((artifact) => <ArtifactRow key={artifact.toolCallId} item={artifact} onPreview={onPreview} onJump={() => onJump(step.messageId)} />)}<button type="button" className="task-step-jump" onClick={() => onJump(step.messageId)}>{t("taskJumpToChat")} →</button></div>)}</div>}</div>;
}
