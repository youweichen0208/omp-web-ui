import { WikiWidthIcon } from "./WikiIcons";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LuHeading2, LuHeading3 } from "react-icons/lu";
import { useT } from "../i18n";
export interface WikiInsertItem { id: string; label: string; hint: string; help: string; icon: ReactNode }
export interface WikiInsertPopup { kind: "table" | "code"; x: number; y: number }
export function WikiInsertPopover({ popup, onClose, children }: { popup: WikiInsertPopup; onClose: () => void; children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.left = `${Math.max(8, Math.min(popup.x, innerWidth - el.offsetWidth - 8))}px`;
		el.style.top = `${Math.max(8, Math.min(popup.y, innerHeight - el.offsetHeight - 8))}px`;
		el.querySelector<HTMLElement>('input, [tabindex="0"], button')?.focus();
	}, [popup]);
	useEffect(() => {
		const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
		window.addEventListener("pointerdown", outside); window.addEventListener("resize", onClose);
		return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("resize", onClose); };
	}, [onClose]);
	return createPortal(<div ref={ref} className={`wiki-insert-popover wiki-${popup.kind}-popover`} role="dialog" onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }} style={{ left: popup.x, top: popup.y }}>{children}</div>, document.body);
}
export function WikiToolbar({ readOnly, focused, onWidth, items, popup, onPrepare, onSelect, onPopup }: { readOnly: boolean; focused: boolean; onWidth: () => void; items: WikiInsertItem[]; popup: WikiInsertPopup | null; onPrepare: () => void; onSelect: (id: string) => void; onPopup: (popup: WikiInsertPopup) => void }) {
	const t = useT();
	const groups = [items.slice(0, 3), items.slice(3, 9), items.slice(9)];
	const pick = (kind: WikiInsertPopup["kind"], button: HTMLElement) => { const r = button.getBoundingClientRect(); onPopup({ kind, x: r.left, y: r.bottom + 6 }); };
	return <div className="wiki-insert-toolbar" role="toolbar" aria-label={t("richInsertMenu")}>
		{groups.map((group, index) => <div className="wiki-tool-group" key={index}>{group.map(item => {
			const { id } = item;
			const icon = id === "bt2" ? <LuHeading2 /> : id === "bt3" ? <LuHeading3 /> : item.icon;
			const kind = id === 'bg' ? 'table' : id === 'dmk' ? 'code' : undefined;
			return <button type="button" key={id} disabled={readOnly} title={`${item.label} · ${item.help}${item.hint ? ` · ${item.hint}` : ''}`} aria-label={item.label} aria-expanded={kind ? popup?.kind === kind : undefined} onMouseDown={e => { e.preventDefault(); onPrepare(); }} onClick={e => kind ? pick(kind, e.currentTarget) : onSelect(id)}>{icon}</button>;
		})}</div>)}
		<button type="button" className="wiki-width-toggle" title={t(focused ? "wikiStandardWidth" : "wikiWideWidth")} aria-label={t(focused ? "wikiStandardWidth" : "wikiWideWidth")} aria-pressed={focused} onMouseDown={e => e.preventDefault()} onClick={onWidth}><WikiWidthIcon /></button>
	</div>;
}
