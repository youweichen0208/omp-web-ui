import { useState } from "react";
import { withToken } from "../auth-token";
import { useT } from "../i18n";

export function ToolOutputDownload({ url }: { url: string }) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	return <><button className="btn" disabled={busy} onClick={() => void (async () => {
		setBusy(true); setError(false);
		try {
			const response = await fetch(withToken(url));
			if (!response.ok) throw new Error();
			const objectUrl = URL.createObjectURL(await response.blob());
			const link = document.createElement("a"); link.href = objectUrl; link.download = "tool-output.txt"; link.click();
			setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
		} catch { setError(true); } finally { setBusy(false); }
	})()}>{t("toolOutputDownload")}</button>{error && <span role="alert">{t("toolOutputUnavailable")}</span>}</>;
}
