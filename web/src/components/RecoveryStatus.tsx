import { useEffect, useState } from "react";
import type { ClientMessage, UiState } from "../types";
import { useT } from "../i18n";
export function RecoveryStatus({ state, send, connected }: { state: UiState | null; connected: boolean; send: (message: ClientMessage) => boolean }) {
	const t = useT();
	const [, tick] = useState(0);
	const now = performance.now();
	const recovery = state?.recovery;
	const operation = recovery?.summary ?? recovery?.retry ?? recovery?.compaction ?? recovery?.branch;
	useEffect(() => {
		if (!operation) return;
		const timer = setInterval(() => tick(value => value + 1), 250);
		return () => clearInterval(timer);
	}, [operation]);
	if (!operation || !state) return null;
	const deadline = recovery?.summary?.deadline ?? recovery?.retry?.deadline;
	const attempt = recovery?.summary?.attempt ?? recovery?.retry?.attempt;
	const maxAttempts = recovery?.summary?.maxAttempts ?? recovery?.retry?.maxAttempts;
	const label = recovery?.summary ? recovery.summary.phase === "waiting" ? "recoverySummaryWaiting" : "recoverySummaryRunning" : recovery?.retry ? recovery.retry.phase === "running" || now >= (recovery.retry.deadline ?? Infinity) ? "recoveryRunning" : "recoveryWaiting" : recovery?.branch ? "treeSummarizing" : "recoveryCompacting";
	return <div className="agent-silence" role="status"><span>{t(label)}{connected && deadline !== undefined && deadline > now && ` · ${Math.max(0, Math.ceil((deadline - now) / 1000))}s`}{attempt !== undefined && ` · ${attempt}/${maxAttempts}`}</span><button disabled={!connected} onClick={() => send({ type: "cancel_recovery", conversationId: state.conversationId, operationId: operation.id })}>{t("cancel")}</button></div>;
}
