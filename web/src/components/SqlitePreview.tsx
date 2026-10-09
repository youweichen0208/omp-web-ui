import { UiIcon } from "./UiIcon";
import { memo, useEffect, useState } from "react";
import { useT } from "../i18n";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import { randomUuid } from "../uuid";
import type { SqlitePreviewData, SqlitePreviewResponse } from "../types";

export const SqlitePreview = memo(function SqlitePreview({ file, disabled }: {
	file: { cwd: string; path: string };
	disabled: boolean;
}) {
	const t = useT();
	const [query, setQuery] = useState<{ table?: string; offset: number }>({ offset: 0 });
	const [revision, setRevision] = useState(0);
	const [data, setData] = useState<SqlitePreviewData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		if (disabled) { setLoading(false); return; }
		const controller = new AbortController();
		const requestId = randomUuid();
		setLoading(true);
		setError("");
		setData(null);
		const params = new URLSearchParams({ clientId: getClientId(), cwd: file.cwd, path: file.path, requestId, offset: String(query.offset) });
		if (query.table !== undefined) params.set("table", query.table);
		void (async () => {
			try {
				const response = await fetch(withToken("/api/sqlite?" + params), { signal: controller.signal });
				const result: SqlitePreviewResponse = await response.json();
				if (controller.signal.aborted) return;
				if (!response.ok || result.error) throw new Error(result.error || t("dbLoadFailed"));
				if (result.requestId !== requestId || result.cwd !== file.cwd || result.path !== file.path || !result.data) throw new Error(t("dbLoadFailed"));
				setData(result.data);
			} catch (reason) {
				if (!controller.signal.aborted) setError((reason as Error).message);
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		})();
		return () => controller.abort();
	}, [file.cwd, file.path, query.table, query.offset, revision, disabled, t]);
	const unavailable = loading || disabled;
	return <section className="sqlite-preview" aria-label={t("dbViewer")}>
		<div className="sqlite-toolbar">
			<span className="sqlite-label">SQLite · {t("dbReadOnly")}</span>
			<button type="button" className="btn" disabled={unavailable} onClick={() => { setQuery({ offset: 0 }); setRevision((value) => value + 1); }}>{t("dbRefresh")}</button>
		</div>
		{disabled && <div className="fp-notice">{t("dbUnavailable")}</div>}
		{loading && <div className="fp-empty" role="status">{t("loading")}</div>}
		{error && <div className="fp-notice" role="alert">{t("dbLoadFailed")} {error}</div>}
		{data && <>
			{data.tables.length ? <label className="sqlite-table-picker">
				<span>{t("dbTable")}</span>
				<select aria-label={t("dbTable")} disabled={unavailable} value={data.table ?? ""} onChange={(event) => setQuery({ table: event.target.value, offset: 0 })}>
					{data.tables.map((table) => <option key={table.name} value={table.name}>{table.name}{table.type === "view" ? " · " + t("dbView") : ""}</option>)}
				</select>
			</label> : <div className="fp-empty">{t("dbNoTables")}</div>}
			{(data.columnsTruncated || data.tablesTruncated) && <div className="fp-notice">{t("dbStructureLimited")}</div>}
			{data.queryError && <div className="fp-notice" role="alert">{t("dbLoadFailed")} {data.queryError}</div>}
			{data.table !== null && <>
				<div className="sqlite-grid-wrap" tabIndex={0} aria-label={t("dbRows")}>
					<table className="sqlite-grid">
						<thead><tr><th scope="col">#</th>{data.columns.map((column) => <th scope="col" key={column.name}>
							<span>{column.name}{column.primaryKey ? <UiIcon name="key" /> : ""}</span><small>{column.type || "—"}</small>
						</th>)}</tr></thead>
						<tbody>{data.rows.map((row, index) => <tr key={data.offset + index}>
							<th scope="row">{data.offset + index + 1}</th>
							{row.map((cell, column) => <td key={column} className={cell.kind === "null" || cell.kind === "blob" ? "sqlite-special" : ""}>
								<span title={cell.kind === "text" ? cell.value : undefined}>{cell.kind === "null" ? "NULL" : cell.kind === "blob" ? `BLOB · ${cell.value} B` : cell.value}{cell.truncated ? "…" : ""}</span>
							</td>)}
						</tr>)}</tbody>
					</table>
					{!data.rows.length && <div className="fp-empty">{t("dbNoRows")}</div>}
				</div>
				<div className="sqlite-pagination">
					<button className="btn" disabled={unavailable || data.offset === 0} onClick={() => setQuery({ table: data.table!, offset: Math.max(0, data.offset - data.pageSize) })}>{t("dbPrevious")}</button>
					<span>{t("dbRowRange", { start: data.rows.length ? data.offset + 1 : 0, end: data.offset + data.rows.length })}</span>
					<button className="btn" disabled={unavailable || !data.hasMore} onClick={() => setQuery({ table: data.table!, offset: data.offset + data.pageSize })}>{t("dbNext")}</button>
				</div>
				<div className="sqlite-hint">{t("dbCellLimit")}</div>
				<details className="sqlite-schema"><summary>{t("dbSchema")}</summary><pre>{data.schema}</pre></details>
			</>}
		</>}
	</section>;
});
