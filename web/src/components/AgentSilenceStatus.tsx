import { useEffect, useState } from "react";
import type { ClientMessage, UiMessage } from "../types";
import type { ChatState } from "../use-chat";
import { useT } from "../i18n";

export function AgentSilenceStatus({ chat, send }: { chat: ChatState; send: (message: ClientMessage) => boolean }) {
	const t = useT();
	const silence = chat.agentSilence;
	const [now, setNow] = useState(Date.now());
	const [acknowledged, setAcknowledged] = useState(false);
	useEffect(() => { setAcknowledged(false); }, [silence?.since, silence?.conversationId]);
	useEffect(() => {
		if (!silence) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [silence]);
	if (chat.state?.recovery && Object.values(chat.state.recovery).some(Boolean)) return null;
	if (!chat.ready || !silence || silence.conversationId !== chat.activeConversationId || !chat.state?.isStreaming) return null;
	const seconds = Math.max(0, Math.floor((now - silence.since) / 1000));
	const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	const messages = chat.state.messages;
	const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
	const lastUser = messages[lastUserIndex] as UiMessage | undefined;
	const prompt = lastUser?.content.map((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").filter(Boolean).join("\n").trim() ?? "";
	const toolsSincePrompt = messages.slice(lastUserIndex + 1).some((message) => message.content.some((part) => part.type === "toolCall"));
	const canRetry = silence.activity === "model" && !!prompt && !toolsSincePrompt && lastUser?.content.every((part) => part.type === "text");
	return <div className={`agent-silence ${silence.activity}`} role="status"><span className="agent-silence-label">⚠ {silence.activity === "tool" ? t("toolSilent", { duration }) : t("modelSilent", { duration })}</span>{acknowledged ? <button type="button" onClick={() => setAcknowledged(false)}>{t("actions")}</button> : <span className="agent-silence-actions"><button type="button" onClick={() => send({ type: "abort" })}>{t("stop")}</button><button type="button" disabled={!canRetry} title={!canRetry ? t("retrySilentUnavailable") : undefined} onClick={() => { if (canRetry) send({ type: "retry_silent_prompt", conversationId: silence.conversationId, text: prompt }); }}>{t("retry")}</button><button type="button" onClick={() => setAcknowledged(true)}>{t("continueWaiting")}</button></span>}</div>;
}
