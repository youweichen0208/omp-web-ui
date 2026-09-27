import { numberedOutputLine, differentCommandDirectory, searchOutputKind, isLikelyErrorLine, selectVisibleOutputLines, displayBashCommand } from "../bash-presentation";
import { WorkspacePathContext } from "../workspace-context";
import { Fragment, memo, useContext, useEffect, useRef, useState } from "react";
import {
	FiChevronDown,
	FiChevronRight,
	FiSquare,
	FiTerminal,
	FiX,
} from "react-icons/fi";
import type { ToolStatus, UiMessage, UiToolCallBlock } from "../types";
import { useT } from "../i18n";
import { Markdown } from "./Markdown";
import { highlightLine, langFromPath } from "../hljs-lite";
import { displayReadPath, readPath, splitFrontmatter } from "../read-presentation";
import { bashCommand, parseBashDiagnostics, parseLabeledBashSteps, type BashStepRun } from "../bash-steps";

export interface ToolView {
	/** Tool result message if the tool already finished. */
	result?: UiMessage;
	/** Live output accumulated from tool_delta while running. */
	liveOutput?: string;
	/** True when the session is streaming (tool may still be running). */
	streaming: boolean;
	/** Set the moment tool_execution_end fires (tool_status) — the command
	 *  exited but the model hasn't responded yet. */
	status?: ToolStatus;
}

/** Kill just the running bash command(s) — the agent run itself continues. */
export type KillBashHandler = () => void;

function notifyToolHover(toolCallId: string | null) {
	window.dispatchEvent(new CustomEvent("pi:tool-hover", { detail: { toolCallId } }));
}

function writeInfo(block: UiToolCallBlock): { path: string; content: string; bytes: number; lines: string[]; lang: string | null } {
	try {
		const args = JSON.parse(block.argumentsText ?? "{}") as { path?: unknown; content?: unknown };
		const path = typeof args.path === "string" ? args.path : "";
		const content = typeof args.content === "string" ? args.content : "";
		const lines = content ? content.replace(/\n$/, "").split("\n") : [];
		return { path, content, bytes: new TextEncoder().encode(content).length, lines, lang: langFromPath(path) };
	} catch { return { path: "", content: "", bytes: 0, lines: [], lang: null }; }
}

/** Adjacent writes share one card. Successful tool boilerplate is represented
 * by the row status; errors stay visible with their original result text. */
export function WriteGroup({ items }: { items: { block: UiToolCallBlock; view: ToolView }[] }) {
	const t = useT();
	const [open, setOpen] = useState(true);
	const done = items.every(({ view }) => view.result || view.status);
	const failed = items.some(({ view }) => view.result?.isError || view.status?.isError);
	const bytes = items.reduce((sum, { block }) => sum + writeInfo(block).bytes, 0);
	return <div className={`write-group ${failed ? "err" : done ? "ok" : "run"}`}>
		<button type="button" className="write-group-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}><FiChevronRight className={open ? "open" : ""} /><strong>{t("writtenFiles", { n: items.length })}</strong><span className="write-group-summary">{bytes} B</span><span className="write-group-state">{failed ? t("error") : done ? t("done") : t("running")}</span></button>
		{open && <div className="write-group-items">{items.map(({ block, view }) => <WriteFileRow key={block.id} block={block} view={view} />)}</div>}
	</div>;
}

function WriteFileRow({ block, view }: { block: UiToolCallBlock; view: ToolView }) {
	const t = useT();
	const info = writeInfo(block);
	const [open, setOpen] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const error = view.result?.isError || view.status?.isError;
	const resultText = view.result?.content.map((part) => part.type === "text" ? part.text : "").join("") ?? "";
	const visible = expanded ? info.lines : info.lines.slice(0, 8);
	return <div className={`write-file-row ${error ? "err" : ""}`} onMouseEnter={() => notifyToolHover(block.id)} onMouseLeave={() => notifyToolHover(null)}>
		<button type="button" className="write-file-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}><FiChevronRight className={open ? "open" : ""} /><code title={info.path}>{info.path || block.name}</code><span>{info.lines.length ? `${info.lines.length} ${t("lines")} · ` : ""}{info.bytes} B</span><i className={error ? "error" : view.result || view.status ? "done" : "pending"} /></button>
		{open && <div className="write-file-body">{info.lines.length ? <div className="write-file-code" role="region" aria-label={info.path}>{visible.map((line, index) => <div className="write-file-line" key={index}><span className="write-file-number">{index + 1}</span><code className="hljs" dangerouslySetInnerHTML={{ __html: highlightLine(line, info.lang) || "&#8203;" }} /></div>)}</div> : <div className="write-file-empty">{t("emptyFile")} ({info.path.split("/").at(-1)})</div>}{info.lines.length > 8 && <button type="button" className="write-file-more" onClick={() => setExpanded((value) => !value)}>{expanded ? t("collapseCode") : t("expandRemainingLines", { n: info.lines.length - 8 })}</button>}{error && resultText && <pre className="write-file-error">{resultText}</pre>}</div>}
	</div>;
}

