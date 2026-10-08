import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiCheck, FiLoader, FiX, FiMoreHorizontal } from "react-icons/fi";
import { useT } from "../i18n";
import type { UiMessage, UiToolCallBlock, UiThinkingBlock, UiModelInfo, ToolStatus, WikiRevision } from "../types";
import { wikiReplyParts } from "../wiki-chat";
import { ThinkingBlock } from "./ThinkingBlock";
import { ConversationWorkingStatus } from "./WorkingStatus";
import { WikiReadingDialog } from "./WikiReading";
import { Markdown } from "./Markdown";

export function WikiChatPanel({ messages, live, streaming, toolStatuses, model, contextPercent, disabled, onNew, onClose, canJump, jump, composer, quickQuestions, onQuickQuestion, revisions, onViewChange, onUndo, onResend, error, conversationId, thinkingWrap, connected, silenceNotified, recovery, onStop }: {
	onStop?: () => void;
	recovery?: import("../types").UiRecovery;
	quickQuestions: string[]; onQuickQuestion: (question: string) => void;
	conversationId: string; thinkingWrap: boolean; connected: boolean; silenceNotified: boolean;
	messages: UiMessage[]; live: UiMessage | null; streaming: boolean; toolStatuses: Map<string, ToolStatus>;
	model?: UiModelInfo; contextPercent?: number | null; disabled: boolean; onNew: () => void; onClose: () => void;
	canJump: (section: number) => boolean; jump: (section: number) => void; composer: ReactNode; revisions: WikiRevision[]; onViewChange: (revision: WikiRevision) => void; onUndo: (revision: WikiRevision) => void; onResend: (text: string) => void; error: ReactNode;
}) {
	const t = useT(), scroll = useRef<HTMLDivElement>(null), follow = useRef(true);
	const [requestPreview, setRequestPreview] = useState<string | null>(null);
	const [actionError, setActionError] = useState("");
	const [limit, setLimit] = useState(60);
	// Increment-only streaming messages can precede the snapshot that supplies role metadata.
	const transcript = useMemo(() => streaming && live && !messages.some(m => m.id === live.id) ? [...messages, { ...live, role: "assistant" }] : messages, [messages, live, streaming]);
	const results = useMemo(() => new Map(messages.filter(m => m.role === "toolResult" && m.toolCallId).map(m => [m.toolCallId!, m])), [messages]);
	useEffect(() => {
		if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
	}, [messages, live, streaming]);
	const activeTools = useMemo(() => {
		const lastUser = transcript.map(m => m.role).lastIndexOf("user");
		return new Set(streaming ? transcript.slice(Math.max(0, lastUser)).flatMap(m => m.content.filter(b => b.type === "toolCall").map(b => b.type === "toolCall" ? b.id : "")) : []);
	}, [transcript, streaming]);
	const [overlay, setOverlay] = useState(() => window.matchMedia("(max-width: 1099px)").matches);
	useEffect(() => {
		const media = window.matchMedia("(max-width: 1099px)");
		const update = () => setOverlay(media.matches);
		media.addEventListener("change", update); return () => media.removeEventListener("change", update);
	}, []);
	const renderTool = (block: UiToolCallBlock) => {
		const result = results.get(block.id), status = toolStatuses.get(block.id);
		const error = result?.isError || status?.isError;
		const running = activeTools.has(block.id);
		const finished = !!result || !!status && !status.running;
		let path = "";
		try { const args = JSON.parse(block.argumentsText ?? "{}"); path = String(args.path ?? args.file_path ?? args.command ?? "").split("\n")[0]; } catch { /* Partial streamed arguments. */ }
		const output = result?.content.filter(c => c.type === "text").map(c => c.type === "text" ? String(c.text ?? "") : "").join("\n");
		return <details className={`wiki-chat-tool ${error ? "error" : finished ? "done" : "pending"}`} key={block.id}>
			<summary><span>{error ? <FiX /> : finished ? <FiCheck /> : running ? <FiLoader /> : "−"}</span><code>{block.name} {path}</code><small>{t(error ? "error" : finished ? "done" : running ? "running" : "wikiToolInterrupted")}{status?.durationMs !== undefined ? ` · ${(status.durationMs / 1000).toFixed(1)}s` : ""}</small></summary>
			<pre>{output || block.argumentsText || block.name}</pre>
		</details>;
	};
	return <aside className="wiki-chat-panel" aria-label={t("wikiChatPanel")} role={overlay ? "dialog" : undefined} aria-modal={overlay || undefined} onKeyDown={e => {
			if (!overlay || e.key !== "Tab") return;
			const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), textarea, summary, a[href]")].filter(el => el.getClientRects().length);
			if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)?.focus(); }
			else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0]?.focus(); }
		}}>
		<header><img className="wiki-chat-brand" src="/brand-mark.svg" alt="" /><strong>{t("wikiChatTitle")}</strong><span className="wiki-chat-model" title={model?.id}>{model?.name || model?.id || t("wikiNoModel")}{contextPercent != null && contextPercent > 0 ? ` · ${t("wikiChatContext", { percent: Math.round(contextPercent) })}` : ""}</span><button disabled={disabled} onClick={onNew}>{t("newChat")}</button><button aria-label={t("wikiCloseChat")} onClick={onClose}><FiX /></button></header>
		{error}
		<div className={`wiki-chat-messages${!transcript.length ? " empty" : ""}`} ref={scroll} onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
			{transcript.length > limit && <button className="wiki-chat-earlier" onClick={() => { follow.current = false; setLimit(n => n + 60); }}>{t("wikiEarlierMessages")}</button>}
			{!transcript.length && <div className="wiki-chat-empty"><p>{t("wikiChatEmpty")}</p><div className="wiki-quick-questions">{quickQuestions.map(question => <button key={question} disabled={disabled || !connected || streaming} onClick={() => onQuickQuestion(question)}>{question}</button>)}</div></div>}
			{transcript.slice(-limit).map(message => {
				if (!["user", "assistant"].includes(message.role)) return null;
				const original = message.content.filter(b => b.type === "text").map(b => "text" in b ? b.text : "").join("\n");
				return <div key={message.id} className={`wiki-chat-message ${message.role}`}>
					{message.content.map((block, index) => {
						if (block.type === "thinking") { const thinking = block as UiThinkingBlock; return <ThinkingBlock key={index} thinking={thinking.thinking} durationMs={thinking.durationMs} streaming={streaming && message.id === live?.id && index === message.content.length - 1} wrap={thinkingWrap} />; }
						if (block.type === "toolCall") return renderTool(block as UiToolCallBlock);
						if (block.type === "image" && typeof block.dataUrl === "string") return <img key={index} src={block.dataUrl} alt={t("attachment")} />;
						if (block.type !== "text" || typeof block.text !== "string" || !block.text.trim()) return null;
						if (message.role === "user") {
							const split = /\n\n(?:范围|Scope): /.exec(block.text);
							return <div key={index}><Markdown text={split ? block.text.slice(0, split.index) : block.text} /></div>;
						}
						return <div key={index} className="wiki-chat-answer">{wikiReplyParts(block.text).map((part, i) => part.kind === "text" ? <Markdown key={i} text={part.text} /> : <section key={i} className="wiki-suggestion"><header><strong>{part.title}</strong>{part.section !== null && canJump(part.section) && <button onClick={() => jump(part.section!)}>{t("wikiJumpSection", { section: part.section })}</button>}</header>{part.text && <Markdown text={part.text} />}</section>)}</div>;
					})}
					{message.role === "user" && <details className="wiki-message-actions"><summary aria-label={t("wikiMessageActions")}><FiMoreHorizontal /></summary><div role="menu">
						<button role="menuitem" onClick={e => { e.currentTarget.closest("details")?.removeAttribute("open"); setRequestPreview(original); }}>{t("wikiFullRequest")}</button>
						<button role="menuitem" onClick={e => { e.currentTarget.closest("details")?.removeAttribute("open"); void navigator.clipboard.writeText(original).catch(e => setActionError(e.message)); }}>{t("copy")}</button>
						<button role="menuitem" disabled={disabled || streaming} onClick={e => { e.currentTarget.closest("details")?.removeAttribute("open"); onResend(original); }}>{t("wikiResend")}</button>
					</div></details>}
					{message.role === "assistant" && revisions.filter(r => r.author === "pi" && r.conversationId === conversationId && r.assistantTimestamp !== undefined && r.assistantTimestamp === message.timestamp && r.changes.length > 0).map(revision => <div className="wiki-reply-change" key={revision.id}>
						<FiCheck /><span>{t("wikiReplyChanged", { file: revision.changes.length === 1 ? revision.changes[0].path.split("/").at(-1)! : t("wikiFileCount", { count: revision.changes.length }) })} · <em>+{revision.changes.reduce((n, c) => n + c.additions, 0)}</em> <b>−{revision.changes.reduce((n, c) => n + c.deletions, 0)}</b></span>
						<button onClick={() => onViewChange(revision)}>{t("wikiViewChange")}</button><button disabled={disabled || streaming} onClick={() => onUndo(revision)}>{t(revision.changes.every(c => c.undone) ? "wikiRedo" : "wikiUndo")}</button>
					</div>)}
					{message.errorMessage && <p role="alert" className="wiki-chat-error">{message.errorMessage}</p>}
				</div>;
			})}
			{streaming && <ConversationWorkingStatus onStop={onStop} state={{ recovery, messages, streamingMessage: live, isStreaming: streaming, conversationId, model: model ?? null }} connected={connected} silenceNotified={silenceNotified} toolStatuses={toolStatuses} />}
		</div>
		{actionError && <p role="alert">{actionError}</p>}
		<footer>{composer}</footer>
		{requestPreview !== null && <WikiReadingDialog title={t("wikiFullRequest")} onClose={() => setRequestPreview(null)}><pre className="wiki-full-request">{requestPreview}</pre></WikiReadingDialog>}
	</aside>;
}
