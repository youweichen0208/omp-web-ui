import { WorkspacePathContext } from "../workspace-context";
import { bashCommand } from "../bash-steps";
import { compactCommandLabel, commandPresentation } from "../bash-presentation";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { FiChevronRight, FiMoreHorizontal } from "react-icons/fi";
import type { ServerMessage, TaskProgress, UiMessage, UiToolCallBlock } from "../types";
import { changeLineCount } from "../edit-write-presentation";
import { useI18n, useT } from "../i18n";
import { planStepArtifacts, planStepPresentation, phaseSummary, progressPhases, progressResult, plainTitle, type ProgressPhase } from "../task-progress-view";

type Silence = Extract<ServerMessage, { type: "agent_silence" }> | null;
const duration = (seconds: number, underSecond: string) => seconds < 1 ? underSecond : seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function TaskProgressPanel({ task, silence, cwd, messages, conversationTitle, onPreview, onViewChanges }: { task: TaskProgress; silence: Silence; cwd: string; messages: UiMessage[]; conversationTitle: string; onPreview: (path: string, name: string) => void; onViewChanges: (hash?: string) => void }) {
	const t = useT();
	const [expanded, setExpanded] = useState<string | null>(null);
	const [showProcess, setShowProcess] = useState(true);
	const [showRaw, setShowRaw] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const planListRef = useRef<HTMLDivElement>(null);
	const [hoveredTool, setHoveredTool] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	useEffect(() => { setExpanded(null); setShowRaw(false); setShowProcess(true); }, [task.id]);
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
	const displayedTask = useMemo(() => {
		const commands = new Map(messages.flatMap((message) => message.content.flatMap((block) => block.type === "toolCall" && block.name === "bash" && typeof block.id === "string" ? [[block.id, bashCommand(typeof block.argumentsText === "string" ? block.argumentsText : undefined)] as const] : [])));
		return { ...task, steps: task.steps.map((step) => ({ ...step, artifacts: step.artifacts.map((item) => ({ ...item, label: commands.get(item.toolCallId) ?? item.label })) })) };
	}, [task, messages]);
	const phases = progressPhases(displayedTask);
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
	const single = !task.plan;
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
	const statusLabel = silence?.conversationId === task.conversationId ? silence.activity === "tool" ? t("taskLongTool") : t("taskWaitingModel") : task.status === "running" ? t("working") : task.status === "waiting" ? t("taskWaitingContinue") : task.status === "cancelled" ? t("taskCancelled") : task.status === "failed" ? t("error") : t("done");
	const hasResult = task.status === "done" && !single && !!(result.commit || result.tests || result.changes);
	const finalTestPhase = phases.findLast((phase) => phase.kind === "test" || phase.kind === "fix")?.id;
	const title = plainTitle(task.title || conversationTitle);
	const preview = (path: string) => { const relative = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path; onPreview(relative, relative.split("/").at(-1) ?? relative); };
	const activeTool = task.steps.findLast((step) => step.status === "running" && step.artifacts.length)?.artifacts.at(-1);
	const activeCall = activeTool ? messages.flatMap((message) => message.content).find((part): part is UiToolCallBlock => part.type === "toolCall" && part.id === activeTool.toolCallId) : undefined;
	const activeCommand = activeTool && ["bash", "terminal"].includes(activeTool.kind) ? commandPresentation(bashCommand(activeCall?.argumentsText) ?? activeTool.label, cwd).command : "";
	const activeArtifact = activeTool ? activeCommand ? /^git\s+commit\b/.test(activeCommand) ? `${t("taskCommitting")} · git commit` : `${t("taskArtifactRun")} · ${activeCommand}` : `${activeTool.kind === "read" ? t("taskArtifactRead") : activeTool.kind === "edit" ? t("taskArtifactEdit") : activeTool.kind === "write" ? t("taskArtifactWrite") : activeTool.kind} · ${activeTool.label}` : undefined;
	const planChangesFor = (item: NonNullable<TaskProgress["plan"]>["items"][number]) => planStepArtifacts(displayedTask, item).filter(({ artifact }) => changes.has(artifact.toolCallId)).map(({ artifact, messageId }) => ({ messageId, toolCallId: artifact.toolCallId, count: changes.get(artifact.toolCallId)! }));
	const assignedToolIds = new Set(task.plan?.items.flatMap(item => item.toolCallIds ?? []) ?? []);
	const unassignedArtifacts = task.plan ? displayedTask.steps.flatMap(step => step.artifacts.filter(item => !assignedToolIds.has(item.toolCallId)).map(item => ({ item, messageId: step.messageId }))) : [];
	const planChange = task.plan?.changeSummary || task.plan?.changes?.map((change) => t(change.kind === "added" ? "taskOutlineAdded" : change.kind === "removed" ? "taskOutlineRemoved" : "taskOutlineUpdated", { n: change.position ?? "", title: planStepPresentation(change.title).title })).join("；") || (task.plan && (task.plan.added || task.plan.removed) ? `+${task.plan.added} / −${task.plan.removed}` : "");

	const copyMarkdown = () => {
		const lines = [`# ${title}`, `${statusLabel} · ${completed} ${t(task.plan ? "taskPlanSteps" : "taskPhases")} · ${t("taskDuration")} ${duration(elapsed, t("taskUnderSecond"))}`, ...(task.plan ? task.plan.items.map((item) => `- ${item.status === "done" ? "[x]" : "[ ]"} ${item.title}`) : phases.flatMap((phase) => [`## ${phase.title}`, ...phase.steps.flatMap((step) => step.artifacts.map((item) => `- ${item.kind}: ${item.label}`))]))];
		void navigator.clipboard.writeText(lines.join("\n"));
		setMenuOpen(false);
	};
	useEffect(() => { if (task.status !== "running" && (!hasResult || !!task.plan)) setShowProcess(true); }, [task.status, hasResult, !!task.plan]);
	return <WorkspacePathContext.Provider value={cwd}><div className={`task-progress ${task.status}`} tabIndex={-1} aria-label={t("taskProgress")}>
		<div className="task-progress-head">
			<div className="task-progress-heading">
				<div className="task-progress-menu" ref={menuRef}>
					<button type="button" className="task-progress-menu-trigger" aria-label={t("more")} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><FiMoreHorizontal /></button>
					{menuOpen && <div className="task-progress-menu-list">
						{hasResult && <button type="button" onClick={() => { setShowProcess((value) => !value); setMenuOpen(false); }}>{t(showProcess ? "taskOnlyResult" : "taskShowProcess")}</button>}
						{!single && !task.plan && <button type="button" onClick={() => { setShowRaw((value) => !value); setShowProcess(true); setMenuOpen(false); }}>{t(showRaw ? "taskHideRaw" : "taskShowRaw", { n: task.steps.length })}</button>}
						{finalMessage && <button type="button" onClick={() => { jump(finalMessage.id); setMenuOpen(false); }}>{t("taskFinalReply")}</button>}
						<button type="button" onClick={copyMarkdown}>{t("taskCopyMarkdown")}</button>
					</div>}
				</div>
			</div>
			<div className="task-progress-meta"><span className={`task-progress-status ${task.status}`}><i aria-hidden="true" />{task.plan && !task.plan.awaitingConfirmation && task.status === "running" && !silence ? t("taskPlanPosition", { current: Math.max(1, currentPlanIndex + 1), total }) : statusLabel}</span><span>· {duration(elapsed, t("taskUnderSecond"))}</span><span>· {t("bashCommandCount", { n: task.steps.flatMap((step) => step.artifacts).filter((item) => item.kind === "bash" || item.kind === "terminal").length })}</span></div>
			{task.plan && <div className="task-progress-source" title={t("taskPlanSourceHint")}>{t(task.plan.awaitingConfirmation ? "planPrevious" : "taskPlanSource")}</div>}
			{task.plan?.completionCriteria && <p className="task-outline-criteria">{t("taskCompletionCriteria")}：{task.plan.completionCriteria}</p>}
		</div>
		{hasResult && <div className="task-result task-result-inline">{result.commit && <code title={result.commit.subject}>{result.commit.hash}</code>}{result.tests && <span className="success">{result.tests.passed}/{result.tests.total} {t("taskPassed")}</span>}{result.changes && <span className="task-result-counts"><span className="success">+{result.changes.added}</span> <span className="removed">−{result.changes.deleted}</span></span>}<button type="button" title={t("taskViewChanges")} onClick={() => onViewChanges(result.commit?.hash)}>{t("taskChanges")} ›</button></div>}

		{single ? <div className="task-single-actions">{phases.flatMap((phase) => phase.steps).flatMap((step) => step.artifacts.map((item) => <ArtifactRow key={item.toolCallId} item={item} change={changes.get(item.toolCallId)} onPreview={preview} onJump={() => jump(step.messageId)} onJumpTool={() => jumpTool(step.messageId, item.toolCallId)} />))}</div> : task.plan && showProcess ? <div className="task-plan-list" ref={planListRef}>{task.plan.items.map((item, index) => <PlanStepRow key={item.id} item={item} index={index} now={now} activeArtifact={activeTool && item.toolCallIds?.includes(activeTool.toolCallId) ? activeArtifact : undefined} changes={planChangesFor(item)} onJumpTool={jumpTool} artifacts={planStepArtifacts(displayedTask, item)} open={expanded === item.id} onToggle={() => setExpanded((value) => value === item.id ? null : item.id)} onPreview={preview} onJump={jump} taskEndedAt={task.status === "running" ? undefined : finishedAt} />)}</div> : showProcess && <><div className="task-current-phase">{currentPhase && <PhaseRow phase={currentPhase} changes={changes} now={now} attempt={currentAttempt} showRaw={showRaw} testResult={currentPhase.id === finalTestPhase ? result.tests : undefined} linked={!!hoveredTool && currentPhase.steps.some((step) => step.artifacts.some((item) => item.toolCallId === hoveredTool))} stalled={!!silence} open={expanded === currentPhase.id} onToggle={() => setExpanded((value) => value === currentPhase.id ? null : currentPhase.id)} onJump={jump} onJumpTool={jumpTool} onPreview={preview} />}</div><div className="task-progress-list">{phases.filter((phase) => phase !== currentPhase).map((phase) => <PhaseRow key={phase.id} phase={phase} changes={changes} now={now} showRaw={showRaw} testResult={phase.id === finalTestPhase ? result.tests : undefined} linked={!!hoveredTool && phase.steps.some((step) => step.artifacts.some((item) => item.toolCallId === hoveredTool))} stalled={!!silence && phase.status === "running"} open={expanded === phase.id} onToggle={() => setExpanded((value) => value === phase.id ? null : phase.id)} onJump={jump} onJumpTool={jumpTool} onPreview={preview} />)}</div></>}
		{showProcess && unassignedArtifacts.length > 0 && <div className="task-unassigned-records"><div className="task-progress-source">{t("planUnassignedRecords")}</div>{unassignedArtifacts.map(({ item, messageId }) => <ArtifactRow key={item.toolCallId} item={item} change={changes.get(item.toolCallId)} onPreview={preview} onJump={() => jump(messageId)} onJumpTool={() => jumpTool(messageId, item.toolCallId)} />)}</div>}
		{planChange && <div className="task-plan-change" role="status">{t("taskOutlineChanged")}：{planChange}</div>}
	</div></WorkspacePathContext.Provider>;
}

