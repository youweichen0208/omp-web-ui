import { useEffect, useMemo, useRef, useState } from "react";
import { FiChevronRight, FiMoreHorizontal } from "react-icons/fi";
import type { ServerMessage, TaskProgress, UiMessage, UiToolCallBlock } from "../types";
import { changeLineCount } from "../edit-write-presentation";
import { useI18n, useT } from "../i18n";
import { phaseSummary, progressPhases, progressResult, plainTitle, type ProgressPhase } from "../task-progress-view";

type Silence = Extract<ServerMessage, { type: "agent_silence" }> | null;
const duration = (seconds: number, underSecond: string) => seconds < 1 ? underSecond : seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function TaskProgressPanel({ task, silence, cwd, messages, conversationTitle, onPreview, onViewChanges }: { task: TaskProgress; silence: Silence; cwd: string; messages: UiMessage[]; conversationTitle: string; onPreview: (path: string, name: string) => void; onViewChanges: (hash?: string) => void }) {
	const t = useT();
	const [expanded, setExpanded] = useState<string | null>(null);
	const [showProcess, setShowProcess] = useState(task.status === "running");
	const [showRaw, setShowRaw] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const planListRef = useRef<HTMLDivElement>(null);
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
	const changes = useMemo(() => {
		const results = new Map(messages.filter((message) => message.role === "toolResult" && message.toolCallId).map((message) => [message.toolCallId!, message]));
		const map = new Map<string, { added: number; removed: number }>();
		for (const message of messages) if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") {
			const call = part as UiToolCallBlock;
			const count = changeLineCount(call, results.get(call.id));
			if (count) map.set(call.id, count);
		}
		return map;
	}, [messages]);
	const result = progressResult(task, messages);
	const finishedAt = task.status === "running" ? now : task.endedAt ?? Math.max(task.startedAt, ...task.steps.map((step) => step.endedAt ?? step.startedAt));
	const elapsed = task.startedAt > 0 ? Math.max(0, Math.floor((finishedAt - task.startedAt) / 1000)) : 0;
	const planItems = task.plan?.items.filter((item) => item.status !== "removed") ?? [];
	const completed = task.plan ? planItems.filter((item) => item.status === "done").length : phases.filter((phase) => phase.status === "done").length;
	const single = !task.plan && phases.length === 1;
	const total = task.plan ? planItems.length : phases.length;
	const runningPhases = phases.filter((phase) => phase.status === "running");
	const currentPhase = task.status === "running" && !task.plan ? runningPhases.at(-1) : undefined;
	const currentCommand = currentPhase?.steps.findLast((step) => step.status === "running")?.artifacts.findLast((item) => ["bash", "terminal"].includes(item.kind));
	const currentCommandName = currentCommand?.label.trim().split(/\s+/)[0];
	const currentAttempt = currentCommandName ? task.steps.flatMap((step) => step.artifacts).filter((item) => ["bash", "terminal"].includes(item.kind) && item.label.trim().split(/\s+/)[0] === currentCommandName).length : 0;
	const currentPlanIndex = planItems.findIndex((item) => item.status === "running");
	const currentPlanId = planItems[currentPlanIndex]?.id;
	useEffect(() => {
		if (!task.plan || currentPlanIndex < 0 || !showProcess) return;
		const list = planListRef.current;
		const active = list?.querySelector<HTMLElement>(".task-plan-step.running");
		if (!list || !active) return;
		const top = active.offsetTop - list.offsetTop;
		list.scrollTop = Math.max(0, top - list.clientHeight / 3);
	}, [task.id, currentPlanId, showProcess]);
	const finalMessage = messages.slice(messages.findIndex((message) => message.id === task.sourceMessageId) + 1).findLast((message) => message.role === "assistant" && message.content.some((part) => part.type === "text"));
	const jump = (messageId: string) => window.dispatchEvent(new CustomEvent("pi:jump-message", { detail: { messageId } }));
	const jumpTool = (messageId: string, toolCallId: string) => window.dispatchEvent(new CustomEvent("pi:jump-tool", { detail: { messageId, toolCallId } }));
	const statusLabel = silence?.conversationId === task.conversationId ? silence.activity === "tool" ? t("taskLongTool") : t("taskWaitingModel") : task.status === "running" ? t("working") : task.status === "cancelled" ? t("taskCancelled") : task.status === "failed" ? t("error") : t("done");
	const hasResult = task.status !== "running" && !single && !!(result.commit || result.tests || result.changes);
	const finalTestPhase = phases.findLast((phase) => phase.kind === "test" || phase.kind === "fix")?.id;
	const title = plainTitle(conversationTitle || task.title);
	const showTitle = !!title;
	const preview = (path: string) => { const relative = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path; onPreview(relative, relative.split("/").at(-1) ?? relative); };
	const activeArtifact = task.steps.findLast((step) => step.status === "running" && step.artifacts.length)?.artifacts.at(-1)?.label;
	const planChangesFor = (item: NonNullable<TaskProgress["plan"]>["items"][number]) => item.startedAt ? task.steps.filter((step) => step.startedAt >= item.startedAt! && step.startedAt < (item.endedAt ?? Infinity)).flatMap((step) => step.artifacts.filter((artifact) => changes.has(artifact.toolCallId)).map((artifact) => ({ messageId: step.messageId, toolCallId: artifact.toolCallId, count: changes.get(artifact.toolCallId)! }))) : [];
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
			<div className="task-progress-meta"><span className={`task-progress-status ${task.status}`}>● {statusLabel}</span>{task.plan && task.status === "running" ? <span>· {t("taskPlanPosition", { current: Math.max(1, currentPlanIndex + 1), total })}</span> : task.plan ? <span>· {completed} {t("taskPlanSteps")}</span> : task.status !== "running" && !single && <span>· {t("taskCompletedCount", { n: completed })}</span>}<span>· {t("taskDuration")} {duration(elapsed, t("taskUnderSecond"))}</span></div>
			{task.plan && <div className="task-progress-track" aria-hidden="true">{planItems.map((item) => <span key={item.id} className={item.status} />)}</div>}
		</div>
		{hasResult && <div className="task-result"><div className="task-result-label">{t("taskResult")}</div>{result.commit && <div className="task-result-row"><span>{t("taskCommit")}</span><code>{result.commit.hash}</code>{result.commit.subject && <span className="task-result-subject">{plainTitle(result.commit.subject)}</span>}</div>}{result.tests && <div className="task-result-row"><span>{t("taskTests")}</span><strong className="success">{result.tests.passed} / {result.tests.total} {t("taskPassed")}</strong></div>}{result.changes && <div className="task-result-row"><span>{t("taskChanges")}</span><strong className="success">+{result.changes.added}</strong><strong className="removed">−{result.changes.deleted}</strong><span>· {result.changes.files} {t("taskFiles")}</span></div>}<div className="task-result-actions"><button type="button" onClick={() => onViewChanges(result.commit?.hash)}>{t("taskViewChanges")}</button>{finalMessage && <button type="button" onClick={() => jump(finalMessage.id)}>{t("taskFinalReply")}</button>}</div></div>}
		{task.plan && (task.plan.added > 0 || task.plan.removed > 0) && <div className="task-plan-change">{t("taskPlanChanged")} · {task.plan.added > 0 && `+${task.plan.added} ${t("taskPlanSteps")}`}{task.plan.added > 0 && task.plan.removed > 0 && " · "}{task.plan.removed > 0 && `−${task.plan.removed} ${t("taskPlanSteps")}`}</div>}
		{single ? <div className="task-single-actions">{phases[0].steps.flatMap((step) => step.artifacts.map((item) => <ArtifactRow key={item.toolCallId} item={item} change={changes.get(item.toolCallId)} onPreview={preview} onJump={() => jump(step.messageId)} onJumpTool={() => jumpTool(step.messageId, item.toolCallId)} />))}</div> : task.plan && showProcess ? <div className="task-plan-list" ref={planListRef}>{task.plan.items.map((item, index) => <PlanStepRow key={item.id} item={item} index={index} now={now} activeArtifact={activeArtifact} changes={planChangesFor(item)} onJumpTool={jumpTool} />)}</div> : showProcess && <><div className="task-current-phase">{currentPhase && <PhaseRow phase={currentPhase} changes={changes} now={now} attempt={currentAttempt} showRaw={showRaw} testResult={currentPhase.id === finalTestPhase ? result.tests : undefined} linked={!!hoveredTool && currentPhase.steps.some((step) => step.artifacts.some((item) => item.toolCallId === hoveredTool))} stalled={!!silence} open={expanded === currentPhase.id} onToggle={() => setExpanded((value) => value === currentPhase.id ? null : currentPhase.id)} onJump={jump} onJumpTool={jumpTool} onPreview={preview} />}</div><div className="task-progress-list">{phases.filter((phase) => phase !== currentPhase).map((phase) => <PhaseRow key={phase.id} phase={phase} changes={changes} now={now} showRaw={showRaw} testResult={phase.id === finalTestPhase ? result.tests : undefined} linked={!!hoveredTool && phase.steps.some((step) => step.artifacts.some((item) => item.toolCallId === hoveredTool))} stalled={!!silence && phase.status === "running"} open={expanded === phase.id} onToggle={() => setExpanded((value) => value === phase.id ? null : phase.id)} onJump={jump} onJumpTool={jumpTool} onPreview={preview} />)}</div></>}
	</div>;
}

