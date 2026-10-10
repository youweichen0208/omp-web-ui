import { isTopDialog, useDialogFocus } from "../use-dialog-focus";
import { ComponentUpdatesPanel } from "./ComponentUpdatesPanel";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { useState, useEffect } from "react";
import { FiX, FiSettings, FiCpu, FiPackage, FiBox, FiRefreshCw } from "react-icons/fi";
import { useT } from "../i18n";
import type { ClientMessage, ServerMessage, UiSettingsState } from "../types";
import { NativeMcpPanel } from "./NativeMcpPanel";
import { SkillsPanel } from "./SkillsPanel";
import { randomUuid } from "../uuid";

type Tab = "prompt" | "skills" | "extensions" | "native-mcp" | "updates";
interface SettingsModalProps {
	initialTab?: Tab;
	chat: {
		ready: boolean;
		settings: UiSettingsState | null;
		state?: { cwd: string; conversationId: string; planSettings?: import("../types").PlanSettingsState; tree?: import("../types").UiTreeState } | null;
		dialog: { id: string; conversationId: string; kind: "select" | "confirm" | "input" | "editor"; title: string; args: unknown[] } | null;
		update?: Omit<Extract<ServerMessage, { type: "update_status" }>, "type"> | null;
		componentUpdates: Extract<ServerMessage, { type: "component_updates" }> | null;
	};
	send: (message: ClientMessage) => boolean;
	onClose: () => void;
}

export function SettingsModal({ chat, send, onClose, initialTab = "prompt" }: SettingsModalProps) {
	const t = useT();
	const dialogRef = useDialogFocus();
	const [extensionUpdates,setExtensionUpdates]=useState(0);
	const canLeave=()=>!document.querySelector('.ext-editor[data-dirty="true"], .prompt-editor[data-dirty="true"], .mcp-workbench[data-dirty="true"]')||window.confirm(t("extDiscard"));
	const close=()=>{if(canLeave())onClose();};
	useEffect(() => { const handle = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && isTopDialog(dialogRef.current)) close(); }; window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle); }, [onClose]);
	const [tab, setTab] = useState<Tab>(initialTab);
	const settings = chat.settings;
	useEffect(() => { if (tab === "updates" && chat.ready) send({ type: "check_component_updates", requestId: randomUuid() }); }, [tab, chat.ready, chat.state?.cwd, send]);
	const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
		{ id: "prompt", label: t("settingsSystemPrompt"), icon: <FiSettings /> },
		{ id: "skills", label: t("settingsSkills"), icon: <FiCpu /> },
		{ id: "extensions", label: t("settingsExtensions"), icon: <FiPackage /> },
		{ id: "native-mcp", label: t("nativeMcp"), icon: <FiBox /> },
		{ id: "updates", label: t("componentUpdates"), icon: <FiRefreshCw /> },
	];
	const updates = chat.componentUpdates?.cwd === chat.state?.cwd ? chat.componentUpdates : null;
	return <div className="modal-backdrop" onClick={close}>
		<div className="modal settings-modal" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("settingsTitle")} onClick={event => event.stopPropagation()}>
			<div className="modal-head"><button className="icon-btn" aria-label={t("close")} onClick={close}><FiX /></button></div>
			<div className="settings-layout">
				<nav className="settings-rail" aria-label={t("settingsTitle")}><h2>{t("settingsTitle")}</h2>{tabs.map(item => <button key={item.id} title={item.label} aria-current={tab === item.id ? "page" : undefined} className={`settings-tab${tab === item.id ? " active" : ""}`} onClick={() => { if(canLeave())setTab(item.id); }}><span className="settings-tab-icon">{item.icon}</span><span className="settings-tab-label">{item.label}{item.id === "updates" && extensionUpdates > 0 && <span className="ext-rail-badge">{extensionUpdates}</span>}</span></button>)}</nav>
				<div className="modal-body"><div className="set-section">
					{!settings ? <p>{t("loading")}</p> : <>
						<label className="tree-edit-preference"><input type="checkbox" checked={settings.editResendNewSession ?? false} onChange={event => send({ type: "set_settings", editResendNewSession: event.target.checked })} />{t("treeEditNewSession")}</label>
						{chat.state?.planSettings && <div className="plan-settings">
							<label><input type="checkbox" checked={chat.state.planSettings.enabled} disabled={!chat.ready} onChange={event => send({ type: "set_plan_enabled", conversationId: chat.state!.conversationId, enabled: event.target.checked })} />{t("planEnabled")}</label>
							<p>{t("planEnabledHint")}</p>
							{!chat.state.planSettings.available ? <p>{t(chat.state.planSettings.reason === "conflict" ? "planConflict" : "planMissing")}</p> : chat.state.planSettings.pending ? <p>{t("planPending")}</p> : null}
						</div>}
						{tab === "prompt" && chat.state && <SystemPromptPanel key={`${chat.state.cwd}:${chat.state.conversationId}`} cwd={chat.state.cwd} conversationId={chat.state.conversationId} />}
						{tab === "skills" && chat.state && <SkillsPanel key={chat.state.cwd} cwd={chat.state.cwd} reload={() => send({ type: "extensions_reload" })} />}
						{tab === "extensions" && chat.state?.cwd && <ExtensionsPanel key={chat.state.cwd} cwd={chat.state.cwd} onUpdateCount={setExtensionUpdates} reload={() => send({ type: "extensions_reload" })} />}
						{tab === "native-mcp" && chat.state?.cwd && <NativeMcpPanel key={`${chat.state.cwd}:${chat.state.conversationId}`} cwd={chat.state.cwd} send={send} dialog={chat.dialog} />}
						{tab === "updates" && <ComponentUpdatesPanel cwd={chat.state?.cwd ?? ""} updates={updates} onUpdateCount={setExtensionUpdates} reload={() => send({ type: "extensions_reload" })} />}
					</>}
				</div></div>
			</div>
		</div>
	</div>;
}
