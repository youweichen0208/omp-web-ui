import { useEffect, useMemo, useState } from "react";
import { FiChevronRight, FiMoreHorizontal } from "react-icons/fi";
import type { UiToolCallBlock } from "../types";
import { useT } from "../i18n";
import { editWriteChange, type ChangeLine, type EditWriteChange } from "../edit-write-presentation";
import { highlightLine, langFromPath } from "../hljs-lite";
import type { ToolView } from "./ToolCallBlock";

type Item = { block: UiToolCallBlock; view: ToolView };

function status(item: Item) {
	const error = item.view.result?.isError || item.view.status?.isError;
	return error ? "err" : item.view.result || item.view.status ? "done" : item.view.streaming ? "running" : "pending";
}

function Lines({ lines, path }: { lines: ChangeLine[]; path: string }) {
	const lang = langFromPath(path);
	return <div className="change-lines">{lines.map((line, index) => <div key={index} className={`change-line ${line.marker === "+" ? "add" : line.marker === "-" ? "del" : "context"}`}><span className="change-old">{line.oldLine ?? ""}</span><span className="change-new">{line.newLine ?? ""}</span><span className="change-marker">{line.marker === "-" ? "−" : line.marker}</span><code className="hljs" dangerouslySetInnerHTML={{ __html: highlightLine(line.text, lang) || "&#8203;" }} /></div>)}</div>;
}

function ChangeBody({ change }: { change: EditWriteChange }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const allLines = change.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
	let remaining = expanded ? Infinity : 12;
	return <div className="change-card-body">
		{change.error && <div className="change-error">{change.errorText.split("\n").find((line) => line.trim()) || t("changeFailed")}</div>}
		{change.empty ? <div className="change-empty">{change.error ? t("changeNoOriginal") : change.kind === "write" ? `${t("emptyFile")} (${change.path.split("/").at(-1)})` : t("changeNoDiff")}</div> : change.hunks.map((hunk, index) => {
			if (remaining <= 0) return null;
			const visible = hunk.lines.slice(0, remaining);
			remaining -= visible.length;
			return <div className="change-hunk" key={index}><div className="change-hunk-head">{change.error ? change.kind === "write" ? t("changeAttemptedWrite") : t("changeOriginal") : change.kind === "write" ? t("changeWrittenLines", { n: change.added }) : change.fromArguments ? t("changeReplacement") : t("changeAtLine", { n: hunk.line })}{hunk.functionName && <span> · {hunk.functionName}</span>}</div><Lines lines={visible} path={change.path} /></div>;
		})}
		{allLines > 12 && <button type="button" className="change-more" onClick={() => setExpanded((value) => !value)}>{expanded ? t("collapseCode") : t("expandRemainingLines", { n: allLines - 12 })}</button>}
	</div>;
}

export function EditWriteCard({ item, compact = false, retried = false }: { item: Item; compact?: boolean; retried?: boolean }) {
	const t = useT();
	const change = useMemo(() => editWriteChange(item.block, item.view.result), [item.block, item.view.result]);
	const [open, setOpen] = useState(!compact && !retried);
	useEffect(() => { if (retried) setOpen(false); }, [retried]);
	useEffect(() => { if (change?.kind === "edit" && change.empty && !change.error && item.view.result) setOpen(false); }, [change, item.view.result]);
	useEffect(() => {
		const onJump = (event: Event) => {
			if ((event as CustomEvent<{ toolCallId?: string }>).detail?.toolCallId === item.block.id) setOpen(true);
		};
		window.addEventListener("pi:jump-tool", onJump);
		return () => window.removeEventListener("pi:jump-tool", onJump);
	}, [item.block.id]);
	if (!change) return null;
	const state = retried ? "retried" : status(item);
	const noDiff = change.kind === "edit" && change.empty && !change.error && state === "done";
	const path = change.path || item.block.name;
	const openFile = () => window.dispatchEvent(new CustomEvent("pi-web-ui:open-tool-file", { detail: { path: change.path, ...(change.fromArguments ? {} : { line: change.firstChangedLine }) } }));
	return <div className={`change-card ${state}`} data-tool-call-id={item.block.id} onMouseEnter={() => window.dispatchEvent(new CustomEvent("pi:tool-hover", { detail: { toolCallId: item.block.id } }))} onMouseLeave={() => window.dispatchEvent(new CustomEvent("pi:tool-hover", { detail: { toolCallId: null } }))}>
		<div className="change-card-head">
			<button type="button" className="change-card-toggle" aria-expanded={open && !noDiff} disabled={noDiff} onClick={() => setOpen((value) => !value)}>{!noDiff && <FiChevronRight className={open ? "open" : ""} />}<span className="change-verb">{item.block.name === "edit" ? t("changeEdit") : t("changeWrite")}</span><code title={path}>{path}</code></button>
			<span className="change-counts">{!change.error && <>{change.added > 0 && <span className="add">+{change.added}</span>}{change.removed > 0 && <span className="del">−{change.removed}</span>}</>}</span>
			<span className={`change-state ${state}`}><i />{retried ? t("changeRetried") : state === "err" ? t("error") : state === "done" ? t("done") : state === "running" ? t("running") : t("toolQueued")}</span>
			{change.path && <button type="button" className="change-open" onClick={openFile}>{t("changeOpen")}</button>}
			<details className="change-raw"><summary aria-label={t("more")}><FiMoreHorizontal /></summary><div><strong>{t("changeRawArgs")}</strong><pre>{item.block.argumentsText}</pre>{change.output && <><strong>{t("changeRawOutput")}</strong><pre>{change.output}</pre></>}</div></details>
		</div>
		{open && !noDiff && <ChangeBody change={change} />}
	</div>;
}

export function EditWriteGroup({ items, retriedIds }: { items: Item[]; retriedIds?: ReadonlySet<string> }) {
	const t = useT();
	const [open, setOpen] = useState(true);
	useEffect(() => {
		const onJump = (event: Event) => {
			const id = (event as CustomEvent<{ toolCallId?: string }>).detail?.toolCallId;
			if (id && items.some((item) => item.block.id === id)) setOpen(true);
		};
		window.addEventListener("pi:jump-tool", onJump);
		return () => window.removeEventListener("pi:jump-tool", onJump);
	}, [items]);
	const changes = items.map(({ block, view }) => editWriteChange(block, view.result));
	const added = changes.reduce((sum, change) => sum + (change?.added ?? 0), 0);
	const removed = changes.reduce((sum, change) => sum + (change?.removed ?? 0), 0);
	const failed = items.some((item) => status(item) === "err" && !retriedIds?.has(item.block.id));
	const done = items.every((item) => ["done", "err"].includes(status(item)));
	const verb = items.every((item) => item.block.name === "edit") ? t("changeEdit") : items.every((item) => item.block.name === "write") ? t("changeWrite") : t("taskChanges");
	return <div className={`change-group ${failed ? "err" : done ? "done" : "running"}`}><button type="button" className="change-group-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}><FiChevronRight className={open ? "open" : ""} /><strong>{verb} {items.length} {t("taskFiles")}</strong><span className="change-counts">{added > 0 && <span className="add">+{added}</span>}{removed > 0 && <span className="del">−{removed}</span>}</span><span className="change-state">{failed ? t("error") : done ? t("done") : t("running")}</span></button>{open && <div className="change-group-items">{items.map((item) => <EditWriteCard key={item.block.id} item={item} compact retried={retriedIds?.has(item.block.id)} />)}</div>}</div>;
}