function PlanStepRow({ item, index, now, activeArtifact, changes, onJumpTool }: { item: NonNullable<TaskProgress["plan"]>["items"][number]; index: number; now: number; activeArtifact?: string; changes: { messageId: string; toolCallId: string; count: { added: number; removed: number } }[]; onJumpTool: (messageId: string, toolCallId: string) => void }) {
	const t = useT();
	const actions = item.actions ? [[item.actions.read, t("taskReadCount", { n: item.actions.read })], [item.actions.write, t("taskWriteCount", { n: item.actions.write })], [item.actions.edit, t("taskEditCount", { n: item.actions.edit })], [item.actions.command, t("taskCommandCount", { n: item.actions.command })]].filter(([count]) => Number(count) > 0).map(([, label]) => label).join(" · ") : "";
	const added = changes.reduce((sum, change) => sum + change.count.added, 0);
	const removed = changes.reduce((sum, change) => sum + change.count.removed, 0);
	return <div className={`task-plan-step ${item.status}`}>
		<span className="task-plan-mark">{item.status === "done" ? "✓" : item.status === "running" ? "●" : item.status === "removed" ? "−" : index + 1}</span>
		<div><span>{item.title}</span>{item.added && <small className="task-plan-added">{t("taskPlanAdded")}</small>}{actions && <small className="task-plan-actions">{actions}</small>}{item.status === "running" && activeArtifact && <small className="task-plan-current-file">{activeArtifact}</small>}</div>
		{changes.length > 0 && <button type="button" className="task-phase-change" title={t("taskJumpToChat")} onClick={() => onJumpTool(changes[0].messageId, changes[0].toolCallId)}>+{added}{removed > 0 && ` −${removed}`}</button>}
		{item.startedAt && item.status !== "removed" && <small className="task-plan-step-duration">{duration(Math.max(0, Math.floor(((item.endedAt ?? now) - item.startedAt) / 1000)), t("taskUnderSecond"))}</small>}
	</div>;
}

