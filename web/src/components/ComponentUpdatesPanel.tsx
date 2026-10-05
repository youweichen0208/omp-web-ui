import { useT } from "../i18n";
import { ExtensionsPanel } from "./ExtensionsPanel";
import type { ServerMessage } from "../types";

type Report = Extract<ServerMessage, { type: "component_updates" }>;
interface ComponentUpdatesPanelProps {
	cwd: string;
	updates: Report | null;
	reload: () => void;
	onUpdateCount: (count: number) => void;
}
export function ComponentUpdatesPanel({ cwd, updates, reload, onUpdateCount }: ComponentUpdatesPanelProps) {
	const t = useT();
	return <ExtensionsPanel key={cwd} cwd={cwd} mode="updates" reload={reload} onUpdateCount={onUpdateCount}>
		<div className="settings-group">{updates?.items.filter(item => item.id === "builtin:agent").map(item => <div className="settings-list-row" key={item.id}>
			<span>Pi<small className="settings-description">{t("v2PiHint")}</small></span>
			<span className="component-version">{item.current ?? "—"}</span><span className="settings-readonly">{t("settingsBundled")}</span>
		</div>)}</div>
	</ExtensionsPanel>;
}
