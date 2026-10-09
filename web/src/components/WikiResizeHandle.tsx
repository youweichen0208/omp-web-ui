import { useRef, useState } from "react";
import { useT } from "../i18n";

type Side = "sidebar" | "chat";
const defaults = { sidebar: 250, chat: 400 };
const minimums = { sidebar: 180, chat: 280 };
const maximums = { sidebar: 480, chat: 720 };
const key = (side: Side) => `pi-wiki-${side}-width`;

export function useWikiPanelWidth(side: Side) {
	const [width, setWidth] = useState(() => {
		try { const saved = Number(localStorage.getItem(key(side))); if (saved >= minimums[side] && saved <= maximums[side]) return saved; } catch { /* Optional preference. */ }
		return defaults[side];
	});
	const resize = (value: number) => {
		const next = Math.max(minimums[side], Math.min(maximums[side], Math.round(value)));
		setWidth(next);
		try { localStorage.setItem(key(side), String(next)); } catch { /* Layout still works without storage. */ }
	};
	return [width, resize] as const;
}

export function WikiResizeHandle({ side, width, onResize }: { side: Side; width: number; onResize: (width: number) => void }) {
	const t = useT();
	const drag = useRef<{ x: number; width: number; max: number } | null>(null);
	return <div className={`wiki-resize-handle wiki-resize-${side}`} role="separator" tabIndex={0}
		aria-label={`${t(side === "sidebar" ? "wikiFiles" : "wikiChatPanel")} · ${t("dragToResize")}`} aria-orientation="vertical"
		aria-valuemin={minimums[side]} aria-valuemax={maximums[side]} aria-valuenow={width} title={t("dragToResize")}
		onDoubleClick={() => onResize(defaults[side])}
		onKeyDown={event => {
			if (event.key === "Home") { event.preventDefault(); onResize(defaults[side]); }
			if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				event.preventDefault(); onResize(width + (event.key === "ArrowRight" ? 10 : -10) * (side === "sidebar" ? 1 : -1));
			}
		}}
		onPointerDown={event => {
			if (event.button !== 0) return;
			event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
			const workbench = event.currentTarget.closest(".wiki-workbench")!;
			const available = workbench.getBoundingClientRect().width;
			const overlay = window.matchMedia("(max-width: 1099px)").matches;
			const other = workbench.querySelector(side === "sidebar" ? ".wiki-chat-panel" : ".wiki-sidebar")?.getBoundingClientRect().width ?? 0;
			const max = Math.max(minimums[side], Math.min(maximums[side], available - (overlay ? side === "chat" ? 24 : 280 : other + 280)));
			drag.current = { x: event.clientX, width: event.currentTarget.parentElement!.getBoundingClientRect().width, max };
		}}
		onPointerMove={event => { if (drag.current) onResize(Math.min(drag.current.max, drag.current.width + (event.clientX - drag.current.x) * (side === "sidebar" ? 1 : -1))); }}
		onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} />;
}
