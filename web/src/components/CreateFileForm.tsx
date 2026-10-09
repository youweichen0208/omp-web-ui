import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { wikiRequest } from "../wiki-api";
import type { WorkspaceFileCreated } from "../types";

/** Shared manual file creation for the workspace tree and Wiki. */
export function CreateFileForm({ cwd, conversationId, initialPath = "", disabled, onCreated, onCancel }: {
	cwd: string; conversationId: string; initialPath?: string; disabled?: boolean;
	onCreated: (path: string) => void; onCancel: () => void;
}) {
	const t = useT();
	const [path, setPath] = useState(initialPath), [error, setError] = useState(""), [busy, setBusy] = useState(false);
	const request = useRef<AbortController | null>(null);
	useEffect(() => () => { request.current?.abort(); }, []);
	return <form className="create-file-form" aria-label={t("newWorkspaceFile")} onSubmit={async event => {
		event.preventDefault();
		if (busy || disabled || !path.trim()) return;
		const controller = new AbortController(); request.current = controller;
		setBusy(true); setError("");
		try {
			const result = await wikiRequest<WorkspaceFileCreated>(cwd, "create-file", { path, conversationId }, controller.signal);
			if (!controller.signal.aborted) onCreated(result.path);
		} catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
		finally { if (!controller.signal.aborted) setBusy(false); }
	}}>
		<label>{t("workspaceFilePath")}<input autoFocus value={path} placeholder={t("workspaceFilePlaceholder")} disabled={busy} onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); if (!busy) onCancel(); } }} /></label>
		{error && <p role="alert">{error}</p>}
		<div><button type="button" disabled={busy} onClick={onCancel}>{t("cancel")}</button><button type="submit" disabled={busy || disabled || !path.trim()}>{t(busy ? "saving" : "createWorkspaceFile")}</button></div>
	</form>;
}
