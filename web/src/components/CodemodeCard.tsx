import { useContext, useState } from "react";
import type { UiToolCallBlock } from "../types";
import type { ToolView } from "./ToolCallBlock";
import { useT } from "../i18n";
import { codemodeOptions, codemodeScript } from "../codemode-presentation";
import { WorkspacePathContext } from "../workspace-context";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import { Markdown } from "./Markdown";

export function CodemodeCard({ block, view, wrap = true }: { block: UiToolCallBlock; view: ToolView; wrap?: boolean }) {
	const t = useT();
	const cwd = useContext(WorkspacePathContext);
	const [open, setOpen] = useState(wrap);
	const [tab, setTab] = useState<"calls" | "script" | "output">("calls");
	const [all, setAll] = useState(false);
	const [feedback, setFeedback] = useState("");
	const [saving, setSaving] = useState(false);
	const details = view.result?.codemode ?? view.codemode;
	const calls = details?.calls ?? (view.result?.nestedCalls ?? view.nestedCalls)?.calls.map(call => ({ ...call, args: call.argumentsText ?? "", status: call.status === "unfinished" ? "running" as const : call.status, cost: undefined })) ?? [];
	const count = details?.totalCalls ?? calls.length;
	const done = !!view.result || !!view.status && !view.status.running;
	const running = !done && view.streaming;
	const failed = view.result?.isError ?? view.status?.isError;
	const status = failed ? "error" : done ? "done" : running ? "running" : "toolQueued";
	const output = view.result?.content.map(part => part.type === "text" ? part.text : "").join("\n") ?? view.liveOutput ?? "";
	const script = codemodeScript(block.argumentsText);
	const options = codemodeOptions(script);
	const images = view.result?.content.flatMap(part => part.type === "image" && typeof part.dataUrl === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(part.dataUrl) ? [part.dataUrl] : []) ?? [];
	const groups = new Map<string, number>();
	for (const call of calls) groups.set(call.name, (groups.get(call.name) ?? 0) + 1);
	const priced = calls.filter(call => call.cost !== undefined);
	const cost = priced.reduce((sum, call) => sum + (call.cost ?? 0), 0);
	const duration = view.status?.durationMs !== undefined ? `${(view.status.durationMs / 1000).toFixed(1)}s` : /Wall time:?\s*([^\n]+)/i.exec(output)?.[1];
	const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setFeedback(t("copied")); } catch (error) { setFeedback(String(error)); } };
	const imageAction = async (url: string, attach: boolean, index: number) => {
		setSaving(true); setFeedback("");
		try {
			if (attach) {
				const blob = await (await fetch(url)).blob();
				const attached = await new Promise<boolean>(complete => window.dispatchEvent(new CustomEvent("pi-codemode-attach", { detail: { cwd, complete, file: new File([blob], `codemode-${index}.${blob.type.split("/")[1]}`, { type: blob.type }) } })));
				if (!attached) throw new Error(t("imageLoadFailed", { name: `codemode-${index}` }));
				setFeedback(t("cmAttached"));
			} else {
				const response = await fetch(withToken("/api/codemode-image"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: getClientId(), cwd, dataUrl: url }) });
				const result = await response.json(); if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
				setFeedback(t("cmSaved", { path: result.path }));
			}
		} catch (error) { setFeedback((error as Error).message); } finally { setSaving(false); }
	};
	return <section className={`codemode-card ${failed ? "err" : running ? "run" : ""}`} data-tool-call-id={block.id}>
		<button className="codemode-head" aria-expanded={open} onClick={() => setOpen(!open)}><span aria-hidden="true">{open ? "⌄" : "›"}</span><span className="codemode-mark">{`{ }`}</span><strong>codemode</strong><span className="codemode-state">{t(status)}</span>{duration && <small>{duration}</small>}{priced.length > 0 && <small>${cost.toFixed(4)}</small>}</button>
		{open && <>
			<div className="codemode-summary">{[...groups].map(([name, n]) => <span key={name}><code>{name}</code> × {n}</span>)}{!calls.length && <span>{t(running ? "cmWaitingCalls" : "cmNoCalls")}</span>}</div>
			<div className="codemode-tabs" role="tablist" aria-label="Codemode">{(["calls", "script", "output"] as const).map(value => <button key={value} id={`${block.id}-${value}`} role="tab" aria-selected={tab === value} aria-controls={`${block.id}-panel`} tabIndex={tab === value ? 0 : -1} onKeyDown={e => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const tabs = ["calls", "script", "output"] as const; const next = tabs[(tabs.indexOf(value) + (e.key === "ArrowRight" ? 1 : 2)) % 3]; setTab(next); document.getElementById(`${block.id}-${next}`)?.focus(); } }} onClick={() => setTab(value)}>{t(value === "calls" ? "cmCalls" : value === "script" ? "cmScript" : "output")}{value === "calls" && ` · ${count}`}</button>)}<span />{tab !== "calls" && <button className="codemode-copy" onClick={() => void copy(tab === "script" ? script : output)}>{t("copy")}</button>}</div>
			<div className="codemode-body" id={`${block.id}-panel`} role="tabpanel" aria-labelledby={`${block.id}-${tab}`}>
				{tab === "calls" && <>{calls.length > 8 && <button className="codemode-expand" onClick={() => setAll(!all)}>{t(all ? "cmCollapseCalls" : "cmMoreCalls", { n: calls.length - 8 })}</button>}{(all ? calls : calls.slice(-8)).map(call => <details className={`codemode-call ${call.status}`} key={call.id}><summary><span className="codemode-call-dot" aria-label={t(call.status === "ok" ? "done" : call.status === "cancelled" ? "cmCancelled" : call.status === "running" ? done ? "cmUnfinished" : "running" : "error")}>{call.status === "ok" ? "✓" : call.status === "error" ? "×" : call.status === "cancelled" || done && call.status === "running" ? "−" : "•"}</span><code>{call.name}</code><span className="codemode-args">{call.args}</span>{call.cost !== undefined && <small>${call.cost.toFixed(4)}</small>}{call.durationMs !== undefined && <small>{call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}</small>}</summary><pre>{call.args}</pre>{call.error && <pre className="err">{call.error}</pre>}</details>)}{count > calls.length && <p>{t("cmLimitedCalls", { n: count - calls.length })}</p>}{!calls.length && <p className="codemode-empty">{t("cmNoCalls")}</p>}</>}
				{tab === "script" && <><Markdown text={`\`\`\`\`javascript\n${script}\n\`\`\`\``} />{block.argumentsTruncated && <p>{t("cmTruncated")}</p>}</>}
				{tab === "output" && <><pre>{output || t(running ? "cmWaitingOutput" : "cmNoOutput")}</pre>{view.result?.content.some(part => part.type === "text" && part.truncated) && <p>{t("cmTruncated")}</p>}{details?.fullOutputPath && <div className="codemode-full-output">{t("cmFullOutput")} <code>{details.fullOutputPath}</code><button onClick={() => void copy(details.fullOutputPath!)}>{t("copy")}</button></div>}</>}
			</div>
			{failed && <p className="codemode-error-note">{t("cmFailureNote")}</p>}
			{images.length > 0 && <div className="codemode-images">{images.map((url, index) => <figure key={index}><a href={url} target="_blank" rel="noreferrer"><img src={url} alt={t("toolResultImage")} loading="lazy" /></a><figcaption><button disabled={saving} onClick={() => void imageAction(url, false, index)}>{t("cmSaveImage")}</button><button disabled={saving} onClick={() => void imageAction(url, true, index)}>{t("cmAttachImage")}</button></figcaption></figure>)}</div>}
			<footer className="codemode-footer"><span>max_output_tokens {options.max_output_tokens ?? 10000}</span>{options.timeout_ms !== undefined && <span>timeout {options.timeout_ms / 1000}s</span>}<span>QuickJS · 256 MB</span>{priced.length > 0 && <span>{t("cmModelCost")}: ${cost.toFixed(4)}</span>}</footer>
			{feedback && <p className="codemode-feedback" role="status">{feedback}</p>}
		</>}
	</section>;
}
