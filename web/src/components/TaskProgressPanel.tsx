import { useEffect, useState } from "react";
import { FiChevronRight } from "react-icons/fi";
import type { ServerMessage, TaskProgress, UiMessage } from "../types";
import { useT } from "../i18n";
import { progressPhases, progressResult, plainTitle, type ProgressPhase } from "../task-progress-view";
import { MarkdownBody } from "./Markdown";

type Silence = Extract<ServerMessage, { type: "agent_silence" }> | null;
const duration = (seconds: number) => seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function TaskProgressPanel({ task, silence, cwd, messages, onPreview, onViewChanges }: { task: TaskProgress; silence: Silence; cwd: string; messages: UiMessage[]; onPreview: (path: string, name: string) => void; onViewChanges: (hash?: string) => void }) {
	const t = useT();
	const [expanded, setExpanded] = useState<string | null>(null);
	const [showProcess, setShowProcess] = useState(task.status === "running");
	const [hoveredTool, setHoveredTool] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	useEffect(() => { setExpanded(null); setShowProcess(task.status === "running"); }, [task.id]);
	useEffect(() => { if (task.status !== "running") setShowProcess(false); }, [task.status]);
	useEffect(() => { const handler = (event: Event) => setHoveredTool((event as CustomEvent<{ toolCallId?: string | null }>).detail?.toolCallId ?? null); window.addEventListener("pi:tool-hover", handler); return () => window.removeEventListener("pi:tool-hover", handler); }, []);
	useEffect(() => { if (task.status !== "running") return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [task.status]);
	const phases = progressPhases(task);
	const result = progressResult(task, messages);
	const finishedAt = task.status === "running" ? now : Math.max(task.startedAt, ...task.steps.map((step) => step.endedAt ?? step.startedAt));
	const elapsed = task.startedAt > 0 ? Math.max(0, Math.floor((finishedAt - task.startedAt) / 1000)) : 0;
	const completed = phases.filter((phase) => phase.status === "done").length;
	const percent = phases.length ? completed / phases.length * 100 : 0;
	const finalMessage = messages.slice(messages.findIndex((message) => message.id === task.sourceMessageId) + 1).findLast((message) => message.role === "assistant" && message.content.some((part) => part.type === "text"));
	const jump = (messageId: string) => window.dispatchEvent(new CustomEvent("pi:jump-message", { detail: { messageId } }));
	const statusLabel = silence?.conversationId === task.conversationId ? silence.activity === "tool" ? t("taskLongTool") : t("taskWaitingModel") : task.status === "running" ? t("working") : task.status === "cancelled" ? t("taskCancelled") : task.status === "failed" ? t("error") : t("done");
	const hasResult = !!(result.commit || result.tests || result.changes);
	const finalTestPhase = phases.findLast((phase) => phase.kind === "test" || phase.kind === "fix")?.id;
	return <div className="task-progress" aria-label={t("taskProgress")}>
		<div className="task-progress-head"><strong title={plainTitle(task.title)}>{plainTitle(task.title)}</strong><div className="task-progress-meta"><span className={`task-progress-status ${task.status}`}>● {statusLabel}</span><span>· {completed} {t("taskPhases")}</span><span>· {t("taskDuration")} {duration(elapsed)}</span><small title={t("taskInferred")}>{t("taskInferred")}</small></div><div className="task-progress-track" aria-hidden="true"><span className={task.status} style={{ width: `${percent}%` }} /></div></div>
		{hasResult && <div className="task-result"><div className="task-result-label">{t("taskResult")}</div>{result.commit && <div className="task-result-row"><span>{t("taskCommit")}</span><code>{result.commit.hash}</code>{result.commit.subject && <span className="task-result-subject">{plainTitle(result.commit.subject)}</span>}</div>}{result.tests && <div className="task-result-row"><span>{t("taskTests")}</span><strong className="success">{result.tests.passed} / {result.tests.total} {t("taskPassed")}</strong></div>}{result.changes && <div className="task-result-row"><span>{t("taskChanges")}</span><strong className="success">+{result.changes.added}</strong><strong className="removed">−{result.changes.deleted}</strong><span>· {result.changes.files} {t("taskFiles")}</span></div>}<div className="task-result-actions"><button type="button" onClick={() => onViewChanges(result.commit?.hash)}>{t("taskViewChanges")}</button>{finalMessage && <button type="button" onClick={() => jump(finalMessage.id)}>{t("taskFinalReply")}</button>}</div></div>}
		<div className="task-process"><button type="button" className="task-process-toggle" aria-expanded={showProcess} onClick={() => setShowProcess((value) => !value)}><FiChevronRight className={showProcess ? "open" : ""} />{t("taskProcess")} · {phases.length} {t("taskPhases")}<span>{showProcess ? t("taskOnlyResult") : t("taskShowProcess")} · {t("taskRawSteps", { n: task.steps.length })}</span></button></div>
		{showProcess && <div className="task-progress-list">{phases.map((phase) => <PhaseRow key={phase.id} phase={phase} testResult={phase.id === finalTestPhase ? result.tests : undefined} linked={!!hoveredTool && phase.steps.some((step) => step.artifacts.some((item) => item.toolCallId === hoveredTool))} stalled={!!silence && phase.status === "running"} open={expanded === phase.id} onToggle={() => setExpanded((value) => value === phase.id ? null : phase.id)} onJump={jump} onPreview={(path) => { const relative = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path; onPreview(relative, relative.split("/").at(-1) ?? relative); }} />)}</div>}
	</div>;
}

function PhaseRow({ phase, testResult, linked, stalled, open, onToggle, onJump, onPreview }: { phase: ProgressPhase; testResult?: { passed: number; total: number }; linked: boolean; stalled: boolean; open: boolean; onToggle: () => void; onJump: (messageId: string) => void; onPreview: (path: string) => void }) {
	const t = useT();
	const counts = phase.counts;
	const summary = [[counts.read, t("taskReadCount", { n: counts.read })], [counts.write, t("taskWriteCount", { n: counts.write })], [counts.edit, t("taskEditCount", { n: counts.edit })], [counts.command, t("taskCommandCount", { n: counts.command })]].filter(([count]) => Number(count) > 0).map(([, label]) => label).join(" · ");
	const seconds = phase.endedAt && phase.startedAt ? Math.max(0, Math.floor((phase.endedAt - phase.startedAt) / 1000)) : null;
	return <div className={`task-step ${stalled ? "stalled" : phase.status}${linked ? " linked" : ""}`}><button type="button" className="task-step-head" aria-expanded={open} onClick={onToggle}><span className="task-step-mark" aria-hidden="true">{phase.status === "done" ? "✓" : phase.status === "failed" ? "×" : "●"}</span><span className="task-step-main"><span className="task-step-title">{phase.title}</span>{(summary || testResult) && <small>{testResult && <span className="success">{testResult.passed} / {testResult.total} {t("taskPassed")}</span>}{testResult && summary ? " · " : ""}{summary}</small>}</span><span className="task-step-duration">{seconds === null ? "" : duration(seconds)}</span><FiChevronRight className={open ? "open" : ""} /></button>{open && <div className="task-step-detail">{phase.steps.map((step) => <div className="task-raw-step" key={step.id}><div className="task-raw-text"><MarkdownBody text={step.detail || step.title} /></div>{step.artifacts.map((artifact) => artifact.path ? <button type="button" className="task-artifact" key={artifact.toolCallId} title={artifact.path} onClick={() => onPreview(artifact.path!)}><span>{artifact.kind}</span><code>{artifact.label}</code></button> : <div className="task-artifact command" key={artifact.toolCallId}><span>{artifact.kind}</span><code title={artifact.label}>{artifact.label}</code></div>)}<button type="button" className="task-step-jump" onClick={() => onJump(step.messageId)}>{t("taskJumpToChat")} →</button></div>)}</div>}</div>;
}
