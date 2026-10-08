import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiChevronDown } from "react-icons/fi";
import { useT } from "../i18n";
import type { ModelInfo } from "../types";
import type { ToolTextIncident } from "../tool-text";
export interface ToolRecoveryActions {
	messageId?: string;
	currentModelId?: string;
	disabled: boolean;
	models: ModelInfo[];
	onLoadModels: () => void;
	retry: (modelId?: string) => void;
}
function RecoveryModelMenu({ recovery }: { recovery: ToolRecoveryActions }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 300 });
	const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
	const close = () => { setOpen(false); trigger.current?.focus(); };
	useEffect(() => { if (recovery.disabled) setOpen(false); }, [recovery.disabled]);
	useLayoutEffect(() => {
		if (!open) return;
		const place = () => {
			const r = trigger.current?.getBoundingClientRect();
			if (!r) return;
			const height = Math.min(300, window.innerHeight - 24, menu.current?.scrollHeight || 100);
			setPosition({ left: Math.max(12, Math.min(r.left, window.innerWidth - 272)), top: r.bottom + height + 8 <= window.innerHeight ? r.bottom + 6 : Math.max(12, r.top - height - 6), maxHeight: height });
		};
		place();
		window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
		return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
	}, [open, recovery.models]);
	useEffect(() => {
		if (!open) return;
		(menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], button') ?? menu.current)?.focus();
		const outside = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false); };
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [open, recovery.models]);
	return <><button ref={trigger} type="button" disabled={recovery.disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => { if (!open) recovery.onLoadModels(); setOpen(!open); }} onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); recovery.onLoadModels(); setOpen(true); } }}>{t("toolRecoverySwitch")} <FiChevronDown className={open ? "up" : ""} /></button>
		{open && createPortal(<div ref={menu} className="tool-model-menu dd-menu" role="menu" aria-label={t("toolRecoverySwitch")} tabIndex={-1} style={position} onKeyDown={e => {
			if (e.key === "Escape") { e.preventDefault(); close(); }
			if (e.key === "Tab") setOpen(false);
			if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
				e.preventDefault(); const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
				const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
				const index = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (current + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
				buttons[index]?.focus();
			}
		}}>{recovery.models.length ? recovery.models.map(model => <button type="button" role="menuitemradio" aria-checked={model.id === recovery.currentModelId} className={`dd-item ${model.id === recovery.currentModelId ? "active" : ""}`} key={model.id} onClick={() => { close(); recovery.retry(model.id); }}><span className="dd-model-name">{model.name}</span><span className="dd-model-provider">{model.provider}</span></button>) : <span className="tool-model-empty">{t("loading")}</span>}</div>, document.body)}
	</>;
}
export function ToolRecoveryCard({ incident, model, recovery }: { incident: ToolTextIncident; model: string; recovery?: ToolRecoveryActions }) {
	const t = useT();
	const [rawOpen, setRawOpen] = useState(false);
	return <div className="unexecuted-tool" role="status" data-incident-id={incident.incidentId}>
		<header><strong>✗ {t("toolUnexecutedTitle")}</strong><span>{t("toolUnexecutedAttempts", { n: incident.reminders.length })}</span></header>
		<div className="tool-recovery-body"><p>{t(incident.reminders.length ? "toolUnexecutedHint" : "unexecutedToolHint", { model })}</p>
		<div className="tool-recovery-actions">
			{recovery && <><button type="button" className="tool-recovery-primary" disabled={recovery.disabled} onClick={() => recovery.retry()}>{t("toolRecoveryResend")}</button><RecoveryModelMenu recovery={recovery} /></>}
			<button type="button" className="tool-recovery-raw" aria-expanded={rawOpen} onClick={() => setRawOpen(value => !value)}>{t(rawOpen ? "toolRecoveryRawHide" : "toolRecoveryRaw")}</button>
		</div>
		{rawOpen && <div className="tool-recovery-outputs">{incident.outputs.map(({ message, raw, attempt }) => <section key={message.id}><div>{t(attempt ? "toolRecoveryAfterReminder" : "toolRecoveryFirst")}{message.timestamp ? ` · ${new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}{attempt > 0 && ` · ${t("toolRecoveryNoCall")}`}</div><pre>{raw}</pre></section>)}</div>}
		</div>
	</div>;
}
