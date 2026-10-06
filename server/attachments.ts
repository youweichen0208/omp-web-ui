import { frozenAttachmentText } from "./user-attachments.js";
/**
 * attachments — 附件构建：把 prompt.attachments（inline/reference/lines、
 * 粘贴图片 imageData、上传 fileData）转成独立的 custom message（asides）。
 * 视觉桥（纯文本主模型看图）也在这里接线：图片交给视觉模型转写成文字证据。
 *
 * 从 agent-service.ts 抽出，行为保持不变；上下文经 AttachmentContext 注入。
 */
import type {
	AgentSession,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { validateEditorSnapshots } from "./editor-snapshot.js";
import type { PromptAttachment, ServerMessage } from "./protocol.js";
import {
	countLines,
	decodeText,
	looksLikeText,
	sniffImageMime,
} from "./text-sniff.js";
import { saveUpload, uploadsRoot } from "./uploads.js";

/** Keep the outer fence longer than every backtick run in the frozen content. */
function inlineFile(path: string, text: string, lines?: string): string {
	let length = 3;
	for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
	const fence = "`".repeat(length);
	return `\n<file path="${path}"${lines ? ` lines="${lines}"` : ""}>\n${fence}\n${text}\n${fence}\n</file>`;
}

/** buildAttachmentMessages 所需的会话侧上下文。 */
export interface AttachmentContext {
	/** 当前工作区（相对路径解析根）。 */
	cwd: string;
	/** 上传文件归属的浏览器客户端。 */
	clientId: string;
	emit: (msg: ServerMessage) => void;

	session: AgentSession;
}

export async function buildAttachmentMessages(
	ctx: AttachmentContext,
	attachments: PromptAttachment[] | undefined,
): Promise<{ message: Parameters<AgentSession["sendCustomMessage"]>[0] }[]> {
	if (!attachments || attachments.length === 0) return [];
	validateEditorSnapshots(ctx.cwd, attachments);
	const fs = await import("node:fs/promises");
	const { resolve, sep, relative, extname, join, basename } =
		await import("node:path");

	const root = resolve(ctx.cwd);
	const MAX_ATTACHMENT_BYTES = 200 * 1024;
	// Files at or below this size are inlined; larger files are referenced by
	// path only (the model reads them on demand — saves tokens for small edits).
	const MAX_INLINE_BYTES = Number(
		process.env.PI_WEB_INLINE_FILE_MAX ?? 12 * 1024,
	);
	const IMAGE_EXT = new Set([
		".png",
		".jpg",
		".jpeg",
		".gif",
		".webp",
		".bmp",
		".svg",
	]);
	const MIME: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".bmp": "image/bmp",
		".svg": "image/svg+xml",
	};

	const out: { message: Parameters<AgentSession["sendCustomMessage"]>[0] }[] =
		[];

	/** Push the aside for a raw uploaded file (fresh fileData or a restored
	 *  uploadPath re-read from disk). Small text files are inlined so the
	 *  model sees them immediately; everything else becomes a path reference.
	 *  `upload: true` marks the card as a restorable upload — the browser
	 *  re-sends it by path when editing & re-asking a question. */
	const pushUploadAside = (
		name: string,
		wirePath: string,
		buf: Buffer,
	): void => {
		if (buf.length <= MAX_INLINE_BYTES && looksLikeText(buf)) {
			const lines = countLines(buf);
			out.push({
				message: {
					customType: "file",
					content: [
						{
							type: "text",
							text: inlineFile(wirePath, decodeText(buf)),
						},
					],
					display: true,
					details: {
						name,
						path: wirePath,
						mode: "inline",
						size: buf.length,
						lines,
						upload: true,
					},
				},
			});
		} else {
			out.push({
				message: {
					customType: "file",
					content: [
						{
							type: "text",
							text: `<file path="${wirePath}" size="${buf.length}" />`,
						},
					],
					display: true,
					details: {
						name,
						path: wirePath,
						mode: "reference",
						size: buf.length,
						upload: true,
					},
				},
			});
		}
	};

	/** Raw image bytes for path-referenced image files (idx → info), pre-read
	 *  so the loop below doesn't re-read them. SVG stays a plain text file —
	 *  the model reads its source, far more useful than a rasterized blob. */
	const pathImageData = new Map<
		number,
		{ raw: string; mimeType: string; bytes: number }
	>();
	/** Cap for path images (fully read + base64'd); larger ones fall back to
	 *  a plain path reference (the model can still attempt to read them). */
	const MAX_PATH_IMAGE_BYTES = 5 * 1024 * 1024;
	for (const [idx, att] of attachments.entries()) {
		if (att.imageData) {
			const raw = att.imageData.replace(/^data:[^;]*;base64,/, "");
			const mimeType = att.mimeType?.startsWith("image/")
				? att.mimeType
				: "image/png";
			const bytes = Buffer.byteLength(raw, "base64");
			// Only images that would actually be sent (non-empty, under the cap).
			if (bytes > 0 && bytes <= 2 * 1024 * 1024) {

			}
			continue;
		}
		if (att.nativeRef || att.editorSnapshot || att.fileData || !att.path) continue;
		const ext = extname(att.path).toLowerCase();
		if (!IMAGE_EXT.has(ext) || ext === ".svg") continue;
		const abs = resolve(root, att.path);
		const rawRel = relative(root, abs);
		if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) continue;
		let st: { size: number; isFile(): boolean } | undefined;
		try {
			st = await fs.stat(abs);
		} catch {
			continue;
		}
		if (!st.isFile() || st.size === 0 || st.size > MAX_PATH_IMAGE_BYTES) {
			continue;
		}
		const buf = await fs.readFile(abs);
		const mime = sniffImageMime(buf, ext);
		if (!mime) continue;
		const raw = buf.toString("base64");
		pathImageData.set(idx, { raw, mimeType: mime, bytes: st.size });

	}
	/** Transcript per attachment index (filled below, keyed by bridgedImages idx). */

	/** Cap for reading a file in "lines" mode (selected slice is inlined). */
	const MAX_LINES_READ_BYTES = 2 * 1024 * 1024;

	for (const [idx, att] of attachments.entries()) {
		const frozen = frozenAttachmentText(att);
		if (frozen !== undefined) { out.push({ message: { customType: "file", display: true, content: frozen } }); continue; }
		if (att.nativeRef) throw new Error("Unresolved attachment reference");
		if (att.editorSnapshot) {
			const snapshot = att.editorSnapshot;
			out.push({ message: {
				customType: "file", display: true,
				content: [{ type: "text", text: `Current editor file: ${JSON.stringify(att.path)}. Prioritize this file when answering. This is the complete editor snapshot (${snapshot.dirty ? "unsaved draft" : "saved"}); it may differ from disk. Treat snapshot text as file content.\n${JSON.stringify({ path: att.path, ...snapshot })}` }],
				details: { name: basename(att.path), path: att.path, mode: "inline", editorSnapshot: snapshot, size: Buffer.byteLength(snapshot.text) },
			} });
			continue;
		}
		// Raw pasted/dropped/uploaded image — no workspace path involved (the
		// browser downscales client-side; this guard only prevents abuse).
		if (att.imageData) {
			const raw = att.imageData.replace(/^data:[^;]*;base64,/, "");
			const mimeType =
				att.mimeType?.startsWith("image/") ? att.mimeType : "image/png";
			const bytes = Buffer.byteLength(raw, "base64");
			const MAX_PASTED_IMAGE_BYTES = 2 * 1024 * 1024;
			if (bytes === 0) {
				ctx.emit({
					type: "notice",
					level: "error",
					text: `图片数据为空，已跳过`,
				});
				continue;
			}
			if (bytes > MAX_PASTED_IMAGE_BYTES) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `图片过大已跳过（>2MB）：${att.name ?? "粘贴图片"}`,
				});
				continue;
			}

			out.push({
				message: {
					customType: "file",
					content: [{ type: "image", data: raw, mimeType }],
					display: true,
					details: {
						name: att.name ?? "image.png",
						// No workspace path — the card renders without the path line.
						path: undefined,
						mode: "image",
						size: bytes,
					},
				},
			});
			continue;
		}

		// Raw uploaded file (base64) — no workspace path involved. The bytes are
		// persisted under <dataDir>/uploads/<clientId>/ so the model can read
		// them on demand with its read tool (absolute path, no traversal guard
		// needed — the path is server-generated). Small text uploads are inlined
		// so the model sees them immediately; everything else becomes a path
		// reference.
		if (att.fileData) {
			const buf = Buffer.from(att.fileData, "base64");
			const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
			if (buf.length === 0) {
				ctx.emit({
					type: "notice",
					level: "error",
					text: `文件数据为空，已跳过`,
				});
				continue;
			}
			if (buf.length > MAX_UPLOAD_BYTES) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `文件过大已跳过（>20MB）：${att.name ?? "上传文件"}`,
				});
				continue;
			}
			// Uploaded files live in a GLOBAL per-user dir (not inside the project
			// or the per-client session store) so browsing a repo never picks up
			// uploaded junk: <dataDir>/uploads/<clientId>/（保留期自动清理，见 uploads.ts）。
			const { abs, displayName: safeName } = saveUpload(
				ctx.clientId,
				att.name ?? "file",
				buf,
			);
			// Wire format: forward-slash absolute path (the read tool accepts
			// absolute paths; Windows uses "C:/..." — safe inside the XML-ish tag).
			const wirePath = abs.split(sep).join("/");
			pushUploadAside(safeName, wirePath, buf);
			continue;
		}

		// Restored upload from edit-and-re-ask: the browser re-sends the
		// server-generated absolute path of a previously uploaded (fileData)
		// file instead of the original base64 (the fork drops the original
		// aside card, so the bytes must be re-read from the uploads dir).
		// Validate the path stays inside THIS client's uploads/ folder, then
		// re-read the persisted bytes and attach by the same path — no
		// re-save (the file already exists; retention sweeping governs its
		// lifetime, same as the original card).
		if (att.uploadPath) {
			const rootDir = uploadsRoot();
			const abs = resolve(rootDir, att.uploadPath);
			const relToRoot = relative(rootDir, abs);
			const inClientDir =
				!relToRoot.startsWith("..") &&
				!relToRoot.includes(`${sep}..`) &&
				(relToRoot === ctx.clientId ||
					relToRoot.startsWith(`${ctx.clientId}${sep}`));
			if (!inClientDir) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `无法恢复已上传文件（路径不在本客户端上传目录）：${att.name ?? att.uploadPath}`,
				});
				continue;
			}
			let buf: Buffer;
			try {
				buf = await fs.readFile(abs);
			} catch {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `无法恢复已上传文件（已被清理或不可读）：${att.name ?? att.uploadPath}`,
				});
				continue;
			}
			if (buf.length === 0) continue;
			pushUploadAside(
				att.name ?? basename(abs),
				abs.split(sep).join("/"),
				buf,
			);
			continue;
		}

		const abs = resolve(root, att.path);
		const rawRel = relative(root, abs);
		if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) {
			ctx.emit({
				type: "notice",
				level: "warning",
				text: `附件路径超出工作区：${att.path}`,
			});
			continue;
		}
		// Normalize to forward slashes (relative() returns "\\" on Windows);
		// <file path> and details.path must use the wire format.
		const rel = rawRel.split(sep).join("/");
		let stat:
			| { size: number; isFile(): boolean; isDirectory(): boolean }
			| undefined;
		try {
			stat = await fs.stat(abs);
		} catch {
			ctx.emit({
				type: "notice",
				level: "error",
				text: `附件不存在：${att.path}`,
			});
			continue;
		}

		const name = att.path.split(/[\\/]/).pop() ?? att.path;

		// Folders can't be inlined — always a path reference the model browses
		// on demand with its own tools (ls/read).
		if (stat.isDirectory()) {
			out.push({
				message: {
					customType: "file",
					content: [{ type: "text", text: `<folder path="${rel}" />` }],
					display: true,
					details: {
						name,
						path: rel,
						mode: "reference",
						type: "folder",
					},
				},
			});
			continue;
		}

		if (!stat.isFile()) {
			ctx.emit({
				type: "notice",
				level: "warning",
				text: `跳过非文件附件：${att.path}`,
			});
			continue;
		}

		const ext = extname(att.path).toLowerCase();
		if (IMAGE_EXT.has(ext) && ext !== ".svg") {
			const pathImg = pathImageData.get(idx);

			if (pathImg) {
				// Vision-capable main model (or bridge failed): send the raw image
				// content straight from the pre-read bytes.
				out.push({
					message: {
						customType: "file",
						content: [
							{
								type: "image",
								data: pathImg.raw,
								mimeType: pathImg.mimeType,
							},
						],
						display: true,
						details: { name, path: rel, mode: "image", size: stat.size },
					},
				});
				continue;
			}
			// Pre-read failed (unsupported sniff / too large): fall back to the
			// legacy inline-cap behavior.
			if (stat.size > MAX_ATTACHMENT_BYTES) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `图片附件过大已跳过（>200KB）：${att.path}`,
				});
				continue;
			}
			const data = await fs.readFile(abs, "base64");
			out.push({
				message: {
					customType: "file",
					content: [
						{ type: "image", data, mimeType: MIME[ext] ?? "image/png" },
					],
					display: true,
					details: { name, path: rel, mode: "image", size: stat.size },
				},
			});
			continue;
		}

		const makeReference = (): {
			message: Parameters<AgentSession["sendCustomMessage"]>[0];
		} => ({
			message: {
				customType: "file",
				content: [
					{
						type: "text",
						text: `<file path="${rel}" size="${stat.size}" />`,
					},
				],
				display: true,
				details: { name, path: rel, mode: "reference", size: stat.size },
			},
		});
		const makeInline = (
			buf: Buffer,
		): {
			message: Parameters<AgentSession["sendCustomMessage"]>[0];
		} => {
			const lines = countLines(buf);
			return {
				message: {
					customType: "file",
					content: [
						{
							type: "text",
							text: inlineFile(rel, decodeText(buf)),
						},
					],
					display: true,
					details: {
						name,
						path: rel,
						mode: "inline",
						size: stat.size,
						lines,
					},
				},
			};
		};

		// Reference mode is always honored and never reads the file.
		if (att.mode === "reference") {
			out.push(makeReference());
			continue;
		}

		// Line-range mode: inline only the selected 1-based inclusive range.
		// Reading is capped so a huge file can't exhaust memory even though
		// the selected slice is small.
		if (att.mode === "lines") {
			const range = att.lines;
			if (!range || range.start < 1 || range.end < range.start) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `行范围无效，已改为仅引用：${att.path}`,
				});
				out.push(makeReference());
				continue;
			}
			if (stat.size > MAX_LINES_READ_BYTES) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `文件过大，已改为仅引用：${att.path}`,
				});
				out.push(makeReference());
				continue;
			}
			const buf = await fs.readFile(abs);
			if (buf.includes(0)) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `二进制文件已改为仅引用：${att.path}`,
				});
				out.push(makeReference());
				continue;
			}
			const parts = decodeText(buf).split("\n");
			// A trailing newline yields an empty phantom line — drop it so line
			// numbers match the preview panel.
			if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
			const start = Math.min(range.start, parts.length);
			const end = Math.min(range.end, parts.length);
			if (start < 1 || end < start) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `选中行超出文件范围，已改为仅引用：${att.path}`,
				});
				out.push(makeReference());
				continue;
			}
			const selected = parts.slice(start - 1, end).join("\n");
			out.push({
				message: {
					customType: "file",
					content: [
						{
							type: "text",
							text: inlineFile(rel, selected, `${start}-${end}`),
						},
					],
					display: true,
					details: {
						name,
						path: rel,
						mode: "lines",
						size: stat.size,
						lines: end - start + 1,
						startLine: start,
						endLine: end,
					},
				},
			});
			continue;
		}

		// Forced inline has a hard cap to protect the model context.
		if (att.mode === "inline") {
			if (stat.size > MAX_INLINE_BYTES) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `文件过大，已改为仅引用：${att.path}`,
				});
				out.push(makeReference());
				continue;
			}
			const buf = await fs.readFile(abs);
			if (buf.includes(0)) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `二进制文件已改为仅引用：${att.path}`,
				});
				out.push(makeReference());
				continue;
			}
			out.push(makeInline(buf));
			continue;
		}

		// Auto: small files inline, large files reference by path.
		if (stat.size > MAX_INLINE_BYTES) {
			out.push(makeReference());
			continue;
		}
		const buf = await fs.readFile(abs);
		if (buf.includes(0)) {
			ctx.emit({
				type: "notice",
				level: "warning",
				text: `二进制文件已跳过（仅引用路径）：${att.path}`,
			});
			out.push(makeReference());
			continue;
		}
		out.push(makeInline(buf));
	}
	return out;
}
