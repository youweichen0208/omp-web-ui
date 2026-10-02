import { fileToProcessedImage } from "../image-paste";
import { useEffect, useState } from "react";
import type { ClientMessage, ServerMessage, ImageRecord } from "../types";
import { useT } from "../i18n";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import { randomUuid } from "../uuid";

type Reply = Extract<ServerMessage, { type: "image_result" }>;
export function ImageWorkbench({ cwd, send, attach }: { cwd: string; send: (m: ClientMessage) => boolean; attach: (files: File[]) => Promise<void> }) {
	const t = useT();
	const [models, setModels] = useState<NonNullable<Reply["models"]>>([]);
	const [model, setModel] = useState("");
	const [prompt, setPrompt] = useState("");
	const [references, setReferences] = useState<File[]>([]);
	const [records, setRecords] = useState<ImageRecord[]>([]);
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const request = (action: Extract<ClientMessage, { type: "image_request" }>["action"], extra = {}) => send({ type: "image_request", requestId: randomUuid(), cwd, action, ...extra });
	useEffect(() => {
		setRecords([]); setModels([]); setPending(false); setError("");
		const receive = (event: Event) => {
			const msg = (event as CustomEvent<Reply>).detail;
			if (msg.cwd !== cwd) return;
			if (msg.error) { setError(msg.error); setPending(false); }
			if (msg.models) { setModels(msg.models); setModel(msg.models[0] ? JSON.stringify([msg.models[0].provider, msg.models[0].id]) : ""); }
			if (msg.records) setRecords(msg.records);
			if (msg.record) { setPending(false); setRecords(old => [msg.record!, ...old.filter(r => r.id !== msg.record!.id)].sort((a,b) => b.createdAt-a.createdAt)); }
		};
		window.addEventListener("pi-image-event", receive);
		request("models"); request("list");
		const timer = setInterval(() => request("list"), 3000);
		return () => { clearInterval(timer); window.removeEventListener("pi-image-event", receive); };
	}, [cwd, send]);
	const url = (record: ImageRecord, index: number) => withToken(`/api/generated-image?${new URLSearchParams({ clientId: getClientId(), cwd: record.cwd, id: record.id, index: String(index) })}`);
	const save = async (record: ImageRecord, index: number, toChat: boolean) => {
		try {
			const response = await fetch(url(record, index)); if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const blob = await response.blob(); const name = `${record.id}-${index}.${record.images[index].extension}`;
			if (toChat) await attach([new File([blob], name, { type: blob.type })]);
			else { const href = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = href; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(href), 10000); }
		} catch (e) { setError((e as Error).message); }
	};
	const generate = async () => {
		setPending(true); setError("");
		try {
			const [provider, id] = JSON.parse(model);
			const images = await Promise.all(references.map(async file => {
				const image = await fileToProcessedImage(file); if (!image) throw new Error(t("imageLoadFailed", { name: file.name }));
				return { data: image.data, mimeType: image.mimeType };
			}));
			if (!request("create", { provider, model: id, prompt, references: images })) throw new Error(t("imageDisconnected"));
		} catch (e) { setError((e as Error).message); setPending(false); }
	};
	return <section className="image-workbench">
		<h2>{t("imageWorkbench")}</h2>
		<label>{t("imageModel")}<select value={model} onChange={e => setModel(e.target.value)}>{models.map(m => <option key={`${m.provider}/${m.id}`} value={JSON.stringify([m.provider,m.id])}>{m.provider} / {m.name}</option>)}</select></label>
		{!models.length && <p>{t("imageNoModels")}</p>}
		<label>{t("imagePrompt")}<textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} /></label>
		<label>{t("imageReferences")}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={e => setReferences(Array.from(e.target.files ?? []).slice(0,8))} /></label>
		<button disabled={!model || !prompt.trim() || pending} onClick={() => void generate()}>{t("imageGenerate")}</button>
		{error && <p role="alert">{error}</p>}
		<div className="image-history">{records.map(record => <article key={record.id}>
			<p>{record.prompt}</p><small>{record.provider} / {record.model} · {t(`imageStatus_${record.status}`)} {record.usage ? `· $${record.usage.cost.total} · ${record.usage.totalTokens} tokens` : ""}</small>
			{record.error && <p role="alert">{record.error}</p>}
			{record.images.map((image,index) => <div key={index}><img src={url(record,index)} alt={record.prompt} /><button onClick={() => void save(record,index,false)}>{t("imageDownload")}</button><button onClick={() => void save(record,index,true)}>{t("imageAttach")}</button></div>)}
			{record.status === "running" ? <button onClick={() => request("cancel", { id: record.id })}>{t("cancel")}</button> : <button onClick={() => { request("delete", { id: record.id }); request("list"); }}>{t("delete")}</button>}
		</article>)}</div>
	</section>;
}
