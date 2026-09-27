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
	return <span className={`waiting-header-status${slow ? " slow" : ""}`} role="status"><span className="waiting-header-separator" aria-hidden="true">·</span><WorkingDots /><span className="waiting-header-label">{label}</span><span className="waiting-header-duration">{elapsed}s</span></span>;
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