/** Consecutive reads form one quiet step. Each file remains inspectable. */
export function ReadGroup({ items, wrap }: { items: { block: UiToolCallBlock; view: ToolView }[]; wrap?: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const paths = items.map(({ block }) => readPath(block.argumentsText) ?? block.name);
	const pending = items.some(({ view }) => view.streaming && !view.result && !view.status);
	const completed = items.every(({ view }) => view.result || view.status);
	const failed = items.some(({ view }) => view.result?.isError || view.status?.isError);
	const duration = items.reduce((sum, { view }) => sum + (view.status?.durationMs ?? 0), 0);
	return <div className={`read-group ${failed ? "err" : pending ? "run" : completed ? "ok" : "idle"}`}>
		<button type="button" className="read-group-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
			<span aria-hidden="true">{open ? "⌄" : "›"}</span><span aria-hidden="true">📄</span>
			<strong>{t("readFiles", { n: items.length })}</strong>
			<span className="read-group-paths" title={paths.join("\n")}>{paths.map((path) => path.split("/").slice(-2).join("/")).join(", ")}</span>
			<span className="read-group-status">{failed ? t("error") : pending ? t("running") : completed ? `${t("done")}${duration ? ` · ${formatDuration(duration)}` : ""}` : t("toolQueued")}</span>
		</button>
		{open && <div className="read-group-items">{items.map(({ block, view }) => <ReadFileRow key={block.id} block={block} view={view} wrap={wrap} />)}</div>}
	</div>;
}

function ReadFileRow({ block, view, wrap }: { block: UiToolCallBlock; view: ToolView; wrap?: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const path = readPath(block.argumentsText) ?? block.name;
	const content = view.result?.content.map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "").join("") ?? view.liveOutput ?? "";
	const count = content ? content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length : 0;
	return <div className="read-file-row" onMouseEnter={() => notifyToolHover(block.id)} onMouseLeave={() => notifyToolHover(null)}><button type="button" className="read-file-head" title={path} aria-expanded={open} onClick={() => setOpen((value) => !value)}><FiChevronRight className={open ? "open" : ""} /><span>{t("readVerb")}</span><code>{displayReadPath(path)}</code>{count > 0 && <span>{t("toolLineCount", { n: count })}</span>}<i className={view.result?.isError || view.status?.isError ? "error" : view.result || view.status ? "done" : "pending"} /></button>{open && <ToolCallBlock block={block} view={view} wrap={wrap} />}</div>;
}

export function GrepSummary({ block, view, wrap }: { block: UiToolCallBlock; view: ToolView; wrap?: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	let pattern = "";
	let path = "";
	try {
		const args = JSON.parse(block.argumentsText ?? "{}") as { pattern?: unknown; path?: unknown; glob?: unknown };
		if (typeof args.pattern === "string") pattern = args.pattern;
		if (typeof args.path === "string") path = args.path;
		else if (typeof args.glob === "string") path = args.glob;
	} catch { /* unparseable calls keep their normal result below */ }
	const resultText = view.result?.content.map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "").join("") ?? view.liveOutput ?? "";
	const noMatches = /^\s*(?:No matches|没有匹配)/i.test(resultText);
	const count = resultText.split("\n").filter((line) => /^\S+?:\d+[:-]/.test(line)).length;
	const duration = view.status?.durationMs !== undefined ? formatDuration(view.status.durationMs) : "";
	return <div className="grep-summary">
		<button type="button" className="grep-summary-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
			<FiChevronRight className={open ? "open" : ""} /><strong>{t("grepSearch")}</strong><code title={pattern}>{pattern || block.name}</code>
			{path && <span title={path}>{t("grepInPath", { path: displayReadPath(path) })}</span>}
			{view.result && !view.result.isError && <span>{count || noMatches ? t("grepMatches", { n: count }) : t("toolLineCount", { n: resultText.split("\n").filter(Boolean).length })}</span>}
			{duration && <span className="grep-summary-time">{duration}</span>}
		</button>
		{open && <div className="grep-summary-body"><ToolCallBlock block={block} view={view} wrap={wrap} /></div>}
	</div>;
}

export function isSubagentCall(block: UiToolCallBlock): boolean {
	if (/^(?:spawn_agent|subagent|sub_agent|delegate_agent)$/i.test(block.name)) return true;
	if (block.name !== "task") return false;
	try {
		const args = JSON.parse(block.argumentsText ?? "{}") as Record<string, unknown>;
		return typeof args.subagent_type === "string" || typeof args.agent === "string";
	} catch { return false; }
}

export function SubagentGroup({ items, wrap, startedAt }: { items: { block: UiToolCallBlock; view: ToolView }[]; wrap?: boolean; startedAt?: number }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const allDone = items.every(({ view }) => view.result || view.status);
	const anyFailed = items.some(({ view }) => view.result?.isError || view.status?.isError);
	const finishedAt = Math.max(0, ...items.map(({ view }) => view.result?.timestamp ?? 0));
	const totalMs = startedAt && finishedAt >= startedAt ? finishedAt - startedAt : 0;
	return <div className="subagent-group">
		<button type="button" className="subagent-group-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}><strong>{t("subagentsCount", { n: items.length })}</strong><span className={allDone ? anyFailed ? "failed" : "done" : "running"}>{allDone ? anyFailed ? t("subagentsPartial") : t("allDone") : t("running")}</span><span className="subagent-group-time">{totalMs ? formatDuration(totalMs) : ""}</span><FiChevronDown className={open ? "open" : ""} /></button>
		{open && <div className="subagent-rows">{items.map(({ block, view }) => <SubagentRow key={block.id} block={block} view={view} wrap={wrap} />)}</div>}
	</div>;
}

function SubagentRow({ block, view, wrap }: { block: UiToolCallBlock; view: ToolView; wrap?: boolean }) {
	const [open, setOpen] = useState(false);
	let title = block.name;
	try {
		const args = JSON.parse(block.argumentsText ?? "{}") as Record<string, unknown>;
		const candidate = args.task_name ?? args.description ?? args.prompt;
		if (typeof candidate === "string") title = candidate.split("\n")[0].slice(0, 100);
	} catch { /* use tool name */ }
	const result = view.result?.content.map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "").join("").trim() ?? "";
	const summary = result.split("\n").find((line) => line.trim())?.slice(0, 180) ?? "";
	return <div className="subagent-row"><button type="button" className="subagent-row-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}><FiChevronRight className={open ? "open" : ""} /><strong>{title}</strong><span>{view.result?.isError ? "✕" : view.result || view.status ? "✓" : "⋯"} {view.status?.durationMs !== undefined ? formatDuration(view.status.durationMs) : ""}</span></button>{summary && <div className="subagent-row-summary">{summary}</div>}{open && <div className="subagent-row-body"><ToolCallBlock block={block} view={view} wrap={wrap} /></div>}</div>;
}

