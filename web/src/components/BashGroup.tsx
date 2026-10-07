import { useContext, useEffect, useRef, useState } from "react";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";
import { useT } from "../i18n";
import { WorkspacePathContext } from "../workspace-context";
import { bashCommand } from "../bash-steps";
import { commandPresentation, displayBashCommand, isLikelyErrorLine, compactCommandLabel } from "../bash-presentation";
import type { UiToolCallBlock } from "../types";
import type { ToolView } from "./ToolCallBlock";
import { ToolOutputDownload } from "./ToolOutputDownload";

type Item = { messageId?: string; block: UiToolCallBlock; view: ToolView };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
function stateOf(view: ToolView) {
	if (view.result) return view.result.isError ? "err" : "ok";
	if (view.status && !view.status.running) return view.status.isError ? "err" : "ok";
	return view.streaming ? "run" : "err";
}

/** Presentation only: tool IDs and the authoritative result lookup stay intact. */
export function BashGroup({ items, onKill }: { items: Item[]; onKill?: () => void }) {
	const t = useT();
	const cwd = useContext(WorkspacePathContext);
	const [open, setOpen] = useState(true);
	const [all, setAll] = useState(false);
	const [revealed, setRevealed] = useState<string>();
	const failed = items.filter(({ view }) => stateOf(view) === "err").length;
	const running = items.some(({ view }) => stateOf(view) === "run");
	const state = failed ? "err" : running ? "run" : "ok";
	const durations = items.map(({ view }) => view.status?.durationMs);
	const measured = durations.every((ms) => ms !== undefined);
	useEffect(() => {
		const jump = (event: Event) => {
			const id = (event as CustomEvent<{ toolCallId?: string }>).detail?.toolCallId;
			if (items.some(({ block }) => block.id === id)) { setOpen(true); setAll(true); setRevealed(id); }
		};
		window.addEventListener("pi:reveal-tool", jump);
		return () => window.removeEventListener("pi:reveal-tool", jump);
	}, [items]);
	return <section className={`bash-group ${state}`}>
		<button type="button" className="bash-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
			<span className={`bash-state ${state}`} aria-label={t(failed ? "error" : running ? "running" : "done")}>{failed ? "✗" : running ? "●" : "✓"}</span>
			<strong>{t(running ? "bashGroupRunning" : "bashGroupCount", { n: items.length })}</strong>
			{failed > 0 && <span className="bash-state err">{t("bashGroupFailed", { n: failed })}</span>}
			<span className="bash-group-location" title={cwd}>{t("bashGroupCwd", { path: displayBashCommand(cwd, cwd) })}</span>
			<span className="bash-group-duration">{measured ? seconds(durations.reduce<number>((sum, ms) => sum + (ms ?? 0), 0)) : t("bashDurationUnknown")}</span>
			{open ? <FiChevronDown /> : <FiChevronRight />}
		</button>
		{open && <div className="bash-group-items">
			{!all && items.length > 8 && <button type="button" className="bash-group-more" onClick={() => setAll(true)}>{t("bashGroupEarlier", { n: items.length - 8 })}</button>}
			{(all ? items : items.slice(-8)).map((item) => <BashRow key={item.block.id} {...item} onKill={onKill} revealed={revealed === item.block.id} />)}
		</div>}
	</section>;
}

