import { useEffect, useState } from "react";
import type { ClientMessage, UiState } from "../types";
import { useT } from "../i18n";
export function RecoveryStatus({ state, send, connected }: { state: UiState | null; connected: boolean; send: (message: ClientMessage) => boolean }) {
	const t = useT();
	const [now, setNow] = useState(Date.now());
	const recovery = state?.recovery;
	const operation = recovery?.summary ?? recovery?.retry ?? recovery?.compaction;
	useEffect(() => {
		if (!operation) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [operation]);
	if (!operation || !state) return null;
	const deadline = "deadline" in operation ? operation.deadline : undefined;
	const label = recovery?.summary ? recovery.summary.phase === "waiting" ? "recoverySummaryWaiting" : "recoverySummaryRunning" : recovery?.retry ? recovery.retry.phase === "running" || now >= recovery.retry.deadline ? "recoveryRunning" : "recoveryWaiting" : "recoveryCompacting";
	return <div className="agent-silence" role="status"><span>{t(label)}{connected && deadline !== undefined && deadline > now && ` · ${Math.max(0, Math.ceil((deadline - now) / 1000))}s`}{"attempt" in operation && operation.attempt !== undefined && ` · ${operation.attempt}/${operation.maxAttempts}`}</span><button disabled={!connected} onClick={() => send({ type: "cancel_recovery", conversationId: state.conversationId, operationId: operation.id })}>{t("cancel")}</button></div>;
}
export function ConversationRunSettings({ state, send }: { state: UiState | null; send: (message: ClientMessage) => boolean }) {
	const t = useT();
	if (!state?.runSettings) return null;
	return <details className="conversation-run-settings"><summary>{t("conversationRunSettings")}</summary>{(["autoCompaction", "autoRetry"] as const).map(key => <label key={key}><input type="checkbox" checked={state.runSettings![key]} onChange={event => send({ type: "set_run_settings", conversationId: state.conversationId, [key]: event.target.checked })} />{t(key === "autoCompaction" ? "conversationAutoCompaction" : "conversationAutoRetry")}</label>)}</details>;
}
