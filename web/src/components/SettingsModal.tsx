import { useState, useEffect } from "react";
import { FiX, FiSettings, FiCpu, FiPackage, FiBox, FiEye, FiRefreshCw } from "react-icons/fi";
import { useT } from "../i18n";
import type { ClientMessage, ServerMessage, UiSettingsState, UiPluginInfo } from "../types";
import { NativeMcpPanel } from "./NativeMcpPanel";
import { getCodeTheme, setCodeTheme, type CodeTheme } from "../code-appearance";
import { randomUuid } from "../uuid";

type Tab = "display" | "prompt" | "skills" | "extensions" | "native-mcp" | "updates" | "plugins";
interface SettingsModalProps {
	chat: {
		ready: boolean;
		settings: UiSettingsState | null;
		plugins: UiPluginInfo[];
		state?: { cwd: string; conversationId: string } | null;
		dialog: { id: number; kind: "select" | "confirm" | "input"; title: string; args: unknown[] } | null;
		componentUpdates: Extract<ServerMessage, { type: "component_updates" }> | null;
	};
	send: (message: ClientMessage) => boolean;
	terminal: unknown;
	onSwitchToTerminal: () => void;
	onClose: () => void;
}

export function SettingsModal({ chat, send, onClose }: SettingsModalProps) {
	const t = useT();
	useEffect(() => { const handle = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle); }, [onClose]);
	const [tab, setTab] = useState<Tab>("display");
	const [theme, updateTheme] = useState<CodeTheme>(getCodeTheme);
	const settings = chat.settings;
	useEffect(() => { if (tab === "updates" && chat.ready) send({ type: "check_component_updates", requestId: randomUuid() }); }, [tab, chat.ready, chat.state?.cwd, send]);
	const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
		{ id: "display", label: t("settingsMessageDisplay"), icon: <FiEye /> },
		{ id: "prompt", label: t("settingsSystemPrompt"), icon: <FiSettings /> },
		{ id: "skills", label: t("settingsSkills"), icon: <FiCpu /> },
		{ id: "extensions", label: t("settingsExtensions"), icon: <FiPackage /> },
		{ id: "native-mcp", label: t("nativeMcp"), icon: <FiBox /> },
		{ id: "updates", label: t("componentUpdates"), icon: <FiRefreshCw /> },
		{ id: "plugins", label: t("settingsUiPlugins"), icon: <FiBox /> },
	];
	const patch = (value: Pick<Extract<ClientMessage, { type: "set_settings" }>, "thinkingWrap" | "toolsWrap" | "disabledPlugins">) => send({ type: "set_settings", ...value });
	const updates = chat.componentUpdates?.cwd === chat.state?.cwd ? chat.componentUpdates : null;
	return <div className="modal-backdrop" onClick={onClose}>
		<div className="modal settings-modal" role="dialog" aria-modal="true" aria-label={t("settingsTitle")} onClick={event => event.stopPropagation()}>
			<div className="modal-head"><h2>{t("settingsTitle")}</h2><button className="icon-btn" aria-label={t("close")} onClick={onClose}><FiX /></button></div>
			<div className="settings-layout">
				<nav className="settings-rail" aria-label={t("settingsTitle")}>{tabs.map(item => <button key={item.id} title={item.label} className={`settings-tab${tab === item.id ? " active" : ""}`} onClick={() => setTab(item.id)}><span className="settings-tab-icon">{item.icon}</span><span className="settings-tab-label">{item.label}</span></button>)}</nav>
				<div className="modal-body"><div className="set-section">
					{!settings ? <p>{t("loading")}</p> : <>
						{tab === "display" && <>
							<label className="set-row"><span>{t("thinkingWrap")}</span><input type="checkbox" checked={settings.thinkingWrap} onChange={event => patch({ thinkingWrap: event.target.checked })} /></label>
							<label className="set-row"><span>{t("toolsWrap")}</span><input type="checkbox" checked={settings.toolsWrap} onChange={event => patch({ toolsWrap: event.target.checked })} /></label>
							<label className="set-row"><span>{t("settingsCodeTheme")}</span><select value={theme} onChange={event => { const value = event.target.value as CodeTheme; updateTheme(value); setCodeTheme(value); }}><option value="light">{t("codeThemeLight")}</option><option value="dark">{t("codeThemeDark")}</option><option value="system">{t("codeThemeSystem")}</option></select></label>
						</>}
						{tab === "prompt" && <><p>{t("nativeContextOnly")}</p><pre className="set-prompt-preview">{settings.effectiveSystemPrompt}</pre></>}
						{tab === "skills" && <><p>{t("nativeResourcesManaged")}</p>{settings.skills.map(skill => <div className="set-row" key={skill.name}><div><strong>{skill.name}</strong><p>{skill.description}</p></div></div>)}</>}
						{tab === "extensions" && <><p>{t("nativeResourcesManaged")}</p>{settings.extensions.map(extension => <div className="set-row" key={extension.id}><div><strong>{extension.name}</strong><p>{extension.path}</p></div></div>)}</>}
						{tab === "native-mcp" && chat.state?.cwd && <NativeMcpPanel cwd={chat.state.cwd} send={send} dialog={chat.dialog} />}
						{tab === "updates" && <><button disabled={!chat.ready || updates?.phase === "checking"} onClick={() => send({ type: "check_component_updates", requestId: randomUuid() })}>{t("componentCheck")}</button>{updates?.restartRequired && <p role="status">{t("componentRestart")}</p>}{updates?.error && <p role="alert">{updates.error}</p>}{updates?.items.map(item => <div className="set-row component-update-row" key={item.id}><div><strong>{item.name}</strong><p>{item.current ?? "—"} → {item.latest ?? "—"}</p><p>{t(item.status === "available" ? "componentNewVersion" : item.status === "error" ? "componentCheckFailed" : item.status === "pinned" ? "componentPinned" : item.status === "current" ? "componentCurrent" : "componentUnknown")}</p></div>{item.status === "available" && item.kind !== "bundled" && <button disabled={updates.phase === "updating"} onClick={() => send({ type: "update_component", requestId: randomUuid(), id: item.id })}>{t("componentInstall")}</button>}</div>)}</>}
						{tab === "plugins" && chat.plugins.map(plugin => <label className="set-row" key={plugin.id}><span>{plugin.name}</span><input type="checkbox" checked={!settings.disabledPlugins.includes(plugin.id)} onChange={event => patch({ disabledPlugins: event.target.checked ? settings.disabledPlugins.filter(id => id !== plugin.id) : [...settings.disabledPlugins, plugin.id] })} /></label>)}
					</>}
				</div></div>
			</div>
		</div>
	</div>;
}
