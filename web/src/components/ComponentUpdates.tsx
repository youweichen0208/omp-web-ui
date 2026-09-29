import { useEffect, useState } from "react";
import type { ClientMessage, ComponentUpdate, ServerMessage } from "../types";
import { useT } from "../i18n";
import { randomUuid } from "../uuid";

type Report = Extract<ServerMessage, { type: "component_updates" }>;
export function ComponentUpdates({ report, cwd, ready, send }: { report: Report | null; cwd: string; ready: boolean; send: (message: ClientMessage) => unknown }) {
	const t = useT();
	const [offline, setOffline] = useState(false);
	const current = report?.cwd === cwd ? report : null;
	const busy = current?.phase === "checking" || current?.phase === "updating";
	const check = () => { setOffline(false); if (send({ type: "check_component_updates", requestId: randomUuid() }) === false) setOffline(true); };
	useEffect(() => { if (ready) { setOffline(false); send({ type: "check_component_updates", requestId: randomUuid() }); } }, [cwd, ready, send]);
	const statuses: Record<ComponentUpdate["status"], string> = { available: t("componentNewVersion"), current: t("componentCurrent"), pinned: t("componentPinned"), manual: t("componentManual"), unknown: t("componentUnknown"), error: t("componentCheckFailed") };
	return <div className="set-section component-updates">
		<div className="set-section-title">{t("componentUpdates")}<button type="button" className="btn" disabled={!ready || busy} onClick={check}>{current?.phase === "checking" ? t("componentChecking") : t("componentCheck")}</button></div>
		<p className="set-hint">{t("componentUpdateIntro")}</p>
		{(!ready || offline) && <p role="status">{t("componentOffline")}</p>}
		{current?.phase === "updating" && <p role="status">{t("componentInstalling")}</p>}
		{current?.restartRequired && <p className="component-update-notice" role="status">{t("componentRestart")}</p>}
		{current?.error && <p className="component-update-error" role="alert">{current.error}</p>}
		<div className="set-list">{current?.items.map((item) => <div className="set-row component-update-row" key={item.id}>
			<div className="set-row-info"><div className="set-row-name">{item.name}{item.kind === "bundled" && <span className="component-update-tag">{t("componentBundled")}</span>}{item.scope && <span className="component-update-tag">{t(item.scope === "project" ? "componentProject" : "componentUser")}</span>}</div>
				<div className="set-row-desc">{t("componentInstalled")} {item.current ?? "—"}{item.latest && item.latest !== item.current && <> → {item.latest}</>}</div>
				<div className={`component-update-state ${item.status}`}>{statuses[item.status]}</div>
				{item.kind === "bundled" && <div className="set-row-desc">{t("componentBundledHint")}</div>}
				{item.error && <div className="component-update-error">{item.error}</div>}
			</div>
			{item.canUpdate && <button type="button" className="btn" disabled={!ready || busy} onClick={() => send({ type: "update_component", requestId: randomUuid(), id: item.id })}>{t("componentInstall")}</button>}
		</div>)}</div>
	</div>;
}
