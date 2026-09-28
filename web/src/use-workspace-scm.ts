import { useEffect, useRef, useState } from "react";
import type { ClientMessage, ScmFileEntry, ServerMessage } from "./types";

// Shared by the header and file tree; SCMPanel owns positive request IDs.
let statusId = -100;
const emptyFiles: ScmFileEntry[] = [];
export function useWorkspaceScm(cwd: string, ready: boolean, dirty: number, data: ServerMessage | null, send: (message: ClientMessage) => boolean) {
	const request = useRef(0);
	const [status, setStatus] = useState<{ cwd: string; files: ScmFileEntry[]; notRepo: boolean } | null>(null);
	useEffect(() => {
		if (!ready || !cwd) return;
		const refresh = () => {
			if (document.visibilityState === "hidden") return;
			request.current = --statusId;
			send({ type: "scm_status", reqId: request.current });
		};
		refresh();
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			request.current = 0;
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [cwd, ready, dirty, send]);
	useEffect(() => {
		if (data?.type !== "scm_data" || data.kind !== "status" || data.reqId !== request.current || data.cwd !== cwd) return;
		setStatus({ cwd, files: data.ok ? (data.files ?? []).map((file) => ({ ...file, path: file.path.replaceAll("\\", "/") })) : [], notRepo: !!data.notRepo });
	}, [data, cwd]);
	return status?.cwd === cwd ? status : { cwd, files: emptyFiles, notRepo: false };
}
