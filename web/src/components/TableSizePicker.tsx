import { useState } from "react";
import { useT } from "../i18n";
export function TableSizePicker({ onInsert }: { onInsert: (columns: number, rows: number) => void }) {
	const t = useT();
	const [size, setSize] = useState({ columns: 3, rows: 3 });
	return <div className="wiki-table-picker" tabIndex={0} role="group" aria-label={t("wikiTableSize")} onKeyDown={e => {
		if (e.key === "Enter") { e.preventDefault(); onInsert(size.columns, size.rows); }
		if (e.key.startsWith("Arrow")) { e.preventDefault(); setSize(s => ({ columns: Math.max(1, Math.min(8, s.columns + (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0))), rows: Math.max(1, Math.min(6, s.rows + (e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0))) })); }
	}}><div className="wiki-table-grid">{Array.from({ length: 48 }, (_, index) => {
		const columns = index % 8 + 1, rows = Math.floor(index / 8) + 1;
		return <button type="button" tabIndex={-1} key={index} aria-label={t("wikiTableDimensions", { columns, rows })} className={columns <= size.columns && rows <= size.rows ? "selected" : ""} onMouseEnter={() => setSize({ columns, rows })} onClick={() => onInsert(columns, rows)} />;
	})}</div><footer><span aria-live="polite">{t("wikiTableDimensions", size)}</span><small>{t("wikiTableHeader")}</small></footer></div>;
}
