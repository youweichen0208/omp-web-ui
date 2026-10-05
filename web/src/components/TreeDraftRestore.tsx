import { useEffect, useState } from "react";
import { consumeTreeDraft, peekTreeDraft, type TreeDraft } from "../tree-events";
import { useT } from "../i18n";

/** Keep incoming branch text separate until the user resolves an existing draft. */
export function TreeDraftRestore({ conversationId, active, text, replace }: { conversationId: string; active: boolean; text: string; replace: (text: string) => void }) {
	const t = useT();
	const [pending, setPending] = useState<TreeDraft>();
	useEffect(() => {
		const update = () => setPending(active ? peekTreeDraft(conversationId) : undefined);
		update(); window.addEventListener("pi-tree-draft", update);
		return () => window.removeEventListener("pi-tree-draft", update);
	}, [conversationId, active]);
	useEffect(() => {
		if (pending && pending.conversationId === conversationId && active && !text.trim()) {
			replace(pending.text); consumeTreeDraft(conversationId, pending.id);
		}
	}, [pending, conversationId, active, text, replace]);
	if (!pending || pending.conversationId !== conversationId || !active || !text.trim()) return null;
	const finish = (value?: string) => { if (value !== undefined) replace(value); consumeTreeDraft(conversationId, pending.id); };
	return <section className="tree-draft-restore" role="alert"><p>{t("treeDraftConflict")}</p><details><summary>{t("treeReturnedText")}</summary><pre>{pending.text}</pre></details><button onClick={() => finish(pending.text)}>{t("treeReplaceDraft")}</button><button onClick={() => finish(`${text}\n\n${pending.text}`)}>{t("treeAppendDraft")}</button><button onClick={() => finish()}>{t("treeKeepDraft")}</button></section>;
}
