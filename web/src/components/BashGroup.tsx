import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";
import { commandReading, consecutiveAttempts } from "../command-reading";
import { useT, useI18n } from "../i18n";
import { WorkspacePathContext } from "../workspace-context";
import { bashCommand } from "../bash-steps";
import { commandPresentation, isLikelyErrorLine, compactCommandLabel, commandDuration } from "../bash-presentation";
import type { UiToolCallBlock } from "../types";
import type { ToolView } from "./ToolCallBlock";
import { ToolOutputDownload } from "./ToolOutputDownload";

type Item = { messageId?: string; block: UiToolCallBlock; view: ToolView };
const seconds = (ms: number) => ms < 1000 ? "" : commandDuration(ms);
function stateOf(view: ToolView) {
	if (view.result) return view.result.isError ? "err" : "ok";
	if (view.status && !view.status.running) return view.status.isError ? "err" : "ok";
	return view.streaming ? "run" : "err";
}

/** Presentation only: tool IDs and the authoritative result lookup stay intact. */
export function BashGroup({ items, onKill, active = false, title }: { items: Item[]; onKill?: () => void; active?: boolean; title?: string }) {
	const t = useT();
	const cwd = useContext(WorkspacePathContext);
	const attempts = consecutiveAttempts(items, item => commandReading(commandPresentation(bashCommand(item.block.argumentsText) ?? "", cwd).command).title);
	const [open, setOpen] = useState(active);
	useEffect(() => setOpen(active), [active]);
	const [all, setAll] = useState(false);
	const [revealed, setRevealed] = useState<string>();
	const latest = attempts.map(group => group[group.length - 1]);
	const failed = latest.filter(({ view }) => stateOf(view) === "err").length;
	const running = latest.some(({ view }) => stateOf(view) === "run");
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
	return <section className={`bash-group ${state} ${!open ? "historical-step" : ""}`}>
		{(!active || items.length > 1) && <button type="button" className="bash-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
			<span className={`bash-state ${state}`} aria-label={t(failed ? "error" : running ? "running" : "done")}>{failed ? "✗" : running ? "●" : "✓"}</span>
			<strong>{!open ? title || commandReading(commandPresentation(bashCommand(items[0].block.argumentsText) ?? "", cwd).command).title : t(running ? "bashGroupRunning" : "bashGroupCount", { n: items.length })}</strong>{!open && <span> · {t("changesCommands", { n: items.length })}</span>}
			{failed > 0 && <span className="bash-state err">{t("bashGroupFailed", { n: failed })}</span>}
			{measured && seconds(durations.reduce<number>((sum, ms) => sum + (ms ?? 0), 0)) && <span className="bash-group-duration">{seconds(durations.reduce<number>((sum, ms) => sum + (ms ?? 0), 0))}</span>}
			{open ? <FiChevronDown /> : <FiChevronRight />}
		</button>}
		{(open || (active && items.length === 1)) && <div className="bash-group-items">
			{!all && attempts.length > 8 && <button type="button" className="bash-group-more" onClick={() => setAll(true)}>{t("bashGroupEarlier", { n: attempts.length - 8 })}</button>}
			{(all ? attempts : attempts.slice(-8)).map(group => group.length === 1 ? <BashRow key={group[0].block.id} {...group[0]} onKill={onKill} revealed={revealed === group[0].block.id} /> : <BashRow key={group[0].block.id} {...group[group.length - 1]} onKill={onKill} revealed={group.some(item => item.block.id === revealed)} attempts={group.length} history={<div className="bash-attempt-history">{group.slice(0, -1).map(item => <BashRow key={item.block.id} {...item} revealed={item.block.id === revealed} historical />)}</div>} />)}
		</div>}
	</section>;
}

function BashRow({ block, view, onKill, revealed, messageId, attempts, historical, history }: Item & { onKill?: () => void; revealed: boolean; attempts?: number; historical?: boolean; history?: ReactNode }) {
	const t = useT();
	const cwd = useContext(WorkspacePathContext);
	const state = historical && !view.result ? "empty" : stateOf(view);
	const { locale } = useI18n();
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
	const reading = commandReading(display.command, locale === "en");
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
			<span className={`bash-state ${state}`} aria-label={t(state === "run" ? "running" : state === "err" ? "error" : "done")}>{state === "run" ? "●" : state === "err" ? "✗" : state === "empty" ? "−" : "✓"}</span>
			<span className="bash-readable-title">{reading.title}</span>{attempts && <span className="bash-attempt-count">{t("commandAttempts", { n: attempts })}</span>}{reading.title !== compactCommandLabel(reading.command) && <code className="bash-command-secondary">{reading.command}</code>}
			{commandLines.length > 1 && <span className="bash-extra-lines">{t("bashExtraLines", { n: commandLines.length - 1 })}</span>}
			<span className="bash-row-stats">{state === "run" ? t("running") : exitCode !== undefined && state === "err" ? t("bashExitCode", { n: exitCode }) : t("toolLineCount", { n: lines.length })}{view.status?.durationMs !== undefined && seconds(view.status.durationMs) ? ` · ${seconds(view.status.durationMs)}` : ""}</span>
			{open ? <FiChevronDown /> : <FiChevronRight />}
		</button>
		{open && <div className="bash-row-body">
			{display.directory && <div className="bash-row-directory">{t("bashGroupCwd", { path: display.directory })}</div>}
			<pre className="bash-full-command">{command}</pre>
			{lines.length > 0 && <div className="bash-numbered-output" data-msg-id={view.result?.id}>{(all ? lines : lines.slice(0, 6)).map((line, i) => <div key={i} className={`bash-numbered-line${isLikelyErrorLine(line) ? " error" : /(?:\bPASS\b|\bpassed\b|\bsummary\b)/i.test(line) ? " important" : ""}`}><span aria-hidden="true">{i + 1}</span><code>{line || " "}</code></div>)}</div>}
			{lines.length > 6 && <button type="button" className="bash-group-more" onClick={() => setAll(!all)}>{all ? t("collapseCode") : t("bashRemainingLines", { n: lines.length - 6 })}</button>}
			<div className="bash-row-actions">
				<button type="button" onClick={() => void copy("command")}>{t(copied === "command" ? "copied" : "bashCopyCommand")}</button>
				<button type="button" disabled={!output} onClick={() => void copy("output")}>{t(copied === "output" ? "copied" : "bashCopyOutput")}</button>
				{truncated && view.result?.toolOutputUrl && <ToolOutputDownload url={view.result.toolOutputUrl} />}
				<button type="button" title={t("bashOpenTerminalHint")} onClick={() => window.dispatchEvent(new CustomEvent("pi-harness:plugin-run-command", { detail: { title: compactCommandLabel(commandLines[0]), command } }))}>{t("bashOpenTerminal")}</button>
				{state === "run" && onKill && <button type="button" onClick={onKill}>{t("stopBash")}</button>}
			</div>
			{history}
		</div>}
	</div>;
}
