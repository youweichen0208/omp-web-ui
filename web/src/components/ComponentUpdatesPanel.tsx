import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { desktopAPI, type AppUpdateState } from "../desktop";
import { randomUuid } from "../uuid";
import type { ClientMessage, ServerMessage, TerminalInfo } from "../types";

type Report = Extract<ServerMessage, { type: "component_updates" }>;
type AppStatus = Omit<Extract<ServerMessage, { type: "update_status" }>, "type">;
interface ComponentUpdatesPanelProps {
	ready: boolean;
	cwd: string;
	conversationId: string;
	updates: Report | null;
	appStatus?: AppStatus | null;
	send: (message: ClientMessage) => boolean;
	terminal: { create: (meta: TerminalInfo & { conversationId: string }) => void };
	onTerminal: () => void;
}

export function ComponentUpdatesPanel({ ready, cwd, conversationId, updates, appStatus, send, terminal, onTerminal }: ComponentUpdatesPanelProps) {
	const t = useT();
	const [desktop, setDesktop] = useState<AppUpdateState>();
	const [error, setError] = useState("");
	const isDesktop = !!desktopAPI;
	useEffect(() => {
		let alive = true;
		const off = desktopAPI?.onAppUpdate?.(state => { if (alive) setDesktop(state); });
		if (isDesktop) {
			void desktopAPI?.appUpdate?.("read")
				.then(state => { if (alive) setDesktop(state); })
				.catch(e => { if (alive) setError(e.message); });
		} else {
			send({ type: "check_update" });
		}
		return () => { alive = false; off?.(); };
	}, [send]);

	async function desktopAction(action: "check" | "update" | "install") {
		if (!desktopAPI?.appUpdate) return;
		setError("");
		try { setDesktop(await desktopAPI.appUpdate(action)); }
		catch (e) { setError((e as Error).message); }
	}
	const checking = updates?.phase === "checking" || updates?.phase === "updating";
	const appBusy = desktop?.phase === "checking" || desktop?.phase === "downloading";
	function check() {
		send({ type: "check_component_updates", requestId: randomUuid() });
		if (isDesktop) void desktopAction("check");
		else send({ type: "check_update" });
	}
	function updateApp() {
		if (isDesktop) {
			void desktopAction(desktop?.phase === "downloaded" ? "install" : "update");
			return;
		}
		if (!ready || !conversationId || !appStatus?.latest || appStatus.upToDate || appStatus.error) return;
		// Only use a registry version as an argument to this fixed package command.
		if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(appStatus.latest)) return;
		terminal.create({
			id: randomUuid(), conversationId, title: t("componentApp"), cwd,
			cols: 100, rows: 26, running: true, exitCode: null,
			command: { name: t("componentApp"), command: `npm install -g @youweichen/pi-web-ui@${appStatus.latest}`, cwd: "${pwd}" },
		});
		onTerminal();
	}
	const appDisabled = isDesktop
		? !desktopAPI?.appUpdate || !desktop || desktop.phase === "unsupported" || appBusy
		: !ready || !conversationId || !appStatus?.latest || appStatus.upToDate || !!appStatus.error;
	const current = isDesktop ? desktop?.current : appStatus?.current;
	const latest = isDesktop ? desktop?.latest : appStatus?.latest;
	const appHint = !isDesktop ? "componentWebUpdateHint"
		: desktop?.phase === "unsupported" || !desktopAPI?.appUpdate ? "componentDesktopUnsupported"
		: desktop?.phase === "current" ? "componentCurrent" : "componentAppHint";
	const appError = error || desktop?.error || (!isDesktop && appStatus?.error);

	return <section className="component-updates-panel">
		<header className="settings-page-heading">
			<h2 className="settings-page-title">{t("componentUpdates")}</h2>
			<button disabled={!ready || checking || appBusy} onClick={check}>{t(checking || appBusy ? "componentChecking" : "componentCheck")}</button>
		</header>
		<div className="settings-group"><div className="set-row component-update-row">
			<strong>pi-web-ui</strong><span className="component-version" title={t(appHint)}>{current ?? "—"}{latest && latest !== current && (isDesktop || !appStatus?.upToDate) ? ` → ${latest}` : ` · ${t(desktop?.phase === "current" || !isDesktop && appStatus?.upToDate ? "componentCurrent" : "componentUnknown")}`}{desktop?.phase === "downloading" && <small role="status"> {t("componentDownloading", { n: desktop.percent ?? 0 })}</small>}</span>
			<button className="settings-primary" disabled={appDisabled} onClick={updateApp}>{t(desktop?.phase === "downloaded" ? "componentRestartInstall" : "componentAutoUpdate")}</button>
		</div></div>
		{appError && <p role="alert" className="settings-error">{appError}</p>}
		{updates?.phase === "updating" && <p role="status">{t("componentInstalling")}</p>}
		{updates?.restartRequired && <p role="status">{t("componentRestart")}</p>}
		{updates?.error && <p role="alert" className="settings-error">{updates.error}</p>}
		<div className="settings-group">{updates?.items.map(item => <div className="set-row component-update-row" key={item.id}>
			<strong>{item.name}</strong><span className="component-version" title={item.kind === "bundled" ? t("componentBundledHint") : undefined}>{item.current ?? "—"}{item.latest && item.latest !== item.current ? ` → ${item.latest}` : ""}<small> · {t(item.kind === "local" ? "componentLocal" : item.kind === "bundled" ? "settingsBundled"
				: item.status === "available" ? "componentNewVersion" : item.status === "error" ? "componentCheckFailed"
				: item.status === "pinned" ? "componentPinned" : item.status === "current" ? "componentCurrent" : "componentUnknown")}</small></span>
			{item.canUpdate ? <button disabled={!ready || checking} onClick={() => send({ type: "update_component", requestId: randomUuid(), id: item.id })}>{t("componentInstall")}</button> : <span className="settings-readonly">—</span>}
		</div>)}</div>
	</section>;
}
