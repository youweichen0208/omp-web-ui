import { useEffect, useRef, useState } from "react";
import type { ChatState } from "./use-chat";
import type { ClientMessage, PromptAttachment } from "./types";
import { latestToolTextFailure } from "./tool-text";
import { collectQuestionAttachments } from "./question-attachments";
import { parseSkillBlock } from "./skill-block";
import { randomUuid } from "./uuid";

export function useToolRecovery(chat: ChatState, send: (message: ClientMessage) => boolean, onError: () => void) {
	const state = chat.state?.conversationId === chat.activeConversationId ? chat.state : null;
	const failure = state && latestToolTextFailure(state.messages, state.isStreaming);
	const pending = useRef<{ conversation: string; session?: string; source: string; modelId?: string; text: string; attachments: PromptAttachment[]; requestId: string; sent: boolean } | null>(null);
	const [busy, setBusy] = useState(false);
	const writable = !!state && chat.ready && !state.isStreaming && !state.tree?.busy && !state.tree?.verifying && !state.tree?.externallyModified && !Object.values(state.recovery ?? {}).some(Boolean);
	const current = useRef({ state, failure, writable, send, onError });
	current.current = { state, failure, writable, send, onError };
	const clear = () => { pending.current = null; setBusy(false); };
	useEffect(() => {
		const p = pending.current;
		if (!p) return;
		if (!chat.ready || state?.conversationId !== p.conversation || state?.sessionFile !== p.session) { clear(); return; }
		if (chat.promptResult?.requestId === p.requestId) { clear(); return; }
		if (p.sent) return;
		if (!writable || failure?.user.id !== p.source) { clear(); return; }
		if (p.modelId && `${state.model?.provider}/${state.model?.id}` !== p.modelId) return;
		p.sent = true;
		if (!send({ type: "prompt", text: p.text, attachments: p.attachments, requestId: p.requestId })) { clear(); onError(); }
	}, [state, chat.ready, chat.promptResult, writable, failure, send, onError]);
	useEffect(() => {
		if (!busy) return;
		const timer = window.setTimeout(() => { if (pending.current) { pending.current = null; setBusy(false); current.current.onError(); } }, 30000);
		return () => window.clearTimeout(timer);
	}, [busy]);
	return {
		messageId: failure?.message.id,
		disabled: !writable || busy,
		retry: (modelId?: string) => {
			const { state, failure, writable, send } = current.current;
			if (!state || !failure || !writable || pending.current) return;
			const raw = failure.user.questionText ?? failure.user.content.map(b => b.type === "text" && typeof b.text === "string" ? b.text : "").join("\n");
			const skill = parseSkillBlock(raw);
			const text = skill ? `/skill:${skill.name}${skill.userMessage ? ` ${skill.userMessage}` : ""}` : raw;
			if (!text.trim()) return;
			pending.current = { conversation: state.conversationId, session: state.sessionFile, source: failure.user.id, modelId, text, attachments: collectQuestionAttachments(state.messages).get(failure.user.id) ?? [], requestId: randomUuid(), sent: false };
			setBusy(true);
			if (modelId && `${state.model?.provider}/${state.model?.id}` !== modelId && !send({ type: "set_model", modelId })) { clear(); current.current.onError(); }
		},
	};
}
