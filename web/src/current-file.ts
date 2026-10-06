import type { PromptAttachment } from "../../server/protocol.js";

export interface CurrentFileContext {
	id: string;
	cwd: string;
	path: string;
	name: string;
	dirty: boolean;
}
export type ReadCurrentFile = (openId: string) => PromptAttachment | null;
/** Save-on-send: flush the open file's dirty draft to disk before the prompt
 *  goes out. Returns false when the flush cannot start (not eligible, a save
 *  already in flight, offline) — the caller must block the send. `next` runs
 *  only after a successful save; a conflict/failure surfaces in the existing
 *  conflict UI and never calls it. */
export type SaveCurrentFile = (openId: string, next: () => void) => boolean;

export function mergeCurrentFile(attachments: PromptAttachment[], current: PromptAttachment): PromptAttachment[] {
	const normalize = (path: string) => {
		const slashPath = path.replace(/\\/g, "/");
		const full = /^(?:\/|[A-Za-z]:\/)/.test(slashPath) ? slashPath : `${current.editorSnapshot?.cwd ?? ""}/${slashPath}`;
		const parts: string[] = [];
		for (const part of full.split("/")) {
			if (part === "..") parts.pop();
			else if (part && part !== ".") parts.push(part);
		}
		return parts.join("/");
	};
	return [...attachments.filter((a) => a.nativeRef || a.mode === "lines" || a.imageData || a.fileData || a.uploadPath ||
		normalize(a.path) !== normalize(current.path)), current];
}