function PlanStepRow({ item, index, now, taskEndedAt, activeArtifact, changes, onJumpTool, artifacts, open, onToggle, onPreview, onJump }: { item: NonNullable<TaskProgress["plan"]>["items"][number]; index: number; now: number; taskEndedAt?: number; activeArtifact?: string; changes: { messageId: string; toolCallId: string; count: { added: number; removed: number } }[]; onJumpTool: (messageId: string, toolCallId: string) => void; artifacts: ReturnType<typeof planStepArtifacts>; open: boolean; onToggle: () => void; onPreview: (path: string) => void; onJump: (messageId: string) => void }) {
	const t = useT();
	const presentation = planStepPresentation(item.title);
	const detail = item.detail || presentation.detail;
	return <div className={`task-plan-step ${item.status}${open ? " expanded" : ""}`}>
		<button type="button" className="task-plan-step-head" aria-expanded={open} onClick={onToggle}>
			<span className="task-plan-mark">{item.status === "done" ? "✓" : item.status === "running" ? "●" : item.status === "removed" ? "−" : index + 1}</span>
			<span className="task-plan-step-title" title={item.title}>{presentation.title}</span>
			{item.startedAt && item.status !== "removed" && <span className="task-plan-step-duration">{duration(Math.max(0, Math.floor(((item.endedAt ?? taskEndedAt ?? now) - item.startedAt) / 1000)), t("taskUnderSecond"))}</span>}
		</button>
		{item.status === "running" && activeArtifact && <small className="task-plan-current-file" title={activeArtifact}>{activeArtifact}</small>}
		{open && <div className="task-plan-step-detail">
			{detail && <p>{detail}</p>}
			{!!item.blockedBy?.length && <p>{t("taskBlockedBy", { steps: item.blockedBy.map((id) => `#${id}`).join(", ") })}</p>}
			{artifacts.map(({ artifact, messageId }) => <ArtifactRow key={artifact.toolCallId} item={artifact} change={changes.find((change) => change.toolCallId === artifact.toolCallId)?.count} onPreview={onPreview} onJump={() => onJump(messageId)} onJumpTool={() => onJumpTool(messageId, artifact.toolCallId)} />)}
			{!detail && !artifacts.length && <small>{t("taskNoStepDetails")}</small>}
		</div>}
	</div>;
}

