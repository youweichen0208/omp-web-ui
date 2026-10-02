import { useEffect, useRef, useState } from "react";
import type { ChatState } from "../use-chat";
import type { ClientMessage, SubagentConfig, SubagentRole, SubagentSummary, SubagentListItem, SubagentStatus } from "../types";
import { randomUuid } from "../uuid";
import { useT } from "../i18n";
const active = (task: SubagentListItem) => ["queued", "running", "stopping"].includes(task.status);
export function SubagentState({ status, queueReason }: { status: SubagentStatus; queueReason?: SubagentListItem["queueReason"] }) { const t = useT(); return <span className={`subagent-status ${status}`}>{t(status === "queued" && queueReason === "write_lock" ? "saWaitingWriteLock" : `sa_${status}`)}</span>; }
export function SubagentsPanel({ chat, send, consumeResponses, onClose, initialConfigure = false }: { initialConfigure?: boolean; consumeResponses: (ids: string[]) => void; chat: ChatState; send: (msg: ClientMessage) => boolean; onClose: () => void }) {
	const t = useT();
	const [now, setNow] = useState(Date.now());
	const [selected, setSelected] = useState<string>();
	const [text, setText] = useState("");
	const [mode, setMode] = useState<"steer" | "followUp">("followUp");
	const [configure, setConfigure] = useState(initialConfigure);
	const [draft, setDraft] = useState<SubagentConfig | null>(initialConfigure ? structuredClone(chat.subagents?.config ?? null) : null);
	const [feedback, setFeedback] = useState("");
	const pending = useRef(new Map<string, { taskId?: string; action: string; conversationId: string; offset?: number; sentAt: number }>());
	const detailRequest = useRef<string>();
	const [records, setRecords] = useState<{ type: string; timestamp: number; text: string }[]>([]);
	const [nextOffset, setNextOffset] = useState<number>();
	const cursor = useRef(0);
	const [detail, setDetail] = useState<SubagentSummary>();
	const task = chat.subagents?.tasks.find(task => task.id === selected);
	const current = chat.activeConversationId ?? chat.state?.conversationId;
	const tasks = chat.subagents?.tasks ?? [];
	function request(action: Extract<ClientMessage, { type: "subagent_request" }>['action'], target?: SubagentListItem, extra: Partial<Extract<ClientMessage, { type: "subagent_request" }>> = {}) {
		const conversationId = target?.conversationId ?? current; if (!conversationId) return;
		if (action === "detail") {
			for (const [id, entry] of pending.current) if (entry.action === "detail" && Date.now() - entry.sentAt >= 10_000) pending.current.delete(id);
			if ([...pending.current.values()].some(p => p.action === "detail" && p.taskId === target?.id)) return;
		}
		const requestId = randomUuid(); pending.current.set(requestId, { action, taskId: target?.id, conversationId, offset: extra.offset ?? 0, sentAt: Date.now() }); if (action === "detail") detailRequest.current = requestId;
		if (!send({ type: "subagent_request", requestId, conversationId, action, taskId: target?.id, ...extra })) { pending.current.delete(requestId); setFeedback(t("saDisconnected")); }
	}
	useEffect(() => { request("list"); const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; document.addEventListener("keydown", escape); const timer = setInterval(() => setNow(Date.now()), 1000); return () => { clearInterval(timer); document.removeEventListener("keydown", escape); }; }, []);
	function resetDetail() {
		for (const [id, entry] of pending.current) if (entry.action === "detail") pending.current.delete(id);
		detailRequest.current = undefined;
		setRecords([]); setNextOffset(undefined); cursor.current = 0; setDetail(undefined); setFeedback("");
	}
	useEffect(() => {
		if (!task || !chat.ready || nextOffset !== undefined || (!active(task) && detail?.id === task.id && detail.status === task.status)) return;
		const timer = setInterval(() => request("detail", task, { offset: cursor.current }), 2000);
		return () => clearInterval(timer);
	}, [task?.id, task?.conversationId, task?.status, chat.ready, nextOffset, records.length, detail?.status]);
	useEffect(() => { resetDetail(); if (task && chat.ready) request("detail", task); }, [selected, task?.conversationId, chat.ready]);
	useEffect(() => {
		const consumed: string[] = [];
		for (const response of Object.values(chat.subagentResponses)) {
			const expected = pending.current.get(response.requestId); if (!expected) continue;
			if (response.conversationId !== expected.conversationId || response.taskId !== expected.taskId) continue;
			pending.current.delete(response.requestId); consumed.push(response.requestId);
			if (response.error) { setFeedback(response.error); continue; }
			if (expected.action === "detail" && response.requestId === detailRequest.current && response.taskId === selected && expected.offset === cursor.current) { setRecords(old => [...old, ...(response.records ?? [])]); cursor.current = response.nextOffset ?? cursor.current; setNextOffset(response.hasMore ? response.nextOffset : undefined); setDetail(response.task); }
			else if (response.accepted) { setFeedback(t("saAccepted")); if (expected.action === "message") setText(""); if (expected.action === "configure") setConfigure(false); }
		}
		if (consumed.length) consumeResponses(consumed);
	}, [chat.subagentResponses]);

	useEffect(() => { if (task && !active(task)) request("detail", task, { offset: cursor.current }); }, [task?.status]);
	function updateRole(index: number, patch: Partial<SubagentRole>) { if (draft) setDraft({ ...draft, roles: draft.roles.map((r, i) => i === index ? { ...r, ...patch } : r) }); }
	return <div className="subagent-backdrop" onClick={onClose}><aside className="subagent-drawer" role="dialog" aria-modal="true" aria-label={t("saTitle")} onClick={event => event.stopPropagation()}>
		<header><h2>{t("saTitle")}</h2><button onClick={() => { setDraft(structuredClone(chat.subagents?.config ?? null)); setConfigure(!configure); }}>{t("settings")}</button><button aria-label={t("close")} onClick={onClose}>×</button></header>
		{feedback && <p role="status" className="subagent-feedback">{feedback}</p>}
		{configure && draft ? <section className="subagent-config">
			<p>{t("saIntro")}</p><label><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />{t("saEnabled")}</label>
			<label>{t("saTimeout")}<input type="number" min="1" max="1440" value={draft.timeoutMs / 60000} onChange={event => setDraft({ ...draft, timeoutMs: Number(event.target.value) * 60000 })} /></label>
			{draft.roles.map((r, index) => <fieldset key={r.id}><legend>{r.name}</legend>
				<label>{t("saName")}<input value={r.name} onChange={event => updateRole(index, { name: event.target.value })} /></label>
				<label>{t("saDescription")}<input value={r.description} onChange={event => updateRole(index, { description: event.target.value })} /></label>
				<label>{t("saPrompt")}<textarea value={r.prompt} onChange={event => updateRole(index, { prompt: event.target.value })} /></label>
				<label>{t("saProvider")}<input placeholder={t("saInherit")} value={r.model?.provider ?? ""} onChange={event => updateRole(index, { model: event.target.value ? { provider: event.target.value, id: r.model?.id ?? "" } : undefined })} /></label>
				<label>{t("saModel")}<input placeholder={t("saInherit")} value={r.model?.id ?? ""} onChange={event => updateRole(index, { model: event.target.value ? { provider: r.model?.provider ?? "", id: event.target.value } : undefined })} /></label>
				<label>{t("saThinking")}<select value={r.thinking ?? ""} onChange={event => updateRole(index, { thinking: event.target.value as SubagentRole["thinking"] || undefined })}><option value="">{t("saInherit")}</option>{["off", "minimal", "low", "medium", "high", "xhigh"].map(v => <option key={v}>{v}</option>)}</select></label>
				{(["tools", "skills", "extensions"] as const).map(key => <label key={key}>{t(key === "tools" ? "saTools" : key === "skills" ? "saSkills" : "saExtensions")}<input value={r[key].join(", ")} onChange={event => updateRole(index, { [key]: event.target.value.split(",").map(s => s.trim()).filter(Boolean) })} /></label>)}
				<button onClick={() => setDraft({ ...draft, roles: draft.roles.filter((_, i) => i !== index) })}>{t("delete")}</button>
			</fieldset>)}
			<button onClick={() => setDraft({ ...draft, roles: [...draft.roles, { id: randomUuid(), name: t("saNewRole"), description: "", prompt: "", tools: ["read", "grep", "find", "ls"], skills: [], extensions: [] }] })}>{t("saNewRole")}</button>
			<button disabled={!chat.ready} onClick={() => request("configure", undefined, { config: draft })}>{t("save")}</button>
		</section> : <><section className="subagent-list">{tasks.length === 0 && <p>{t("saEmpty")}</p>}{tasks.map(item => <button key={item.id} className={selected === item.id ? "selected" : ""} onClick={() => setSelected(item.id)}><strong>{item.role.name}</strong><SubagentState status={item.status} queueReason={item.queueReason} /><span>{item.task}</span><small>{item.model.provider}/{item.model.id} · {Math.round(((item.endedAt ?? now) - (item.startedAt ?? item.createdAt)) / 1000)}s · {item.usage?.tokens ?? 0} tokens · {item.usage?.cost == null ? t("saUnknownCost") : `$${item.usage.cost.toFixed(4)}`}</small></button>)}</section>
		{task && <section className="subagent-detail"><h3>{task.task}</h3><code>{task.id}</code><p>{detail?.error ?? detail?.result}</p><div className="subagent-controls">{active(task) ? <button disabled={!chat.ready || task.status === "stopping"} onClick={() => request("stop", task)}>{t("stop")}</button> : <button disabled={!chat.ready || !chat.subagents?.config.enabled} onClick={() => request("rerun", task)}>{t("saRerun")}</button>}<button onClick={() => { resetDetail(); request("detail", task); }}>{t("saRefresh")}</button></div>
		{task.status === "running" && <div className="subagent-message"><textarea aria-label={t("saMessage")} placeholder={t("saMessage")} value={text} onChange={event => setText(event.target.value)} /><select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="followUp">{t("saFollowUp")}</option><option value="steer">{t("saSteer")}</option></select><button disabled={!chat.ready || !text.trim()} onClick={() => request("message", task, { text, mode })}>{t("saSend")}</button></div>}
		<div className="subagent-records">{records.map((record, i) => <details key={i}><summary>{new Date(record.timestamp).toLocaleTimeString()} · {record.type}</summary><pre>{record.text}</pre></details>)}</div>{nextOffset !== undefined && <button onClick={() => request("detail", task, { offset: nextOffset })}>{t("saMore")}</button>}</section>}</>}
	</aside></div>;
}
