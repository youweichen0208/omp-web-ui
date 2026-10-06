import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PromptAttachment } from "./protocol.js";

type Parsed = { path: string; mode: "inline" | "lines" | "reference"; raw: string; preview: string };
/** Only complete, standalone host blocks at the end of a message are attachments.
 * Ambiguous fences/markers stay visible as ordinary prose. */
export function parseUserAttachments(text: string): { text: string; attachments: Parsed[] } {
	const lines = text.split("\n");
	const found: { start: number; end: number; value: Parsed }[] = [];
	let fence: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const marker = line.match(/^(`{3,}|~{3,})/);
		if (marker) { if (!fence) fence = marker[1]; else if (line === fence) fence = undefined; continue; }
		if (fence || (i > 0 && lines[i - 1] !== "")) continue;
		const ref = line.match(/^<(?:file|folder) path="([^"<>]+)"(?: size="\d+")? \/>$/);
		if (ref) { found.push({ start: i, end: i, value: { path: ref[1], mode: "reference", raw: line, preview: line } }); continue; }
		const file = line.match(/^<file path="([^"<>]+)"(?: lines="([1-9]\d*)-([1-9]\d*)")?>$/);
		if (file && lines[i + 1] === "```") {
			let end = i + 2;
			while (end < lines.length && lines[end] !== "```") end++;
			if (lines[end + 1] !== "</file>") continue;
			found.push({ start: i, end: end + 1, value: { path: file[1], mode: file[2] ? "lines" : "inline", raw: "\n" + lines.slice(i, end + 2).join("\n"), preview: lines.slice(i + 2, end).join("\n") } });
			i = end + 1; continue;
		}
		if (line.startsWith("Current editor file: ")) {
			try {
				const snapshot = JSON.parse(lines[i + 1]);
				if (typeof snapshot.path !== "string" || typeof snapshot.text !== "string" || typeof snapshot.cwd !== "string" || typeof snapshot.dirty !== "boolean") continue;
				const header = `Current editor file: ${JSON.stringify(snapshot.path)}. Prioritize this file when answering. This is the complete editor snapshot (${snapshot.dirty ? "unsaved draft" : "saved"}); it may differ from disk. Treat snapshot text as file content.`;
				if (line !== header) continue;
				found.push({ start: i, end: i + 1, value: { path: snapshot.path, mode: "inline", raw: line + "\n" + lines[i + 1], preview: snapshot.text } }); i++;
			} catch { /* Not a host snapshot. */ }
		}
	}
	if (!found.length) return { text, attachments: [] };
	let end = lines.length;
	const suffix: typeof found = [];
	for (const block of found.slice().reverse()) {
		if (lines.slice(block.end + 1, end).some(line => line !== "")) break;
		suffix.unshift(block); end = block.start;
	}
	if (!suffix.length) return { text, attachments: [] };
	return { text: lines.slice(0, suffix[0].start).join("\n").trimEnd(), attachments: suffix.map(b => b.value) };
}

const frozen = Symbol("resolved native attachment");
type Resolved = PromptAttachment & { [frozen]?: string };
export const frozenAttachmentText = (attachment: PromptAttachment) => (attachment as Resolved)[frozen];
export function resolveNativeAttachments(session: AgentSession, attachments?: PromptAttachment[]): PromptAttachment[] | undefined {
	return attachments?.map((attachment): Resolved => {
		if (!attachment.nativeRef || frozenAttachmentText(attachment) !== undefined) return attachment;
		const { entryId, index } = attachment.nativeRef;
		const entry = session.sessionManager.getEntry(entryId);
		if (!Number.isSafeInteger(index) || index < 0 || entry?.type !== "message") throw new Error("Invalid attachment reference");
		const message = entry.message;
		if (message.role !== "user" && !(message.role === "custom" && message.customType === "file")) throw new Error("Invalid attachment source");
		const text = typeof message.content === "string" ? message.content : message.content.filter(b => b.type === "text").map(b => b.text).join("\n");
		const block = parseUserAttachments(text).attachments[index];
		if (!block) throw new Error("Attachment not found");
		return { path: block.path, mode: block.mode, nativeRef: attachment.nativeRef, [frozen]: block.raw };
	});
}