function ArtifactRow({ item, change, onPreview, onJump, onJumpTool }: { item: ProgressPhase["steps"][number]["artifacts"][number]; change?: { added: number; removed: number }; onPreview: (path: string) => void; onJump: () => void; onJumpTool: () => void }) {
	const t = useT();
	const cwd = useContext(WorkspacePathContext);
	const label = item.kind === "bash" || item.kind === "terminal" ? compactCommandLabel(commandPresentation(item.label, cwd).command) : item.label;
	const action = item.kind === "read" ? t("taskArtifactRead") : item.kind === "write" ? t("taskArtifactWrite") : item.kind === "edit" ? t("taskArtifactEdit") : item.kind === "bash" ? t("taskArtifactRun") : item.kind;
	return <div className="task-artifact-row"><span>{action}</span>{item.path ? <button type="button" title={item.path} onClick={() => onPreview(item.path!)}><code>{label}</code></button> : <button type="button" title={item.label} onClick={item.kind === "bash" || item.kind === "terminal" ? onJumpTool : onJump}><code>{label}</code></button>}{change && <button type="button" className="task-artifact-change" onClick={onJumpTool} title={t("taskJumpToChat")}>+{change.added}{change.removed > 0 && ` −${change.removed}`}</button>}{item.outputLines !== undefined && <small>· {item.outputLines} {t("taskLines")}</small>}</div>;
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
	return <div className={`task-step ${stalled ? "stalled" : phase.status}${linked ? " linked" : ""}`}><div className="task-step-top"><button type="button" className="task-step-head" aria-expanded={open || showRaw} onClick={onToggle}><span className="task-step-mark" aria-hidden="true">{phase.status === "done" ? "✓" : phase.status === "failed" ? "×" : "●"}</span><span className="task-step-main"><span className="task-step-title">{phase.title}</span>{activeAction && <small className="task-step-active-action" title={activeAction}>{activeAction}</small>}</span><span className="task-step-duration">{seconds === null ? "" : duration(seconds, t("taskUnderSecond"))}</span><FiChevronRight className={open || showRaw ? "open" : ""} /></button>{changeArtifacts.length > 0 && <button type="button" className="task-phase-change" title={t("taskJumpToChat")} onClick={() => onJumpTool(changeArtifacts[0].messageId, changeArtifacts[0].toolCallId)}>+{added}{removed > 0 && ` −${removed}`}</button>}</div>{(open || showRaw) && <div className="task-step-detail">{summary && <p>{summary}</p>}{phase.steps.map((step) => <div className="task-raw-step" key={step.id}><div className="task-raw-summary">{plainTitle(step.title).slice(0, 24)}</div>{step.artifacts.map((artifact) => <ArtifactRow key={artifact.toolCallId} item={artifact} change={changes.get(artifact.toolCallId)} onPreview={onPreview} onJump={() => onJump(step.messageId)} onJumpTool={() => onJumpTool(step.messageId, artifact.toolCallId)} />)}<button type="button" className="task-step-jump" onClick={() => onJump(step.messageId)}>{t("taskJumpToChat")} →</button></div>)}</div>}</div>;
}
