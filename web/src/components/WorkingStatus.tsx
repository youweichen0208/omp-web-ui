import type { UiState, ToolStatus } from "../types";
import { activeTool, toolTarget } from "../agent-activity";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { waitingPhase } from "../waiting-phase";

export function WorkingDots() {
	return <span className="working-dots" aria-hidden="true"><i /><i /><i /></span>;
}

export function WaitingHeaderStatus({ startedAt, silenceNotified = false }: { startedAt?: number; silenceNotified?: boolean }) {
	const t = useT();
	const start = useRef(startedAt && startedAt > 0 ? startedAt : Date.now());
	const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - start.current) / 1000)));
	useEffect(() => {
		const timer = window.setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - start.current) / 1000))), 1000);
		return () => window.clearInterval(timer);
	}, []);
	const phase = waitingPhase(elapsed);
	if (phase === "handoff" && silenceNotified) return null;
	const slow = phase === "slow" || phase === "handoff";
	const label = t(slow ? "activitySlowResponse" : phase === "thinking" ? "activityStillThinking" : "activityAnalyze");
	return <div className={`waiting-header-status${slow ? " slow" : ""}`} role="status"><WorkingDots /><span className="waiting-header-label">{label}</span><span className="waiting-header-duration">{elapsed}s</span></div>;
}
export function WorkingStatus({ label, phase, durationMs }: { label: string; phase: string; durationMs?: number }) {
	const t = useT();
	const [clock, setClock] = useState({ phase, started: Date.now(), elapsed: 0 });
	useEffect(() => {
		const started = Date.now() - (durationMs ?? 0);
		const update = () => setClock({ phase, started, elapsed: Date.now() - started });
		update();
		const timer = setInterval(update, 1000);
		return () => clearInterval(timer);
	}, [phase, durationMs]);
	const elapsed = clock.phase === phase ? clock.elapsed : durationMs ?? 0;
	return <div className="agent-working" role="status"><WorkingDots /><span>{label}</span>{elapsed >= 3000 && <span className="working-duration"> · {t("thinkingDuration", { n: Math.floor(elapsed / 1000) })}</span>}</div>;
}

/** Shared by chat and Wiki: identical waiting phases, tool activity and disconnect state. */
export function ConversationWorkingStatus({ state, connected, silenceNotified, toolStatuses }: {
	state: Pick<UiState, "messages" | "streamingMessage" | "isStreaming" | "conversationId" | "model" | "recovery">;
	connected: boolean; silenceNotified: boolean; toolStatuses: ReadonlyMap<string, ToolStatus>;
}) {
	const t = useT();
	const messages = state.streamingMessage ? [...state.messages, state.streamingMessage] : state.messages;
	const toolResults = new Map(state.messages.filter(m => m.role === "toolResult").map(m => [m.toolCallId, m]));
	const lastUserIndex = state.messages.findLastIndex((message) => message.role === "user");
	const runningTool = state.isStreaming ? activeTool(messages, toolStatuses) : undefined;
	const currentAssistant = state.messages.slice(lastUserIndex + 1).findLast((message) => message.role === "assistant");
	const lastBlock = state.streamingMessage?.content.at(-1) ?? currentAssistant?.content.at(-1);
	const completedTool = lastBlock?.type === "toolCall" && typeof lastBlock.id === "string" && (toolStatuses.has(lastBlock.id) || toolResults.has(lastBlock.id));
	const activityLabel = runningTool ? runningTool.name === "bash" ? t("waitingCommand") : t(runningTool.name === "read" ? "activityReading" : "activityTool", { name: runningTool.name === "read" ? toolTarget(runningTool) : runningTool.name }) : t(completedTool ? "waitingModel" : lastBlock?.type === "text" ? "activityReply" : "activityAnalyze");
	const activityPhase = `${state.conversationId}:${runningTool?.id ?? state.streamingMessage?.id ?? "waiting"}:${state.streamingMessage?.content.length ?? 0}:${lastBlock?.type ?? ""}`;
	const streamingHasContent = state.streamingMessage?.content.some((block) => block.type === "text" ? (typeof block.text === "string" && !!block.text.trim()) || !!block.truncated : block.type === "thinking" ? typeof block.thinking === "string" && !!block.thinking.trim() : true) ?? false;
	const awaitingFirstAssistant = state.isStreaming && !streamingHasContent && lastUserIndex >= 0 && !state.messages.slice(lastUserIndex + 1).some((message) => message.role === "assistant");
	const showWorkingFooter = runningTool?.name !== "bash" && (!streamingHasContent || !!runningTool || !!completedTool);
	if (state.recovery && Object.values(state.recovery).some(Boolean)) return null;
	if (!state.isStreaming) return null;
	if (!connected) return <div className="agent-working disconnected" role="status">{t("workDisconnected")}</div>;
	if (awaitingFirstAssistant) {
		const user = state.messages[lastUserIndex];
		return <div className="msg msg-assistant agent-working-placeholder">
			<div className="msg-meta">
				<span className="msg-role">{t("role.assistant")}</span>
				{state.model?.id && <span className="msg-model">{state.model.id}</span>}
				<span className="msg-time">{new Date(user.timestamp ?? Date.now()).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
			</div>
			<WaitingHeaderStatus key={`${state.conversationId}:${user.id}`} startedAt={user.timestamp} silenceNotified={silenceNotified} />
		</div>;
	}
	return showWorkingFooter ? <WorkingStatus key={state.conversationId} label={activityLabel} phase={activityPhase} durationMs={!runningTool && lastBlock?.type === "thinking" && typeof lastBlock.durationMs === "number" ? lastBlock.durationMs : undefined} /> : null;
}