const TOOL_ICONS: Record<string, string> = {
	bash: "$",
	read: "📄",
	write: "W",
	edit: "✏️",
	grep: "🔍",
	find: "🧭",
	ls: "📂",
};

function toolIcon(name: string): string {
	return TOOL_ICONS[name] ?? "🛠";
}

/** True when this is a `read` tool call whose target path is a Markdown
 *  file — its output reads much better rendered than as a raw <pre> dump. */
function isMarkdownReadTarget(block: UiToolCallBlock): boolean {
	if (block.name !== "read" || !block.argumentsText) return false;
	try {
		const args = JSON.parse(block.argumentsText) as { path?: unknown };
		return (
			typeof args.path === "string" && /\.(md|markdown)$/i.test(args.path)
		);
	} catch {
		return false;
	}
}

/** hljs language for a `read` tool call's target path, or null when the
 *  path has no recognized extension (falls back to the plain <pre> dump —
 *  and to the dedicated Markdown-preview path above for .md/.markdown). */
function readTargetLanguage(block: UiToolCallBlock): string | null {
	if (block.name !== "read" || !block.argumentsText) return null;
	try {
		const args = JSON.parse(block.argumentsText) as { path?: unknown };
		return typeof args.path === "string" ? langFromPath(args.path) : null;
	} catch {
		return null;
	}
}

/** For a `write` tool call: the language for its target path, and the raw
 *  content it's about to write — so the args panel can show colored code
 *  instead of the raw `{"path":...,"content":...}` JSON blob. Null when this
 *  isn't a (parseable) write call. */
function writeTargetPreview(
	block: UiToolCallBlock,
): { lang: string | null; content: string } | null {
	if (block.name !== "write" || !block.argumentsText) return null;
	try {
		const args = JSON.parse(block.argumentsText) as {
			path?: unknown;
			content?: unknown;
		};
		if (typeof args.content !== "string") return null;
		const lang = typeof args.path === "string" ? langFromPath(args.path) : null;
		return { lang, content: args.content };
	} catch {
		return null;
	}
}