function BashRow({ block, view, onKill, revealed, messageId }: Item & { onKill?: () => void; revealed: boolean }) {
	const t = useT();
	const cwd = useContext(WorkspacePathContext);
	const state = stateOf(view);
	const [open, setOpen] = useState(state === "err");
	const [all, setAll] = useState(false);
	const [copied, setCopied] = useState<"command" | "output" | null>(null);
	const copyTimer = useRef<ReturnType<typeof setTimeout>>();
	useEffect(() => () => clearTimeout(copyTimer.current), []);
	useEffect(() => { if (state === "err" || revealed) setOpen(true); }, [state, revealed]);
	useEffect(() => {
		const jump = (event: Event) => { if ((event as CustomEvent).detail?.toolCallId === block.id) { setOpen(true); if ((event as CustomEvent).detail?.search) setAll(true); } };
		window.addEventListener("pi:reveal-tool", jump);
		return () => window.removeEventListener("pi:reveal-tool", jump);
	}, [block.id]);
	const command = bashCommand(block.argumentsText) ?? block.argumentsText ?? "bash";
	const display = commandPresentation(command, cwd);
	const commandLines = display.command.trimEnd().split(/\r?\n/);
	const output = view.result?.content.map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "").join("") ?? view.liveOutput ?? "";
	const lines = output ? output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
	const details = view.result?.details as { exitCode?: number; fullOutputPath?: string; truncation?: { truncated?: boolean } } | undefined;
	const exitCode = details?.exitCode ?? view.status?.exitCode;
	const truncated = details?.fullOutputPath || details?.truncation?.truncated || view.result?.content.some((part) => part.type === "text" && part.truncated);
	const copy = async (kind: "command" | "output") => {
		try { await navigator.clipboard.writeText(kind === "command" ? command : output); setCopied(kind); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(null), 1500); } catch { setCopied(null); }
	};
	return <div className={`bash-row ${state}`} data-tool-call-id={block.id} data-msg-id={messageId} onMouseEnter={() => window.dispatchEvent(new CustomEvent("pi:tool-hover", { detail: { toolCallId: block.id } }))} onMouseLeave={() => window.dispatchEvent(new CustomEvent("pi:tool-hover", { detail: { toolCallId: null } }))}>
		<button type="button" className="bash-row-head" title={command} aria-expanded={open} onClick={() => setOpen(!open)}>
			<span className={`bash-state ${state}`} aria-label={t(state === "run" ? "running" : state === "err" ? "error" : "done")}>{state === "run" ? "●" : state === "err" ? "✗" : "✓"}</span>
			<code>{compactCommandLabel(commandLines[0])}</code>
			{commandLines.length > 1 && <span className="bash-extra-lines">{t("bashExtraLines", { n: commandLines.length - 1 })}</span>}
			<span className="bash-row-stats">{state === "run" ? t("running") : exitCode !== undefined && state === "err" ? t("bashExitCode", { n: exitCode }) : !view.result && !view.status ? t("bashUnfinished") : t("toolLineCount", { n: lines.length })}{view.status?.durationMs !== undefined ? ` · ${seconds(view.status.durationMs)}` : ""}</span>
			{open ? <FiChevronDown /> : <FiChevronRight />}
		</button>
		{open && <div className="bash-row-body">
			{display.directory && <div className="bash-row-directory">{t("bashGroupCwd", { path: display.directory })}</div>}
			{commandLines.length > 1 && <pre className="bash-full-command">{command}</pre>}
			{lines.length > 0 && <div className="bash-numbered-output" data-msg-id={view.result?.id}>{(all ? lines : lines.slice(0, 6)).map((line, i) => <div key={i} className={`bash-numbered-line${isLikelyErrorLine(line) ? " error" : /(?:\bPASS\b|\bpassed\b|\bsummary\b)/i.test(line) ? " important" : ""}`}><span aria-hidden="true">{i + 1}</span><code>{line || " "}</code></div>)}</div>}
			{lines.length > 6 && <button type="button" className="bash-group-more" onClick={() => setAll(!all)}>{all ? t("collapseCode") : t("bashRemainingLines", { n: lines.length - 6 })}</button>}
			<div className="bash-row-actions">
				<button type="button" onClick={() => void copy("command")}>{t(copied === "command" ? "copied" : "bashCopyCommand")}</button>
				<button type="button" disabled={!output} onClick={() => void copy("output")}>{t(copied === "output" ? "copied" : "bashCopyOutput")}</button>
				{truncated && view.result?.toolOutputUrl && <ToolOutputDownload url={view.result.toolOutputUrl} />}
				<button type="button" title={t("bashOpenTerminalHint")} onClick={() => window.dispatchEvent(new CustomEvent("pi-web-ui:plugin-run-command", { detail: { title: compactCommandLabel(commandLines[0]), command } }))}>{t("bashOpenTerminal")}</button>
				{state === "run" && onKill && <button type="button" onClick={onKill}>{t("stopBash")}</button>}
			</div>
		</div>}
	</div>;
}
