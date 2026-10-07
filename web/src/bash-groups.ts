import type { UiMessage } from "../../server/protocol.js";

/** Merge tool-only assistant continuations across their invisible results.
 * Never cross user/text/thinking/event boundaries or the history fold boundary.
 * Source IDs remain anchors in MessageList, so navigation still reaches a group.
 */
export function groupBashMessages(messages: UiMessage[], start = 0, barriers = new Set<number>()) {
	const projected = new Map<string, UiMessage>();
	const owners = new Map<string, string>();
	const sources = new Map<string, string>();
	let owner: UiMessage | undefined;
	for (let i = start; i < messages.length; i++) {
		const message = messages[i];
		for (const block of message.content) if (block.type === "toolCall" && typeof block.id === "string") sources.set(block.id, message.id);
		if (barriers.has(i)) owner = undefined;
		if (message.role === "toolResult") continue;
		const onlyBash = message.role === "assistant" && message.content.length > 0 && message.content.every((block) => block.type === "toolCall" && block.name === "bash");
		if (!onlyBash) { owner = undefined; continue; }
		if (!owner) { owner = message; continue; }
		const previous = projected.get(owner.id) ?? owner;
		projected.set(owner.id, { ...previous, content: [...previous.content, ...message.content] });
		owners.set(message.id, owner.id);
	}
	return { projected, owners, sources };
}
