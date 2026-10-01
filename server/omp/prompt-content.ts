import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { randomUUID } from "node:crypto";

export type AttachmentAside = { message: Pick<CustomMessage, "customType" | "content" | "display" | "details"> };
export type PromptThumbnails = { id: string; images: ImageContent[] };
const START = "\n\n<omp-web-attachments version=\"1\">\n";
const END = "\n</omp-web-attachments>";

/** One native user submission owns question, file context and images. No separately queued asides. */
export function encodePrompt(text: string, asides: AttachmentAside[]): { message: string; images?: ImageContent[]; thumbnails?: PromptThumbnails } {
	if (!asides.length) return { message: text };
	const images: ImageContent[] = [];
	const thumbnails: PromptThumbnails = { id: randomUUID(), images: [] };
	const cards = asides.map(({ message }) => ({ ...message, content: typeof message.content === "string" ? message.content : message.content.map(part => {
		if (part.type !== "image") return part;
		if ((message.details as { mode?: string } | undefined)?.mode === "bridged") {
			return { type: "thumbnail", imageIndex: thumbnails.images.push(part) - 1 };
		}
		const imageIndex = images.push(part) - 1;
		return { type: "attached_image", imageIndex };
	}) }));
	return { message: text + START + JSON.stringify({ question: text, cards, ...(thumbnails.images.length ? { thumbnailsId: thumbnails.id } : {}) }) + END, ...(images.length ? { images } : {}), ...(thumbnails.images.length ? { thumbnails } : {}) };
}

/** Display projection only: OMP's persisted transcript remains the original atomic submission. */
export function projectPrompt(message: AgentMessage, thumbnails = new Map<string, ImageContent[]>()): AgentMessage[] {
	if (message.role !== "user") return [message];
	const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	const text = content.filter(p => p.type === "text").map(p => p.text).join("\n");
	const start = text.lastIndexOf(START), end = text.indexOf(END, start);
	if (start < 0 || end < 0) return [message];
	try {
		const payload = JSON.parse(text.slice(start + START.length, end)) as { question?: unknown; cards?: unknown; thumbnailsId?: string };
		if (typeof payload.question !== "string" || !Array.isArray(payload.cards)) return [message];
		const images = content.filter(p => p.type === "image");
		const cards: CustomMessage[] = [];
		for (const raw of payload.cards) {
			if (!raw || typeof raw.customType !== "string" || (typeof raw.content !== "string" && !Array.isArray(raw.content))) return [message];
			const cardContent = typeof raw.content === "string" ? raw.content : raw.content.flatMap((part: { type?: string; imageIndex?: number; text?: string }) => {
				if (part?.type === "text" && typeof part.text === "string") return [{ type: "text" as const, text: part.text }];
				const source = part?.type === "attached_image" ? images : part?.type === "thumbnail" ? thumbnails.get(payload.thumbnailsId ?? "") : undefined;
				return Number.isInteger(part?.imageIndex) && source?.[part.imageIndex!] ? [source[part.imageIndex!]] : [];
			});
			cards.push({ role: "custom", customType: raw.customType, content: cardContent, details: raw.details, display: raw.display !== false, timestamp: message.timestamp, attribution: "user" });
		}
		return [...cards, { ...message, content: payload.question }];
	} catch { return [message]; }
}