/** For an `edit` tool call: the language for its target path (drives the
 *  diff view's per-line syntax coloring). Null when unavailable. */
function editTargetLanguage(block: UiToolCallBlock): string | null {
	if (block.name !== "edit" || !block.argumentsText) return null;
	try {
		const args = JSON.parse(block.argumentsText) as { path?: unknown };
		return typeof args.path === "string" ? langFromPath(args.path) : null;
	} catch {
		return null;
	}
}

/** Shape of the `edit` tool's toolResult.details on success (see
 *  edit-diff.ts's generateDiffString — a plain-text, line-numbered diff:
 *  each line is `+`/`-`/` ` followed by a padded line number, a space, then
 *  the code). Absent/malformed on error results. */
interface EditDiffDetails {
	diff?: unknown;
}

/** The `edit` tool's diff text for this block's result, or null when this
 *  isn't a successful edit result (running/error/not-an-edit-call). */
function editResultDiff(block: UiToolCallBlock, view: ToolView): string | null {
	if (block.name !== "edit" || !view.result || view.result.isError) return null;
	const details = view.result.details as EditDiffDetails | undefined;
	return typeof details?.diff === "string" ? details.diff : null;
}

/** One parsed line of the edit tool's diff text (see EditDiffDetails). */
interface DiffLine {
	marker: "+" | "-" | " ";
	lineNum: string;
	code: string;
}

const DIFF_LINE_RE = /^([+\- ])(\s*\d+) (.*)$/;

function parseDiffLines(diff: string): DiffLine[] {
	return diff.split("\n").map((raw) => {
		const m = DIFF_LINE_RE.exec(raw);
		if (!m) return { marker: " " as const, lineNum: "", code: raw };
		return { marker: m[1] as "+" | "-" | " ", lineNum: m[2], code: m[3] };
	});
}

/** The edit tool's own diff (see EditDiffDetails), rendered as colored
 *  +/- lines with per-line syntax highlighting — same green/red convention
 *  as the git diff viewer in SCMPanel.tsx (.scm-diff-line), but this one
 *  also tokenizes each line's code the way a fenced code block would. */
function DiffView({ diff, lang, path }: { diff: string; lang: string | null; path: string }) {
	const lines = parseDiffLines(diff);
	const added = lines.filter((line) => line.marker === "+").length;
	const removed = lines.filter((line) => line.marker === "-").length;
	return (
		<div className="toolcall-diff">
			<div className="toolcall-diff-header"><span title={path}>{path}</span><span>+{added} −{removed}</span></div>
			<div className="toolcall-diff-lines">
			{lines.map((ln, i) => (
				<div
					key={i}
					className={`toolcall-diff-line ${ln.marker === "+" ? "add" : ln.marker === "-" ? "del" : "ctx"}`}
				>
					<span className="toolcall-diff-gutter">
						{ln.marker}
						{ln.lineNum}
					</span>
					<code
						className="toolcall-diff-code hljs"
						// biome-ignore lint: highlightLine only ever returns hljs's own
						// escaped/span-wrapped output (see hljs-lite.ts), never raw input.
						dangerouslySetInnerHTML={{ __html: highlightLine(ln.code, lang) || "\u200b" }}
					/>
				</div>
			))}
			</div>
		</div>
	);
}

/** Wrap raw text in a fenced code block, picking a fence long enough that it
 *  can't be broken by a run of backticks already inside the text (CommonMark
 *  fence rule: the fence must be longer than any backtick run it contains). */
