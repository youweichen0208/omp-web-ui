import { latestToolTextFailure } from "../tool-text";
import { conversationWait } from "../waiting-indicator";
import { useEffect, useRef, useState } from "react";
import { FiChevronRight, FiFile } from "react-icons/fi";
import type { ServerMessage, TaskProgress, UiMessage } from "../types";
import { useT } from "../i18n";
import { planStepArtifacts } from "../task-progress-view";
import { taskOutputs } from "../task-outputs";

type Silence = Extract<ServerMessage, { type: "agent_silence" }> | null;

export function TaskProgressPanel({ task, silence, cwd, messages, onPreview }: { task?: TaskProgress | null; silence: Silence; cwd: string; messages: UiMessage[]; onPreview: (path: string, name: string) => void }) {
	const t = useT();
	const interrupted = !!latestToolTextFailure(messages, task?.status === "running");
	const phase = conversationWait(messages, new Map());
	const [progressOpen, setProgressOpen] = useState(true);
	const [outputsOpen, setOutputsOpen] = useState(true);
	const [expanded, setExpanded] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const items = task?.plan?.items.filter(item => item.status !== "removed") ?? [];
	const currentId = items.find(item => item.status === "running")?.id;
	useEffect(() => {
		if (!progressOpen || !currentId) return;
		const scroller = scrollRef.current;
		const active = scroller?.querySelector<HTMLElement>(".task-plan-step.running");
		if (!scroller || !active) return;
		const top = active.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
		scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3);
	}, [currentId, task?.id, progressOpen]);
	const preview = (path: string) => {
		const relative = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
		onPreview(relative, relative.replace(/\\/g, "/").split("/").at(-1) ?? relative);
	};
	const files = taskOutputs(task, messages, cwd);
	const planMessage = messages.find(message => message.role === "toolResult" && message.planSnapshot?.planId === task?.plan?.origin);
	const planSource = planMessage && messages.find(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.id === planMessage.toolCallId));
	const status = interrupted ? t("toolRecoveryInterrupted") : task?.status === "failed" ? t("taskFailed") : task?.status === "cancelled" ? t("taskCancelled") : task?.plan?.awaitingConfirmation ? t("planPrevious") : task?.status === "waiting" ? t("taskPaused") : silence && task && silence.conversationId === task.conversationId ? t(phase?.label ?? "working") : "";
	return <div className={`task-progress task-sections ${interrupted ? "interrupted" : task?.status ?? "empty"}`} tabIndex={-1} aria-label={t("taskProgress")}>
		<div className="task-sections-scroll" ref={scrollRef}>
			<section className="task-section">
				<button type="button" className="task-section-heading" aria-expanded={progressOpen} onClick={() => setProgressOpen(value => !value)}><FiChevronRight className={progressOpen ? "open" : ""} />{t("taskProgressHeading")}</button>
				{progressOpen && <div className="task-section-content">
					{status && <p className={`task-progress-status task-progress-source ${interrupted ? "interrupted" : task?.status}`} role="status">{status}</p>}
					{task?.plan && items.length ? <>
						{task.plan.completionCriteria && <p className="task-outline-criteria">{t("taskCompletionCriteria")}：{task.plan.completionCriteria}</p>}
						<div className="task-plan-list">{items.map(item => <div key={item.id} className={`task-plan-step ${interrupted && item.status === "running" ? "interrupted" : item.status}${expanded === item.id ? " expanded" : ""}`}>
							<button type="button" className="task-plan-step-head" aria-expanded={expanded === item.id} onClick={() => setExpanded(value => value === item.id ? null : item.id)}>
								<span className="task-plan-mark" aria-hidden="true">{interrupted && item.status === "running" ? "×" : item.status === "done" ? "✓" : item.status === "running" ? "●" : ""}</span>
								<span className="task-plan-step-title">{item.title}</span><FiChevronRight className={expanded === item.id ? "open" : ""} />
							</button>
							{expanded === item.id && <div className="task-plan-step-detail">
								{item.detail && <p>{item.detail}</p>}
								{!!item.blockedBy?.length && <p>{t("taskBlockedBy", { steps: item.blockedBy.join(", ") })}</p>}
								{planStepArtifacts(task, item).map(({ artifact, messageId }) => <div className="task-artifact-row" key={artifact.toolCallId}>
									{artifact.path && <button type="button" title={artifact.path} onClick={() => preview(artifact.path!)}>{artifact.path}</button>}
									<button type="button" title={t("taskJumpToChat")} onClick={() => window.dispatchEvent(new CustomEvent("pi:jump-tool", { detail: { messageId, toolCallId: artifact.toolCallId } }))}>{artifact.path ? "↗" : artifact.label}</button>
								</div>)}
								<button type="button" className="task-step-jump" onClick={() => window.dispatchEvent(new CustomEvent("pi:jump-message", { detail: { messageId: planSource?.id ?? task.sourceMessageId } }))}>{t("taskJumpToChat")} →</button>
							</div>}
						</div>)}</div>
					</> : <div className="task-section-empty"><div className="task-empty-circles" aria-hidden="true"><i /><i /><i /></div><p>{t("taskProgressEmpty")}</p></div>}
				</div>}
			</section>
			<section className="task-section">
				<button type="button" className="task-section-heading" aria-expanded={outputsOpen} onClick={() => setOutputsOpen(value => !value)}><FiChevronRight className={outputsOpen ? "open" : ""} />{t("taskOutputsHeading")}</button>
				{outputsOpen && <div className="task-section-content">{files.length ? <div className="task-file-results">{files.map(file => <div className="task-file-result" key={file.path}>
					<FiFile aria-hidden="true" /><button type="button" title={file.path} onClick={() => preview(file.path)}><span>{file.path.split("/").at(-1)}</span>{file.path.includes("/") && <small>{file.path}</small>}</button>
					{file.counted && <span className="task-file-counts"><span>+{file.added}</span> <span>−{file.removed}</span></span>}
				</div>)}</div> : <div className="task-section-empty"><FiFile className="task-empty-file" aria-hidden="true" /><p>{t("taskOutputsEmpty")}</p></div>}</div>}
			</section>
		</div>
	</div>;
}
