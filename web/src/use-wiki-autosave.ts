import { useCallback, useEffect, useRef, useState } from "react";
import type { WikiDocument, WikiDocumentContent } from "./types";
import { wikiRequest, WikiRequestError } from "./wiki-api";

/** One write at a time. Acknowledgements advance the disk baseline, never the editor. */
export function useWikiAutosave(cwd: string, doc: WikiDocument | null, draft: string, blocked: boolean,
	accept: (document: WikiDocument) => void, refreshed: () => void) {
	const current = useRef({ doc, draft, blocked, accept, refreshed });
	current.current = { doc, draft, blocked, accept, refreshed };
	const alive = useRef(true), pending = useRef<Promise<boolean> | null>(null);
	const [saving, setSaving] = useState(false), [failure, setFailure] = useState("");
	const [conflict, setConflict] = useState(false);
	const conflictRef = useRef(false);
	useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
	useEffect(() => { setFailure(""); setConflict(false); conflictRef.current = false; }, [doc?.entry.path]);
	const save = useCallback((): Promise<boolean> => {
		if (pending.current) return pending.current;
		const initial = current.current.doc;
		if (!initial?.editable || initial.text === undefined || initial.text === current.current.draft) return Promise.resolve(true);
		if (conflictRef.current || current.current.blocked) return Promise.resolve(false);
		setSaving(true); setFailure("");
		const run = async () => {
			let baseline = initial;
			try {
				while (alive.current && current.current.doc?.entry.path === initial.entry.path) {
					const text = current.current.draft;
					if (text === baseline.text) return true;
					if (current.current.blocked) return false;
					const result = await wikiRequest<WikiDocumentContent>(cwd, "write", { path: initial.entry.path, text, version: baseline.version });
					if (!alive.current || current.current.doc?.entry.path !== initial.entry.path) return false;
					baseline = { ...result, backlinks: current.current.doc.backlinks };
					current.current.doc = baseline;
					current.current.accept(baseline);
					current.current.refreshed();
				}
				return false;
			} catch (error) {
				if (alive.current && current.current.doc?.entry.path === initial.entry.path) {
					setFailure((error as Error).message);
					if (error instanceof WikiRequestError && error.detail.code === "version_conflict") {
						conflictRef.current = true; setConflict(true);
					}
				}
				return false;
			}
		};
		pending.current = run().finally(() => { pending.current = null; if (alive.current) setSaving(false); });
		return pending.current;
	}, [cwd]);
	useEffect(() => { if (doc?.text === draft) { setFailure(""); setConflict(false); conflictRef.current = false; } }, [doc?.version, draft]);
	const dirty = !!doc?.editable && doc.text !== undefined && doc.text !== draft;
	useEffect(() => {
		if (!dirty || blocked || conflict || failure) return;
		const timer = setTimeout(() => void save(), 800);
		return () => clearTimeout(timer);
	}, [draft, dirty, blocked, conflict, failure, save]);
	const keepMine = async () => {
		const before = current.current.doc;
		if (!before || current.current.blocked) return false;
		try {
			const latest = await wikiRequest<WikiDocumentContent>(cwd, "document-content", { path: before.entry.path });
			if (!alive.current || current.current.doc?.entry.path !== before.entry.path || current.current.doc.version !== before.version) return false;
			const baseline = { ...latest, backlinks: before.backlinks };
			current.current.doc = baseline; current.current.accept(baseline);
			conflictRef.current = false; setConflict(false); setFailure("");
			return await save(); // Still compare-and-swap against the version just read.
		} catch (error) { if (alive.current) setFailure((error as Error).message); return false; }
	};
	const noteExternalChange = useCallback(() => {
		conflictRef.current = true; setConflict(true); setFailure("File changed on disk; reload before saving");
	}, []);
	return { save, saving, failure, conflict, keepMine, noteExternalChange };
}