function fenceCodeBlock(text: string, lang: string): string {
	const runs = text.match(/`+/g)?.map((r) => r.length) ?? [];
	const longestRun = runs.length ? Math.max(...runs) : 0;
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	return `${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}`;
}

export const ToolCallBlock = memo(function ToolCallBlock({
	block,
	view,
	onKillBash,
	wrap = true,
}: {
	block: UiToolCallBlock;
	view: ToolView;
	/** Kill the running bash command (bash cards only, while running). */
	onKillBash?: KillBashHandler;
	/** 设置面板「完整显示工具」开关：true（开）→ 工具始终完整展开；
	 *  false（关）→ 默认折叠，点击展开。 */
	wrap?: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(wrap);
	const [copied, setCopied] = useState(false);
	const [lineWrap, setLineWrap] = useState(false);
	const [bashView, setBashView] = useState<"steps" | "raw">("steps");
	const [fullCommand, setFullCommand] = useState(false);
	const [elapsed, setElapsed] = useState(0);
	const cwd = useContext(WorkspacePathContext);
	// Markdown files read by the `read` tool default to rendered preview,
	// same convention as the file preview panel (see FilePreview.tsx).
	const [markdownPreview, setMarkdownPreview] = useState(true);
	// Code/diff panes are height-capped (see .toolcall-code / .toolcall-diff /
	// .toolcall-output pre in styles.css) so a long write or read can't push
	// the whole conversation off screen. `expanded` lifts the cap in place;
	// `zoomed` throws the same content into a full-screen overlay.
	const [expanded, setExpanded] = useState(false);
	const [zoomed, setZoomed] = useState(false);
	useEffect(() => {
		if (!zoomed) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setZoomed(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [zoomed]);

	const running = !view.result && view.streaming && !view.status;
	useEffect(() => {
		if (!running) return;
		const start = Date.now();
		const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
		return () => window.clearInterval(timer);
	}, [running]);
	const isBashRunning = block.name === "bash" && running;
	const done = view.result !== undefined;
	/** Command finished (tool_status fired) but the authoritative toolResult
	 *  message hasn't landed in a snapshot yet — the model is still chewing on
	 *  the result. */
	const waitingModel = !view.result && !!view.status;
	const isError = view.result?.isError ?? view.status?.isError ?? false;
	const isMarkdown = isMarkdownReadTarget(block);
	// Non-markdown `read` targets still get colored like a normal code block
	// when the extension maps to a known language — was a flat monochrome
	// <pre> dump before, unlike every other code block in the app.
	const codeLang = !isMarkdown && !isError ? readTargetLanguage(block) : null;
	// `write` calls: show the file content they're about to write as colored
	// code instead of the raw {"path":...,"content":...} JSON blob.
	const writePreview = writeTargetPreview(block);
	// `edit` calls: the diff the tool itself computed (server-side, already
	// line-numbered) — colored +/- with per-line syntax highlighting.
	const editDiff = editResultDiff(block, view);
	const editLang = editDiff ? editTargetLanguage(block) : null;
	let editPath = "";
	if (editDiff) {
		try { editPath = JSON.parse(block.argumentsText ?? "").path ?? ""; } catch { /* keep the diff visible for malformed arguments */ }
	}

	const output = view.result
		? view.result.content.map((b) => (b.type === "text" ? b.text : "")).join("")
		: (view.liveOutput ?? "");
	const bashRun = block.name === "bash" ? parseLabeledBashSteps(block.argumentsText, output, done || waitingModel, isError, view.status?.exitCode) : null;
	const bashDiagnostics = block.name === "bash" && isError && !bashRun ? parseBashDiagnostics(output) : [];
	const bashExit = view.status?.exitCode ?? Number(/(?:exited with code\s*|exit(?:ed)?\s+)(\d+)/i.exec(output)?.[1] ?? NaN);
	const outputLines = output.replace(/\r\n/g, "\n").split("\n");
	if (outputLines.at(-1) === "") outputLines.pop();
	const limitedOutput = block.name !== "bash" && outputLines.length > 10 && !expanded && !zoomed;
	const visibleOutput = limitedOutput ? outputLines.slice(0, 10).join("\n") : output;
	const markdownRead = isMarkdown && markdownPreview && !isError ? splitFrontmatter(visibleOutput) : null;
	const targetPath = block.name === "read" ? readPath(block.argumentsText) : null;

	const statusClass = bashRun?.status === "partial" ? "partial" : bashRun?.status === "no-match" ? "idle" : isError ? "err" : done || waitingModel ? "ok" : running ? "run" : "idle";
	let statusLabel = isError
		? t("error")
		: done
			? t("done")
			: running
				? t("running")
				: waitingModel
					? t("done")
					: t("toolQueued");
	const duration =
		view.status?.durationMs !== undefined
			? formatDuration(view.status.durationMs)
			: "";
	if (duration) statusLabel = `${statusLabel} · ${duration}`;
	if (bashRun) statusLabel = bashRun.status === "partial" ? t("bashPartial", { ok: bashRun.completed, total: bashRun.steps.length }) : bashRun.status === "failed" ? t("bashFailed") : bashRun.status === "no-match" ? t("bashNoMatch") : bashRun.status === "running" ? `${t("bashRunning")}${elapsed ? ` · ${elapsed}s` : ""}` : `${t("done")}${duration ? ` · ${duration}` : ""}`;
	else if (block.name === "bash" && isError) statusLabel = `${t("bashFailed")}${Number.isFinite(bashExit) ? ` · exit ${bashExit}` : ""}${bashDiagnostics.length ? ` · ${t("bashErrorCount", { n: bashDiagnostics.length })}` : ""}`;

	// tool_status doesn't carry the exit code for successful bash runs (only
	// failures embed "exited with code N" in the error text); show it when known.
	const exitHint =
		waitingModel && view.status?.exitCode !== undefined
			? `exit ${view.status.exitCode}`
			: "";

	const copyArgs = () => {
		if (block.argumentsText) {
			let text = block.argumentsText;
			try { if (block.name === "bash") text = JSON.parse(text).command ?? text; } catch {}
			void navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		}
	};

	// Rendered in place *and* inside the zoom overlay — kept as one value so
	// the two views can never drift apart.
	const bodyContent = (
		<>
			{block.argumentsText && (
				<div className="toolcall-args">
					{targetPath ? (
						<button type="button" className="toolcall-read-path" title={targetPath} onClick={() => setZoomed(true)}>{displayReadPath(targetPath)}</button>
					) : block.name === "bash" && block.argumentsText.startsWith("{") ? (
						<div className="bash-command-preview"><div className={fullCommand ? "full" : "clipped"}><TerminalCommand args={block.argumentsText} cwd={cwd} /></div><button type="button" onClick={() => setFullCommand((value) => !value)}>{fullCommand ? t("collapseCode") : t("bashExpandFullCommand")}</button></div>
					) : writePreview ? (
						writePreview.lang ? (
							<div className="toolcall-code">
								<Markdown text={fenceCodeBlock(writePreview.content, writePreview.lang)} />
							</div>
						) : (
							<pre>{writePreview.content}</pre>
						)
					) : (
						<pre>{block.argumentsText}</pre>
					)}
				</div>
			)}
			{output.length > 0 && (block.name === "bash" ? bashRun && bashView === "steps" ? <BashSteps run={bashRun} wrap={lineWrap} /> : bashDiagnostics.length > 0 ? <BashFailure diagnostics={bashDiagnostics} output={output} wrap={lineWrap} /> : <BashOutput output={output} wrap={lineWrap} cwd={differentCommandDirectory(block.argumentsText, cwd) ?? ""} searchOutput={searchOutputKind(block.argumentsText)} /> : (
				<div className="toolcall-output">
					<div className="toolcall-output-label">
						{isError ? t("errorOutput") : block.name === "read" ? t("modelReadOnly") : t("output")}
						{running && (
							<span className="thinking-spinner" aria-hidden="true" />
						)}
						<span className="toolcall-output-spacer" />
						{isMarkdown && !isError && (
							<button
								type="button"
								className="toolcall-md-toggle"
								title={
									markdownPreview
										? t("showMarkdownSource")
										: t("showMarkdownPreview")
								}
								onClick={() => setMarkdownPreview((v) => !v)}
							>
								{markdownPreview ? t("readRaw") : t("showMarkdownPreview")}
							</button>
						)}
					</div>
					{editDiff ? (
						<DiffView diff={editDiff} lang={editLang} path={editPath} />
					) : isMarkdown && markdownPreview && !isError ? (
						<div className="toolcall-markdown">
							{markdownRead && markdownRead.fields.length > 0 && <dl className="toolcall-frontmatter">{markdownRead.fields.map(({ name, value }) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>}
							<Markdown text={markdownRead?.body ?? visibleOutput} />
						</div>
					) : codeLang ? (
						<div className="toolcall-code">
							<Markdown text={fenceCodeBlock(visibleOutput, codeLang)} />
						</div>
					) : (
						<pre>{visibleOutput}</pre>
					)}
					{block.name !== "bash" && outputLines.length > 10 && <button type="button" className="toolcall-output-more" onClick={() => setExpanded((value) => !value)}>{expanded || zoomed ? t("collapseCode") : t("expandAllLines", { n: outputLines.length })}</button>}
				</div>
			))}

		</>
	);

	return (
		<div className={`toolcall ${statusClass} ${block.name === "bash" ? "toolcall-bash" : ""} ${bashRun ? "toolcall-steps" : ""} ${bashDiagnostics.length ? "toolcall-diagnostics" : ""}`} onMouseEnter={() => notifyToolHover(block.id)} onMouseLeave={() => notifyToolHover(null)}>
			<div className="toolcall-head">
				<span className="toolcall-icon">{toolIcon(block.name)}</span>
				<span className="toolcall-name">{block.name}</span>
				<span className="toolcall-status">
					{statusLabel}
					{running && block.name === "bash" && <span className="working-dots" aria-hidden="true"><i /><i /><i /></span>}
					{exitHint && <em className="toolcall-exit">{exitHint}</em>}
				</span>
				<span className="toolcall-spacer" />
				{bashRun && <span className="bash-view-switch"><button type="button" className={bashView === "steps" ? "active" : ""} onClick={() => setBashView("steps")}>{t("bashSteps")}</button><button type="button" className={bashView === "raw" ? "active" : ""} onClick={() => setBashView("raw")}>{t("bashRaw")}</button></span>}
				{block.name === "bash" && !bashRun && !bashDiagnostics.length && <button type="button" className="toolcall-wrap" aria-pressed={lineWrap} onClick={() => setLineWrap((value) => !value)}>{t("toolWrap")}</button>}
				{isBashRunning && onKillBash && (
					<button
						type="button"
						className="toolcall-kill"
						title={t("stopBashTip")}
						onClick={onKillBash}
					>
						<FiSquare />
						<span>{t("stopBash")}</span>
					</button>
				)}
				{block.name !== "read" && !bashRun && !bashDiagnostics.length && (
					<button
						type="button"
						disabled={!open}
						className="toolcall-expand"
						title={expanded ? t("collapseCode") : t("expandCode")}
						onClick={() => setExpanded((v) => !v)}
					>
						{expanded ? t("collapseCode") : t("expandCode")}
					</button>
				)}
				{!bashRun && !bashDiagnostics.length && <button
					type="button"
					className="toolcall-expand"
					title={t("zoomCode")}
					onClick={() => setZoomed(true)}
				>
				{t("zoomCode")}
				</button>}
				<button
					type="button"
					className="toolcall-copy"
					title={t("copyArgs")}
					onClick={copyArgs}
				>
					{t(copied ? "copied" : "copy")}
				</button>
				{(bashRun || bashDiagnostics.length > 0) && <details className="bash-card-more"><summary aria-label={t("more")}>⋯</summary><div><button type="button" onClick={() => setLineWrap((value) => !value)}>{t("toolWrap")}</button><button type="button" onClick={() => setZoomed(true)}>{t("zoomCode")}</button><button type="button" onClick={() => setOpen((value) => !value)}>{open ? t("collapseCode") : t("expandCode")}</button></div></details>}
				{!bashRun && !bashDiagnostics.length && <button
					type="button"
					className="toolcall-toggle"
					aria-label={open ? t("collapseCode") : t("expandCode")}
					onClick={() => setOpen((v) => !v)}
				>
					{open ? <FiChevronDown /> : <FiChevronRight />}
				</button>}
			</div>
			{open && (
				<div className={`toolcall-body ${expanded ? "expanded" : ""}`}>
					{bodyContent}
				</div>
			)}
			{zoomed && (
				// biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled on window
				<div className="modal-backdrop" onClick={() => setZoomed(false)}>
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop-only affordance */}
					<div
						className="toolcall-zoom"
						role="dialog"
						aria-modal="true"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="toolcall-zoom-head">
							<span className="toolcall-icon">{toolIcon(block.name)}</span>
							<span className="toolcall-name">{block.name}</span>
							<span className="toolcall-spacer" />
							<button
								type="button"
								className="toolcall-zoom-close"
								title={t("closeZoom")}
								onClick={() => setZoomed(false)}
							>
								<FiX />
							</button>
						</div>
						<div className="toolcall-body toolcall-zoom-body">{bodyContent}</div>
					</div>
				</div>
			)}
		</div>
	);
});

/** Pretty-print a bash tool call's arguments as a terminal line. */
function TerminalCommand({ args, cwd }: { args: string; cwd: string }) {
	let parsed: { command?: string; timeout?: number } | null = null;
	try {
		parsed = JSON.parse(args) as { command?: string; timeout?: number };
	} catch {
		return <pre>{args}</pre>;
	}
	if (typeof parsed.command !== "string") return <pre>{args}</pre>;
	return (
		<div className="termline">
			<span className="termline-icon">$</span>
			<code title={parsed.command}>{displayBashCommand(parsed.command, cwd)}</code>
			{typeof parsed.timeout === "number" && (
				<span className="termline-timeout">⏱ {parsed.timeout}s</span>
			)}
		</div>
	);
}

/** "0.3s" / "12.0s" / "1m 05s" — for the tool_status duration hint. */
function formatDuration(ms?: number): string {
	if (ms === undefined) return "";
	const totalSec = ms / 1000;
	if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
	const m = Math.floor(totalSec / 60);
	const s = Math.round(totalSec % 60);
	return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Numbered plain output stays text-only; path styling never interprets HTML. */
function BashSteps({ run, wrap }: { run: BashStepRun; wrap: boolean }) {
	const t = useT();
	const [selected, setSelected] = useState<number | null>(() => run.steps.findIndex((step) => step.state === "failed"));
	return <div className="bash-steps">{run.steps.map((step, index) => {
		const visible = selected === index;
		const symbol = step.state === "done" ? "✓" : step.state === "failed" ? "×" : step.state === "running" ? "⋯" : "–";
		return <div key={`${step.label}-${index}`} className={`bash-step ${step.state}`}>
			<button type="button" className="bash-step-head" aria-expanded={visible} onClick={() => setSelected(visible ? null : index)}>
				<span className="bash-step-index">{index + 1}</span><span className="bash-step-icon">{symbol}</span>
				<strong>{step.label}</strong><code title={step.command}>{step.command}</code>
				<span className="bash-step-count">{step.state === "no-match" ? t("bashNoMatch") : step.state === "skipped" ? t("bashSkipped") : step.state === "failed" ? run.exitCode !== undefined ? `exit ${run.exitCode}` : t("bashFailed") : step.state === "running" ? t("running") : t("toolLineCount", { n: step.lineCount })}</span>
				<FiChevronRight className={visible ? "open" : ""} />
			</button>
			{visible && <div className={`bash-step-detail ${wrap ? "wrap" : ""}`}><div className="bash-step-command">$ {step.command}</div><pre>{step.output ? step.output.split("\n").map((line, lineIndex, lines) => <span key={lineIndex} className={isLikelyErrorLine(line) ? "error" : ""}>{line}{lineIndex < lines.length - 1 ? "\n" : ""}</span>) : t(step.state === "no-match" ? "bashNoMatch" : "waitingOutput")}</pre></div>}
		</div>;
	})}</div>;
}

function BashFailure({ diagnostics, output, wrap }: { diagnostics: ReturnType<typeof parseBashDiagnostics>; output: string; wrap: boolean }) {
	const t = useT();
	const [raw, setRaw] = useState(false);
	return <div className="bash-failure">
		<div className="bash-failure-list">{diagnostics.map((item, index) => <div key={`${item.path}:${item.line}:${index}`} className="bash-failure-line"><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("pi-web-ui:open-tool-file", { detail: item }))}>{item.path}:{item.line}{item.column ? `:${item.column}` : ""}</button><span>{item.message}</span></div>)}</div>
		<button type="button" className="bash-failure-toggle" onClick={() => setRaw((value) => !value)}>{raw ? t("collapseCode") : t("bashShowRaw")}</button>
		{raw && <pre className={wrap ? "wrap" : ""}>{output}</pre>}
	</div>;
}

function BashOutput({ output, wrap, cwd, searchOutput }: { output: string; wrap: boolean; cwd: string; searchOutput: "standalone" | "mixed" | "none" }) {
	const t = useT();
	const [all, setAll] = useState(false);
	const scroller = useRef<HTMLDivElement>(null);
	const [overflow, setOverflow] = useState(false);
	useEffect(() => {
		const node = scroller.current;
		if (!node) return;
		const update = () => setOverflow(!wrap && node.scrollWidth - node.clientWidth - node.scrollLeft > 1);
		const observer = new ResizeObserver(update);
		observer.observe(node); node.addEventListener("scroll", update); update();
		return () => { observer.disconnect(); node.removeEventListener("scroll", update); };
	}, [output, all, wrap]);
	const lines = output.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	const visible = selectVisibleOutputLines(lines, all);
	const errorCount = lines.filter(isLikelyErrorLine).length;
	return <div className="bash-output">
		<div className="bash-output-label"><span>{t("output")} · {t("toolLineCount", { n: lines.length })}{errorCount > 0 ? ` · ${t("bashLikelyErrorLines", { n: errorCount })}` : ""}</span>{cwd && <span title={cwd}>{t("toolRelativeTo", { path: cwd })}</span>}</div>
		<div ref={scroller} className={`bash-output-lines ${wrap ? "wrap" : ""} ${overflow ? "has-overflow" : ""}`}>{visible.map((index, position) => {
			const rawLine = lines[index];
			const { number: lineNumber, text: line } = numberedOutputLine(rawLine, index, searchOutput === "mixed" ? "mixed" : searchOutput === "standalone");
			const path = /^(?:[.~/\w-]+\/)*[.\w-]+(?:\.[\w-]+)$/.test(line);
			const split = path ? line.lastIndexOf("/") + 1 : 0;
			return <Fragment key={index}>{position > 0 && index > visible[position - 1] + 1 && <div className="bash-output-gap">{t("bashHiddenLines", { n: index - visible[position - 1] - 1 })}</div>}<div className={`bash-output-line${isLikelyErrorLine(rawLine) ? " error" : ""}`}><span className="bash-line-number">{lineNumber}</span><span className="bash-line-text">{path ? <><span className="bash-path-dir">{line.slice(0, split)}</span><span className={split ? "bash-path-file" : "bash-root-file"}>{line.slice(split)}</span></> : line || " "}</span></div></Fragment>;
		})}</div>
		{lines.length > 8 && <button type="button" className="bash-output-more" onClick={() => setAll((value) => !value)}>{all ? t("collapseCode") : t("toolMoreLines", { n: lines.length - visible.length })}</button>}
	</div>;
}
