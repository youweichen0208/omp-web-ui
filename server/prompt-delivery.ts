import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

type Aside = { message: Parameters<AgentSession["sendCustomMessage"]>[0] };
type Pending = { text: string; images: ImageContent[] };
const imagesBySession = new WeakMap<AgentSession, { steering: Pending[]; followUp: Pending[] }>();

/** A question and its attachments occupy ONE native queue item. Never override
 * the user's queue modes or enqueue context that could reach another prompt. */
export function promptWithAttachments(text: string, asides: Aside[]) {
	const content = asides.flatMap(({ message }) => typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content);
	// Native skill/template parsing separates the command from arguments with a
	// literal space. Keep that separator when attaching context to a bare command.
	const question = content.some(block => block.type === "text") && /^\/\S+$/.test(text) ? `${text} ` : text;
	return {
		text: [question, ...content.flatMap(block => block.type === "text" ? [block.text] : [])].join("\n\n"),
		images: content.filter((block): block is ImageContent => block.type === "image"),
	};
}

export async function deliverPrompt(session: AgentSession, text: string, asides: Aside[], queue: boolean, acknowledge: (ok: boolean) => void): Promise<void> {
	// Extension commands run immediately and own their input/turn. Preserve the
	// original command text instead of turning attachments into command arguments.
	const command = text.startsWith("/") ? session.extensionRunner.getCommand(text.slice(1).split(/\s/, 1)[0]) : undefined;
	const input = promptWithAttachments(text, command ? [] : asides);
	let pending = imagesBySession.get(session);
	if (!pending) {
		pending = { steering: [], followUp: [] }; imagesBySession.set(session, pending);
		const records = pending;
		const unsubscribe = session.subscribe(event => {
			if (event.type === "queue_update") {
				// SDK consumes the first matching text. Keep the remaining suffix
				// for duplicate prompts, including prompts without image attachments.
				for (const lane of ["steering", "followUp"] as const) {
					const counts = new Map<string, number>();
					for (const text of event[lane]) counts.set(text, (counts.get(text) ?? 0) + 1);
					records[lane] = records[lane].slice().reverse().filter(record => {
						const count = counts.get(record.text) ?? 0; counts.set(record.text, count - 1); return count > 0;
					}).reverse();
				}
			}
			if (event.type === "agent_settled") { imagesBySession.delete(session); unsubscribe(); }
		});
	}
	await session.prompt(input.text, {
		images: input.images, streamingBehavior: queue ? "followUp" : "steer",
		preflightResult: disposition => {
			if (disposition === "queued") {
				const lane = queue ? "followUp" : "steering";
				const native = queue ? session.getFollowUpMessages() : session.getSteeringMessages();
				const accepted = native.at(-1);
				if (accepted !== undefined) pending![lane].push({ text: accepted, images: input.images });
			}
			acknowledge(disposition !== "handled");
		},
	});
}

/** Snapshot attachments before clearQueue emits the empty native queue. */
export function recallPending(session: AgentSession) {
	const pending = imagesBySession.get(session);
	const images = pending ? [...pending.steering, ...pending.followUp].flatMap(record => record.images) : [];
	return { ...session.clearQueue(), images };
}
