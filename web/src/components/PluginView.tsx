import { useT } from "../i18n";
import { useEffect, useRef, useState } from "react";
import {
	makePluginContext,
	type LoadedPluginView,
} from "../plugin-loader";

interface PluginViewProps {
	entry: LoadedPluginView;
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => boolean;
}

/**
 * 插件视图宿主：一个薄 React 壳，把 DOM 容器 + 窄上下文交给插件的
 * mount()。切走时容器整体 display:none（不卸载，插件内部状态保留）；
 * 插件被移除/失败时才真正清理。
 */
export function PluginView({ entry, send }: PluginViewProps) {
	const ref = useRef<HTMLDivElement>(null);
	const t = useT();
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		let cleanup: void | (() => void);
		setFailed(false);
		try {
			cleanup = entry.module.mount(
				el,
				makePluginContext(entry.info.id, (msg) => send(msg)),
			);
		} catch (err) {
			console.error(`[plugin:${entry.info.id}] mount failed:`, err);
			el.textContent = "";
			setFailed(true);
		}
		return () => {
			if (typeof cleanup === "function") {
				try {
					cleanup();
				} catch (err) {
					console.error(`[plugin:${entry.info.id}] cleanup failed:`, err);
				}
			}
			el.textContent = "";
		};
	}, [entry, send, attempt]);
	return <div className="plugin-view-host">{failed && <div className="plugin-view-error" role="alert"><p>{t("pluginViewFailed", { name: entry.info.name })}</p><button type="button" className="btn" onClick={() => setAttempt(value => value + 1)}>{t("retry")}</button></div>}<div className="plugin-view" ref={ref} hidden={failed} /></div>;
}
