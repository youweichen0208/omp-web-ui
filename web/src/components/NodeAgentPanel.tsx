import { memo, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useT } from "../i18n";
import type { NodeAgentState, ServerMessage, UiMessage } from "../types";

const RemoteMarkdown = memo(function RemoteMarkdown({ text }: { text: string }) { return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => /^https?:\/\//.test(href ?? "") ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>, img: ({ alt }) => <span>{alt}</span> }}>{text}</ReactMarkdown>; });

type Request = (action: string, nodeId?: string, payload?: Record<string, unknown>, terminalId?: string, conversationId?: string) => string | null;
export function NodeAgentPanel({ nodeId, defaultDir, connected, agent, request, draft, setDraft, consumedEditors }: { draft: string; setDraft: Dispatch<SetStateAction<string>>; consumedEditors: Record<string, string>; nodeId: string; defaultDir: string; connected: boolean; agent?: NodeAgentState; request: Request }) {
	const t = useT();
	const [cwd, setCwd] = useState(defaultDir);
	const [pending, setPending] = useState<Record<string, { action: string; text?: string }>>({}), [error, setError] = useState("");
	const [answer, setAnswer] = useState("");
	const [queue, setQueue] = useState<"followUp" | "steer">("followUp");
	const feed = useRef<HTMLDivElement>(null), follow = useRef(true);
	const dialog = agent?.dialogs[0];
	const busy = Object.keys(pending).length > 0;
	const dialogBusy = Object.values(pending).some(task => task.action === "agent_dialog");
	useEffect(() => { setAnswer(dialog?.prefill ?? ""); }, [dialog?.id]);
	useEffect(() => {
		if (agent?.editorText && consumedEditors[nodeId] !== agent.editorText.id) { consumedEditors[nodeId] = agent.editorText.id; setDraft(agent.editorText.text); }
	}, [agent?.editorText]);
	useEffect(() => {
		if (follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
	}, [agent?.messages, agent?.streamingMessage, agent?.tools]);
	useEffect(() => {
		const listener = (event: Event) => {
			const message = (event as CustomEvent<Extract<ServerMessage, { type: "node_event" }>>).detail;
			const task = message.requestId ? pending[message.requestId] : undefined;
			if (message.nodeId !== nodeId || !task) return;
			if (message.event === "failure") { setError(String(message.data?.message ?? "")); setPending(all => { const next = { ...all }; delete next[message.requestId!]; return next; }); }
			if (message.event === "result") { if (task.text !== undefined) setDraft(current => current === task.text ? "" : current); setPending(all => { const next = { ...all }; delete next[message.requestId!]; return next; }); }
		};
		window.addEventListener("pi-node-event", listener); return () => window.removeEventListener("pi-node-event", listener);
	}, [nodeId, pending]);
	useEffect(() => { if (!connected) setPending({}); }, [connected]);
	const act = (action: string, payload?: Record<string, unknown>, text?: string) => {
		setError("");
		const id = request(action, nodeId, payload, undefined, agent?.id);
		if (id) setPending(all => ({ ...all, [id]: { action, text } })); else setError(t("nodeAgentOffline"));
	};
	const submit = () => { if (!draft.trim() || busy || !connected || agent?.phase !== "ready") return; follow.current = true; act("agent_prompt", { text: draft, ...(agent.running ? { queue } : {}) }, draft); };
	const messages = [...(agent?.messages ?? []), ...(agent?.streamingMessage ? [agent.streamingMessage] : [])];
	const results = new Map(messages.filter(m => m.role === "toolResult").map(m => [m.toolCallId, m]));
	const showMessage = (message: UiMessage) => <article key={message.id} className={`node-agent-message ${message.role}`}><small>{message.role === "user" ? t("nodeAgentYou") : "pi"}</small>{message.errorMessage && <p role="alert" className="node-agent-error">{message.errorMessage}</p>}{message.content.map((block, index) => {
		if (block.type === "text" && "text" in block && typeof block.text === "string") return <RemoteMarkdown key={index} text={block.text} />;
		if (block.type === "thinking" && "thinking" in block && typeof block.thinking === "string") return <details key={index}><summary>{t("nodeAgentThinking")}</summary><pre>{block.thinking}</pre></details>;
		if (block.type === "toolCall" && "id" in block && "name" in block) {
			const result = results.get(String(block.id)), status = agent?.tools.find(tool => tool.id === block.id);
			return <details key={index} className="node-agent-tool"><summary><code>{String(block.name)}</code><span>{t(result?.isError || status?.isError ? "error" : result || status && !status.running ? "done" : agent?.running ? "running" : "toolQueued")}</span></summary><pre>{String(block.argumentsText ?? "")}</pre>{result?.content.map((part, i) => "text" in part && typeof part.text === "string" ? <pre key={i}>{part.text}</pre> : null)}</details>;
		}
		if (block.type === "image" && "dataUrl" in block && typeof block.dataUrl === "string" && block.dataUrl.startsWith("data:image/")) return <img key={index} src={block.dataUrl} alt={t("toolResultImage")} />;
		return null;
	})}</article>;
	return <section className="node-agent" aria-label={t("nodeAgentTitle")}>
		<header><strong>{t("nodeAgentTitle")}</strong><span>{agent?.model ? `${agent.model.provider} / ${agent.model.name}` : t("nodeAgentRemote")}</span>{agent?.phase === "ready" && <><button disabled={busy || agent.running || !connected} onClick={() => act("agent_new")}>{t("nodeAgentNew")}</button><button disabled={!connected} onClick={() => act("agent_close")}>{t("nodeAgentClose")}</button></>}</header>
		{(!agent || agent.phase === "closed") && <div className="node-agent-setup"><p>{t("nodeAgentSetup")}</p><label>{t("nodeDefaultDir")}<input value={cwd} onChange={e => setCwd(e.target.value)} /></label><button disabled={!connected || busy} onClick={() => act("agent_start", { cwd })}>{busy ? t("nodeAgentStarting") : t("nodeAgentStart")}</button><p className="node-muted">{t("nodeAgentInstall")}</p><code>npm install -g @earendil-works/pi-coding-agent@1.0.4</code></div>}
		{agent?.phase === "starting" && <p role="status">{t("nodeAgentStarting")}</p>}
		{!connected && <p role="status">{t("nodeAgentOffline")}</p>}
		{(error || agent?.error) && <p role="alert" className="node-agent-error">{error || agent?.error}</p>}
		{agent?.notice && <p role="status" className="node-muted">{agent.notice}</p>}
		<div className="node-agent-feed" ref={feed} onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>{messages.filter(m => m.role !== "toolResult" && (m.errorMessage || m.content.some(block => block.type === "toolCall" || block.type === "image" || "text" in block && typeof block.text === "string" && block.text.trim() || "thinking" in block && typeof block.thinking === "string" && block.thinking.trim()))).map(showMessage)}{agent?.running && <p className="node-agent-working" role="status">{t("nodeAgentWorking")}{agent.tools.filter(tool => tool.running).map(tool => <code key={tool.id}>{tool.name}</code>)}</p>}</div>
		{dialog && <form className="node-agent-dialog" onSubmit={e => { e.preventDefault(); act("agent_dialog", { id: dialog.id, value: answer, confirmed: true }); }}><strong>{dialog.title}</strong>{dialog.message && <p>{dialog.message}</p>}{dialog.method === "select" ? <select aria-label={dialog.title} required value={answer} onChange={e => setAnswer(e.target.value)}><option value="" disabled>{t("nodeAgentSelect")}</option>{dialog.options?.map(option => <option key={option}>{option}</option>)}</select> : dialog.method !== "confirm" && <textarea aria-label={dialog.title} value={answer} onChange={e => setAnswer(e.target.value)} rows={dialog.method === "editor" ? 6 : 2} />}<button disabled={dialogBusy || !connected} type="submit">{t("confirm")}</button><button disabled={dialogBusy || !connected} type="button" onClick={() => act("agent_dialog", { id: dialog.id, cancelled: true })}>{t("cancel")}</button></form>}
		{agent?.phase === "ready" && <form className="node-agent-input" onSubmit={e => { e.preventDefault(); submit(); }}><textarea aria-label={t("nodeAgentPrompt")} placeholder={t("nodeAgentPrompt")} value={draft} onChange={e => setDraft(e.target.value)} rows={3} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} /><div><select aria-label={t("nodeAgentModel")} value={agent.model ? JSON.stringify([agent.model.provider, agent.model.id]) : ""} disabled={agent.running || busy || !connected} onChange={e => { const [provider, modelId] = JSON.parse(e.target.value); act("agent_model", { provider, modelId }); }}><option value="" disabled>{t("nodeAgentModel")}</option>{agent.models.map(model => <option key={`${model.provider}/${model.id}`} value={JSON.stringify([model.provider, model.id])}>{model.provider} / {model.name}</option>)}</select>{agent.running && <><select aria-label={t("nodeAgentQueue")} value={queue} onChange={e => setQueue(e.target.value as "steer" | "followUp")}><option value="followUp">{t("nodeAgentFollowUp")}</option><option value="steer">{t("nodeAgentSteer")}</option></select><button type="button" disabled={!connected} onClick={() => act("agent_abort")}>{t("stop")}</button></>}<button type="submit" disabled={!draft.trim() || busy || !connected}>{t("nodeAgentSend")}</button></div></form>}
	</section>;
}
