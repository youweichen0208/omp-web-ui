import { useEffect, useState } from "react";
import { withToken } from "../auth-token";
import { useT } from "../i18n";

export function ToolOutputDownload({ url }: { url: string }) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<number>();
	const [outputs, setOutputs] = useState<{ id: string; name: string }[]>();
	useEffect(() => { setOutputs(undefined); setError(undefined); }, [url]);
	const fail = (status: number) => { setError(status); };
	const download = async (id?: string, name = "tool-output.txt") => {
		setBusy(true); setError(undefined);
		try {
			const response = await fetch(withToken(url + (id ? `&outputId=${encodeURIComponent(id)}` : "")));
			if (!response.ok) { fail(response.status); return; }
			const disposition = response.headers.get("content-disposition") ?? "";
			const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
			const quoted = disposition.match(/filename="([^"]+)"/);
			const filename = encoded ? decodeURIComponent(encoded[1]) : quoted?.[1] ?? name;
			const objectUrl = URL.createObjectURL(await response.blob());
			const link = document.createElement("a"); link.href = objectUrl; link.download = filename; link.click();
			setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
		} catch { fail(500); } finally { setBusy(false); }
	};
	const select = async () => {
		setBusy(true); setError(undefined);
		try {
			const response = await fetch(withToken(url.replace("/api/tool-output?", "/api/tool-output-list?")));
			if (!response.ok) { fail(response.status); return; }
			const files = await response.json() as { id: string; name: string; default: boolean }[];
			if (!files.length) await download();
			else if (files.length === 1 && files[0].default) await download(files[0].id, files[0].name);
			else setOutputs(files);
		} catch { fail(500); } finally { setBusy(false); }
	};
	return <><button className="btn" disabled={busy} onClick={() => void select()}>{t("toolOutputDownload")}</button>{outputs && <span className="tool-output-files"><button disabled={busy} onClick={() => void download()}>{t("toolOutputText")}</button>{outputs.map(file => <button disabled={busy} key={file.id} onClick={() => void download(file.id, file.name)}>{file.name}</button>)}</span>}{error && <span role="alert">{t(error === 404 ? "toolOutputUnavailable" : error === 401 ? "toolOutputAuth" : error === 403 ? "toolOutputDenied" : "toolOutputError")}</span>}</>;
}