function ArtifactRow({ item, change, onPreview, onJump, onJumpTool }: { item: ProgressPhase["steps"][number]["artifacts"][number]; change?: { added: number; removed: number }; onPreview: (path: string) => void; onJump: () => void; onJumpTool: () => void }) {
	const t = useT();
	const action = item.kind === "read" ? t("taskArtifactRead") : item.kind === "write" ? t("taskArtifactWrite") : item.kind === "edit" ? t("taskArtifactEdit") : item.kind === "bash" ? t("taskArtifactRun") : item.kind;
	return <div className="task-artifact-row"><span>{action}</span>{item.path ? <button type="button" title={item.path} onClick={() => onPreview(item.path!)}><code>{item.label}</code></button> : <button type="button" title={item.label} onClick={onJump}><code>{item.label}</code></button>}{change && <button type="button" className="task-artifact-change" onClick={onJumpTool} title={t("taskJumpToChat")}>+{change.added}{change.removed > 0 && ` −${change.removed}`}</button>}{item.outputLines && <small>· {item.outputLines} {t("taskLines")}</small>}</div>;
}

function PhaseRow({ phase, changes, now, attempt = 0, showRaw, testResult, linked, stalled, open, onToggle, onJump, onJumpTool, onPreview }: { phase: ProgressPhase; changes: ReadonlyMap<string, { added: number; removed: number }>; now: number; attempt?: number; showRaw: boolean; testResult?: { passed: number; total: number }; linked: boolean; stalled: boolean; open: boolean; onToggle: () => void; onJump: (messageId: string) => void; onJumpTool: (messageId: string, toolCallId: string) => void; onPreview: (path: string) => void }) {
	const { t, locale } = useI18n();
	const summary = phaseSummary(phase, testResult, locale);
	const seconds = phase.startedAt ? Math.max(0, Math.floor(((phase.status === "running" ? now : phase.endedAt ?? phase.startedAt) - phase.startedAt) / 1000)) : null;
	const activeArtifact = phase.status === "running" ? phase.steps.findLast((step) => step.status === "running")?.artifacts.at(-1) : undefined;
	const activeAction = activeArtifact ? activeArtifact.kind === "bash" || activeArtifact.kind === "terminal" ? locale === "en" ? `Running ${activeArtifact.label}${attempt > 1 ? ` · attempt ${attempt}` : ""}` : `运行 ${activeArtifact.label}${attempt > 1 ? ` · 第 ${attempt} 次` : ""}` : activeArtifact.path ? `${locale === "en" ? activeArtifact.kind === "read" ? "Reading" : activeArtifact.kind === "edit" ? "Editing" : activeArtifact.kind === "write" ? "Writing" : "Working on" : activeArtifact.kind === "read" ? "读取" : activeArtifact.kind === "edit" ? "修改" : activeArtifact.kind === "write" ? "写入" : "处理"} ${activeArtifact.path}` : activeArtifact.label : "";
	const changeArtifacts = phase.steps.flatMap((step) => step.artifacts.filter((artifact) => changes.has(artifact.toolCallId)).map((artifact) => ({ messageId: step.messageId, toolCallId: artifact.toolCallId, count: changes.get(artifact.toolCallId)! })));
	const added = changeArtifacts.reduce((sum, item) => sum + item.count.added, 0);
	const removed = changeArtifacts.reduce((sum, item) => sum + item.count.removed, 0);
	return <div className={`task-step ${stalled ? "stalled" : phase.status}${linked ? " linked" : ""}`}><div className="task-step-top"><button type="button" className="task-step-head" aria-expanded={open || showRaw} onClick={onToggle}><span className="task-step-mark" aria-hidden="true">{phase.status === "done" ? "✓" : phase.status === "failed" ? "×" : "●"}</span><span className="task-step-main"><span className="task-step-title">{phase.title}</span>{activeAction && <small className="task-step-active-action" title={activeAction}>{activeAction}</small>}{summary && <small>{summary}</small>}</span><span className="task-step-duration">{seconds === null ? "" : duration(seconds, t("taskUnderSecond"))}</span><FiChevronRight className={open || showRaw ? "open" : ""} /></button>{changeArtifacts.length > 0 && <button type="button" className="task-phase-change" title={t("taskJumpToChat")} onClick={() => onJumpTool(changeArtifacts[0].messageId, changeArtifacts[0].toolCallId)}>+{added}{removed > 0 && ` −${removed}`}</button>}</div>{(open || showRaw) && <div className="task-step-detail">{phase.steps.map((step) => <div className="task-raw-step" key={step.id}><div className="task-raw-summary">{plainTitle(step.title).slice(0, 24)}</div>{step.artifacts.map((artifact) => <ArtifactRow key={artifact.toolCallId} item={artifact} change={changes.get(artifact.toolCallId)} onPreview={onPreview} onJump={() => onJump(step.messageId)} onJumpTool={() => onJumpTool(step.messageId, artifact.toolCallId)} />)}<button type="button" className="task-step-jump" onClick={() => onJump(step.messageId)}>{t("taskJumpToChat")} →</button></div>)}</div>}</div>;
}
