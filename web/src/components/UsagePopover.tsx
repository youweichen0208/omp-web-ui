import { useEffect, useRef, useState } from "react";
import type { UiMessage, UiState } from "../types";
import { useT } from "../i18n";
import { cacheHitPercent, cacheObservation, recentModelUsages, type TokenUsage } from "../usage-metrics";

type Stats = UiState["stats"];
interface Props { stats?: Stats; messages: UiMessage[]; canCompact: boolean; onCompact: () => void }

const formatTokens = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const demoCases = [
	{ tokens: 112_400, window: 1_000_000, rate: 86, parts: { system: 9_800, tools: 41_200, conversation: 58_100, attachments: 3_300 } },
	{ tokens: 820_000, window: 1_000_000, rate: 76, parts: { system: 20_000, tools: 270_000, conversation: 505_000, attachments: 25_000 } },
	{ tokens: 112_400, window: 1_000_000, rate: 28, parts: { system: 9_800, tools: 41_200, conversation: 58_100, attachments: 3_300 } },
] as const;

export function UsagePopover({ stats, messages, canCompact, onCompact }: Props) {
	const t = useT();
	const root = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const pinned = useRef(false);
	const [demo, setDemo] = useState(-1);
	useEffect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); pinned.current = false; } };
		const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); pinned.current = false; } };
		document.addEventListener("pointerdown", outside, true);
		document.addEventListener("keydown", escape);
		return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
	}, [open]);
	const recent = recentModelUsages(messages);
	const sample = demo >= 0 ? demoCases[demo] : null;
	const context = sample ? { tokens: sample.tokens, contextWindow: sample.window, percent: sample.tokens / sample.window * 100 } : stats?.contextUsage;
	const parts = sample?.parts ?? stats?.contextParts;
	const percent = context?.percent === null || context?.percent === undefined ? null : Math.round(context.percent);
	const shownPercent = percent === null ? 0 : Math.max(0, Math.min(100, percent));
	const windowTokens = context?.contextWindow ?? 0;
	const sessionRate = sample ? sample.rate : stats ? cacheHitPercent(stats.tokens) : null;
	const latest: TokenUsage | null = sample
		? demo === 2 ? { input: 65_000, output: 0, cacheRead: 28_000, cacheWrite: 7_000 }
			: demo === 1 ? { input: 17_000, output: 0, cacheRead: 76_000, cacheWrite: 7_000 }
				: { input: 7_500, output: 0, cacheRead: 86_000, cacheWrite: 6_500 }
		: recent.at(-1) ?? null;
	const trend = sample ? [40, 73, 85, 87, 83, 88, 86, 91, 87, 89, 85, sample.rate] : recent.map((usage) => cacheHitPercent(usage) ?? 0);
	const reasonKey = latest ? ({ "new-write": "usageReasonWrite", "fresh-input": "usageReasonFresh", "no-read": "usageReasonNoRead", unknown: "usageReasonUnknown" } as const)[cacheObservation(latest)] : "usageReasonUnknown";
	const trendReasons = sample ? trend.map(() => reasonKey) : recent.map((usage) => ({ "new-write": "usageReasonWrite", "fresh-input": "usageReasonFresh", "no-read": "usageReasonNoRead", unknown: "usageReasonUnknown" } as const)[cacheObservation(usage)]);
	const partRows = parts ? [
		{ key: "system", label: t("usageSystemPart"), value: parts.system },
		{ key: "tools", label: t("usageToolsPart"), value: parts.tools },
		{ key: "conversation", label: t("usageConversationPart"), value: parts.conversation },
		{ key: "attachments", label: t("usageAttachmentsPart"), value: parts.attachments },
	] : [];
	return <div className="usage-control" ref={root} onPointerEnter={() => setOpen(true)} onPointerLeave={() => { if (!pinned.current) setOpen(false); }}>
		<button type="button" className={`usage-trigger${percent !== null && percent >= 80 ? " warn" : ""}`} aria-label={`${t("usageContextTitle")} ${percent ?? "—"}%`} aria-expanded={open} onPointerDown={() => { pinned.current = !pinned.current; setOpen(pinned.current); }} onClick={(event) => { if (event.detail === 0) { pinned.current = !pinned.current; setOpen(pinned.current); } }}>
			<span className="usage-ring" style={{ background: `conic-gradient(var(--usage-ring-color) ${shownPercent * 3.6}deg, var(--border-soft) 0)` }}><i /></span>
			<span className="usage-percent">{percent === null ? "—" : `${percent}%`}</span>
			<span className="usage-cache-short">│ {t("usageCacheTitle")} <strong className={sessionRate !== null && sessionRate < 50 ? "warn" : ""}>{sessionRate === null ? "—" : `${sessionRate}%`}</strong></span>
		</button>
		{open && <div className="usage-popover" role="dialog" aria-label={t("usageContextTitle")}>
			<div className="usage-head"><strong>{t("usageContextTitle")}</strong><span>{context?.tokens === null || context?.tokens === undefined ? "—" : formatTokens(context.tokens)} / {windowTokens ? formatTokens(windowTokens) : "—"}</span></div>
			{sample && <div className="usage-demo-notice">{t("usageDemoNotice")}</div>}
			<div className="usage-segments" role="img" aria-label={`${t("usageContextTitle")} ${percent ?? "—"}%`}>{partRows.map((part) => <i key={part.key} className={`usage-part ${part.key}`} style={{ width: `${windowTokens ? part.value / windowTokens * 100 : 0}%` }} />)}</div>
			{partRows.length > 0 && <><p className="usage-estimate-note">{t("usageEstimatedParts")}</p><div className="usage-part-list">{partRows.map((part) => <div key={part.key}><i className={`usage-dot ${part.key}`} /><span>{part.label}</span><strong>{formatTokens(part.value)}</strong></div>)}</div></>}
			<p className={`usage-state${percent !== null && percent >= 80 ? " warn" : ""}`}>{percent === null ? t("usageUnknown") : percent >= 80 ? t("usageNearLimit", { n: percent }) : t("usageComfort")}</p>
			<div className="usage-cache-section"><div className="usage-head"><strong>{t("usageCacheTitle")}</strong><span className={sessionRate !== null && sessionRate < 50 ? "warn" : ""}>{sessionRate === null ? "—" : `${sessionRate}%`}</span></div>
				{latest ? <div className="usage-cache-list"><div><span>{t("usageCacheRead")}</span><strong>{formatTokens(latest.cacheRead)}</strong></div><div><span>{t("usageCacheWrite")}</span><strong>{formatTokens(latest.cacheWrite)}</strong></div><div><span>{t("usageUncached")}</span><strong>{formatTokens(latest.input)}</strong></div><div><span>{t("usageSessionRate")}</span><strong>{sessionRate === null ? "—" : `${sessionRate}%`}</strong></div></div> : <p className="usage-no-data">{t("usageNoCacheData")}</p>}
				{trend.length > 0 && <><div className="usage-trend" aria-label={t("usageRecent", { n: trend.length })}>{trend.map((rate, index) => <i key={index} className={rate < 50 ? "low" : ""} style={{ height: `${Math.max(3, rate)}%` }} title={`${rate}% · ${rate < 50 ? t(trendReasons[index]) : t("usageSessionRate")}`} />)}</div><div className="usage-trend-caption"><span>{t("usageRecent", { n: trend.length })}</span>{trend.some((rate) => rate < 50) && <span>{t(trendReasons[trend.findLastIndex((rate) => rate < 50)])}</span>}</div></>}
			</div>
			<div className="usage-actions"><button type="button" className="usage-compact" disabled={!canCompact || !!sample} onClick={() => { onCompact(); setOpen(false); pinned.current = false; }}>{t("usageCompact")}</button><button type="button" className="usage-demo" onClick={() => setDemo((value) => value >= 2 ? -1 : value + 1)}>{t("usageDemo")}</button></div>
		</div>}
	</div>;
}
