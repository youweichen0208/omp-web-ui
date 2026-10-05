import { useEffect } from "react";
import type { ServerMessage } from "./types";
type Edit = Extract<ServerMessage, { type: "extension_editor" }>;
const pending = new Map<string, Edit>();
const seen = new Set<string>();
export function discardExtensionEditor(conversationId: string) { pending.delete(conversationId); }
export function queueExtensionEditor(message: Edit) {
	if (seen.has(message.id)) return;
	seen.add(message.id);
	pending.set(message.conversationId, message);
	window.dispatchEvent(new Event("pi-extension-editor"));
}
export function useExtensionEditor(conversationId: string, enabled: boolean, replace: (text: string) => void) {
	useEffect(() => {
		if (!enabled) return;
		const consume = () => {
			const message = pending.get(conversationId);
			if (!message) return;
			pending.delete(conversationId);
			replace(message.text);
		};
		consume();
		window.addEventListener("pi-extension-editor", consume);
		return () => window.removeEventListener("pi-extension-editor", consume);
	}, [conversationId, enabled, replace]);
}
