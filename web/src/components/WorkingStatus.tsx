import type { UiState, ToolStatus } from "../types";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { conversationWait, type WaitStage } from "../waiting-indicator";
import { skillAwarePreview } from "../skill-block";

function WaitingIndicator({ stage, onStop }: { stage: WaitStage; onStop?: () => void }) {
	const t = useT();
	const started = useRef(Date.now());
	const [elapsed, setElapsed] = useState(0);
	useEffect(() => {
		const update = () => setElapsed(Date.now() - started.current);
		const appearance = window.setTimeout(update, stage.delay);
		const timer = window.setInterval(update, 250);
		return () => { window.clearTimeout(appearance); window.clearInterval(timer); };
	}, [stage.delay]);
	if (elapsed < stage.delay) return null;
	const seconds = Math.floor(elapsed / 1000);
	return <div className="waiting-indicator" role="status">
		<span className="waiting-brand" aria-hidden="true"><i /><i /><i /></span>
		<span className="waiting-label">{t(stage.label)}</span>
		{seconds >= 4 && <span className="waiting-duration" aria-live="off">{seconds < 60 ? t("waitSeconds", { n: seconds }) : t("waitMinutes", { m: Math.floor(seconds / 60), s: String(seconds % 60).padStart(2, "0") })}</span>}
		{seconds >= 60 && onStop && <button className="waiting-stop" onClick={onStop}>· {t("waitStop")}</button>}
	</div>;
}

/** Shared presentation; native retry, compaction and silence notices take precedence. */
export function ConversationWorkingStatus({ state, connected, silenceNotified, toolStatuses, onStop }: {
	state: Pick<UiState, "messages" | "streamingMessage" | "isStreaming" | "conversationId" | "model" | "recovery"> & Partial<Pick<UiState, "queue">>;
	connected: boolean; silenceNotified: boolean; toolStatuses: ReadonlyMap<string, ToolStatus>; onStop?: () => void;
}) {
	const t = useT();
	const lastUser = state.messages.findLast(m => m.role === "user");
	const previous = useRef({ conversation: state.conversationId, user: lastUser?.id, steering: [] as string[] });
	const [steeredUser, setSteeredUser] = useState<string>();
	useEffect(() => {
		const old = previous.current;
		if (old.conversation !== state.conversationId || !state.isStreaming) setSteeredUser(undefined);
		else if (lastUser && old.user !== lastUser.id) {
			const text = skillAwarePreview(lastUser.questionText ?? lastUser.content.filter(b => b.type === "text").map(b => b.type === "text" ? b.text : "").join("\n"));
			const preview = text.length > 2000 ? text.slice(0, 2000) + "…" : text;
			setSteeredUser(old.steering.some(value => skillAwarePreview(value) === preview) ? lastUser.id : undefined);
		}
		previous.current = { conversation: state.conversationId, user: lastUser?.id, steering: state.queue?.steering ?? [] };
	}, [state.conversationId, state.isStreaming, state.queue, lastUser]);
	const completed = new Map([...toolStatuses].filter(([, s]) => !s.running && (!s.conversationId || s.conversationId === state.conversationId)));
	const messages = state.streamingMessage ? [...state.messages.filter(m => m.id !== state.streamingMessage?.id), { ...state.streamingMessage, role: "assistant" }] : state.messages;
	const stage = conversationWait(messages, completed, steeredUser);
	if (!state.isStreaming || silenceNotified || state.recovery && Object.values(state.recovery).some(Boolean)) return null;
	if (!connected) return <div className="agent-working disconnected" role="status">{t("workDisconnected")}</div>;
	return stage && <WaitingIndicator key={`${state.conversationId}:${stage.key}:${stage.label}`} stage={stage} onStop={onStop} />;
}
