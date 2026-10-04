import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiCheck, FiLoader, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import type { UiMessage, UiToolCallBlock, ToolStatus } from "../types";
import { wikiReplyParts } from "../wiki-chat";
import { Markdown } from "./Markdown";

export function WikiChatPanel({ messages, live, streaming, toolStatuses, model, contextPercent, disabled, onNew, onClose, canJump, jump, composer, changes, error }: {
	messages: UiMessage[]; live: UiMessage | null; streaming: boolean; toolStatuses: Map<string, ToolStatus>;
	model?: string; contextPercent?: number | null; disabled: boolean; onNew: () => void; onClose: () => void;
	canJump: (section: number) => boolean; jump: (section: number) => void; composer: ReactNode; changes: ReactNode; error: ReactNode;
}) {
	const t = useT(), scroll = useRef<HTMLDivElement>(null), follow = useRef(true);
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
		<header><span className="wiki-chat-brand">π</span><strong>{t("wikiChatTitle")}</strong><span className="wiki-chat-model" title={model}>{model || t("wikiNoModel")}{contextPercent != null ? ` · ${t("wikiChatContext", { percent: Math.round(contextPercent) })}` : ""}</span><button disabled={disabled} onClick={onNew}>{t("newChat")}</button><button aria-label={t("wikiCloseChat")} onClick={onClose}><FiX /></button></header>
		{error}
		<div className="wiki-chat-messages" ref={scroll} onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
			{transcript.length > limit && <button className="wiki-chat-earlier" onClick={() => { follow.current = false; setLimit(n => n + 60); }}>{t("wikiEarlierMessages")}</button>}
			{!transcript.length && <p className="wiki-chat-empty">{t("wikiChatEmpty")}</p>}
			{transcript.slice(-limit).map(message => {
				if (!["user", "assistant"].includes(message.role)) return null;
				return <div key={message.id} className={`wiki-chat-message ${message.role}`}>
					{message.content.map((block, index) => {
						if (block.type === "toolCall") return renderTool(block as UiToolCallBlock);
						if (block.type === "image" && typeof block.dataUrl === "string") return <img key={index} src={block.dataUrl} alt={t("attachment")} />;
						if (block.type !== "text" || typeof block.text !== "string" || !block.text.trim()) return null;
						if (message.role === "user") {
							const split = /\n\n(?:范围|Scope): /.exec(block.text);
							return <div key={index}><Markdown text={split ? block.text.slice(0, split.index) : block.text} />{split && <details className="wiki-chat-request"><summary>{t("wikiPromptPreview")}</summary><pre>{block.text.slice(split.index + 2)}</pre></details>}</div>;
						}
						return <div key={index} className="wiki-chat-answer">{wikiReplyParts(block.text).map((part, i) => part.kind === "text" ? <Markdown key={i} text={part.text} /> : <section key={i} className="wiki-suggestion"><header><strong>{part.title}</strong>{part.section !== null && canJump(part.section) && <button onClick={() => jump(part.section!)}>{t("wikiJumpSection", { section: part.section })}</button>}</header>{part.text && <Markdown text={part.text} />}</section>)}</div>;
					})}
					{message.errorMessage && <p role="alert" className="wiki-chat-error">{message.errorMessage}</p>}
				</div>;
			})}
			{streaming && <p className="wiki-chat-working" role="status"><FiLoader />{t("wikiWorking")}</p>}
		</div>
		<footer>{changes}{composer}</footer>
	</aside>;
}
