import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
	FiChevronDown,
	FiChevronRight,
	FiChevronUp,
	FiEdit3,
	FiImage,
	FiX,
} from "react-icons/fi";
import type {
	PromptAttachment,
	ToolStatus,
	UiBashBlock,
	UiContentBlock,
	UiImageBlock,
	UiMessage,
	UiTextBlock,
	UiThinkingBlock,
	UiToolCallBlock,
} from "../types";
import { toolRecoveryKey } from "../tool-call-recovery";
import { LeakedThinkingBlock } from "./LeakedThinkingBlock";
import { Markdown } from "./Markdown";
import { StreamMarkdown } from "./StreamMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { GrepSummary, isSubagentCall, ReadGroup, SubagentGroup, ToolCallBlock, type ToolView } from "./ToolCallBlock";
import { EditWriteCard, EditWriteGroup } from "./EditWriteCard";
import { useT, type Translate } from "../i18n";
import { splitLeakedThinking } from "../leaked-thinking";
import { parseSkillBlock, type SkillBlock } from "../skill-block";
import { isRasterImage, fileToProcessedImage } from "../image-paste";
import { splitFrontmatter } from "../read-presentation";
import { questionPreviewText } from "../question-markers";
import { preserveUserTree } from "../user-message-presentation";
import type { TodoPresentation } from "../todo-presentation";
import { TodoChecklist } from "./TodoChecklist";

/** 编辑重问编辑器里直接拖入/粘贴文件的上限（与服务端 MAX_UPLOAD_BYTES 一致）。 */
const MAX_EDIT_UPLOAD_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Narrowing guards. UiContentBlock is an open union (its last member is
// `{ type: string; [k: string]: unknown }`), so plain `switch` narrowing does
// not work — same pattern pi-vsc uses in shared/blocks.ts.
// ---------------------------------------------------------------------------

export function asText(block: UiContentBlock): UiTextBlock | null {
	return block.type === "text" &&
		typeof (block as UiTextBlock).text === "string"
		? (block as UiTextBlock)
		: null;
}

export function asThinking(block: UiContentBlock): UiThinkingBlock | null {
	return block.type === "thinking" &&
		typeof (block as UiThinkingBlock).thinking === "string"
		? (block as UiThinkingBlock)
		: null;
}

export function asToolCall(block: UiContentBlock): UiToolCallBlock | null {
	return block.type === "toolCall" &&
		typeof (block as UiToolCallBlock).id === "string" &&
		typeof (block as UiToolCallBlock).name === "string"
		? (block as UiToolCallBlock)
		: null;
}

export function asImage(block: UiContentBlock): UiImageBlock | null {
	return block.type === "image" &&
		typeof (block as UiImageBlock).dataUrl === "string"
		? (block as UiImageBlock)
		: null;
}

export function asBash(block: UiContentBlock): UiBashBlock | null {
	return block.type === "bash" &&
		typeof (block as UiBashBlock).command === "string"
		? (block as UiBashBlock)
		: null;
}

/** Editor chip kind: raster image (thumb), restored upload (uploadPath),
 *  newly-added raw file (fileData) or workspace-path attachment. */
type EditAttKind = "image" | "upload" | "file" | "path";
function editAttKind(att: PromptAttachment): EditAttKind {
	if (att.imageData) return "image";
	if (att.uploadPath) return "upload";
	if (att.fileData) return "file";
	return "path";
}

/** Tooltip label for an editor chip (reuses the chat-input attachment i18n). */
function editAttLabel(att: PromptAttachment, t: Translate): string {
	if (att.editorSnapshot) return `${att.path} · ${t(att.editorSnapshot.dirty ? "currentFileDraft" : "currentFileLabel")}`;
	if (att.imageData) return t("attachImage", { name: att.name ?? "image" });
	if (att.uploadPath) return t("attachFile", { name: att.name ?? att.uploadPath });
	if (att.fileData) return t("attachFile", { name: att.name ?? "file" });
	const base = att.path.split("/").pop() ?? att.path;
	if (att.mode === "lines" && att.lines)
		return t("attachLines", {
			path: base,
			start: att.lines.start,
			end: att.lines.end,
		});
	if (att.mode === "reference") return t("refOnly", { path: base });
	return t("attachContent", { path: base });
}

interface MessageProps {
	todoViews?: ReadonlyMap<string, TodoPresentation>;
	continuation?: boolean;
	message: UiMessage;
	/** toolResult messages by toolCallId (precomputed in MessageList, memoized). */
	toolResults: ReadonlyMap<string, UiMessage>;
	retriedEditIds?: ReadonlySet<string>;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	/** tool_status entries (tool_execution_end) by toolCallId. */
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	streaming: boolean;
	/** True when this is the last rendered message (stream cursor + live blocks). */
	isLast: boolean;
	/** Edit-and-re-ask handler (user messages only). Stable identity — Message is memoized.
	 *  Attachments are the images kept from the original message plus any newly
	 *  pasted/dropped ones; they re-fill the visual context the fork drops. */
	onEdit?: (
		messageId: string,
		text: string,
		attachments?: PromptAttachment[],
	) => void;
	/** Original attachments attached to this question (precomputed in MessageList
	 *  from the attachment-card run that follows it): pasted/uploaded images
	 *  (imageData), uploaded files (uploadPath) and workspace-path attachments
	 *  (path+mode) — restored in the editor because fork(entry.parent) drops
	 *  the persisted attachment asides. */
	questionAttachments?: PromptAttachment[];
	/** Kill the running bash command from its tool card (agent run continues). */
	onKillBash?: () => void;
	/** When set, shows a collapse button (message was expanded from the collapsed view). */
	onCollapse?: (messageId: string) => void;

	/** Question-nav tag (user questions only): ordinal, active highlight, jump. */
	qnIndex?: number;
	qnActive?: boolean;
	onJump?: (messageId: string) => void;
	/** 思考文本是否换行（设置面板开关；false = 不换行横向滚动）。 */
	thinkingWrap?: boolean;
	/** 工具调用是否默认展开（设置面板开关；false = 默认折叠）。 */
	toolsWrap?: boolean;
}

export const Message = memo(function Message({
	todoViews,
	continuation,
	message,
	toolResults,
	retriedEditIds,
	liveOutputs,
	toolStatuses,
	streaming,
	isLast,
	onEdit,
	onKillBash,
	onCollapse,
	questionAttachments,

	qnIndex,
	qnActive,
	onJump,
	thinkingWrap,
	toolsWrap,
}: MessageProps) {
	const t = useT();
	// Inline edit-and-re-ask editor (user messages only).
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	// Attachments kept for the edited message: pre-filled from the original
	// message's attachment cards (fork drops persisted asides — they live on
	// the old branch past the fork point), extended by paste/drop. Mix of
	// imageData (pasted images), uploadPath (restored uploads), fileData
	// (newly added files) and path+mode (workspace attachments).
	const [editAttachments, setEditAttachments] = useState<PromptAttachment[]>([]);
	const [editDragOver, setEditDragOver] = useState(false);
	// Transient inline notice for the editor (oversized/unreadable dropped
	// files) — Message has no toast access, so it renders under the chips.
	const [editNotice, setEditNotice] = useState<string | null>(null);
	const foldableUser = message.role === "user" && message.content.length > 0 && message.content.every((block) => block.type === "text");
	const userContentRef = useRef<HTMLDivElement>(null);
	const [userExpanded, setUserExpanded] = useState(false);
	const [userOverflow, setUserOverflow] = useState(false);
	const [userLineCount, setUserLineCount] = useState(0);
	useLayoutEffect(() => {
		if (!foldableUser || editing || userExpanded) return;
		const node = userContentRef.current;
		if (!node) return;
		const measure = () => {
			setUserOverflow(node.scrollHeight > node.clientHeight + 2);
			const text = message.content.map((block) => asText(block)?.text ?? "").filter(Boolean).join("\n");
			const explicitLines = text.split(/\r?\n/).length;
			const lineHeight = parseFloat(getComputedStyle(node).lineHeight) || 22;
			setUserLineCount(Math.max(explicitLines, Math.ceil(node.scrollHeight / lineHeight)));
		};
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		measure();
		return () => observer.disconnect();
	}, [foldableUser, message.content, editing, userExpanded]);
	const pushEditNotice = (msg: string) => {
		setEditNotice(msg);
		window.setTimeout(
			() => setEditNotice((cur) => (cur === msg ? null : cur)),
			4000,
		);
	};
	// toolResult content is rendered inside its toolCall card — never standalone
	// (otherwise the same output shows twice: formatted card + plain text).
	if (message.role === "toolResult") return null;
	// Attached files are rendered as their own collapsible card, separate from
	// the user message text.
	const isFileAttachment =
		message.role === "custom" && message.customType === "file";
	// Question text for the per-question tag's tooltip.
	const userText = message.content
		.map((b) => asText(b)?.text ?? "")
		.filter(Boolean)
		.join("\n");
	// A user message whose text is a `<skill …>` block (the SDK's /skill:name
	// expansion) renders as a compact collapsible skill card instead of dumping
	// the whole SKILL.md into the user bubble — same as the pi CLI.
	const skillBlock = message.role === "user" ? parseSkillBlock(userText) : null;
	const questionText = questionPreviewText(skillBlock
		? skillBlock.userMessage ?? `skill:${skillBlock.name}`
		: userText);
	const canEdit =
		message.role === "user" && !streaming && !!onEdit;
	/** Paste/drop handler inside the edit composer — same downscale pipeline
	 *  as the main input bar so payloads stay under the server's cap. */
	const addEditImageFiles = async (files: File[]) => {
		const added: PromptAttachment[] = [];
		for (const f of files) {
			if (!isRasterImage(f.type)) continue;
			const img = await fileToProcessedImage(f);
			if (!img) continue;
			added.push({
				path: "",
				imageData: img.data,
				mimeType: img.mimeType,
				name: img.name,
			});
		}
		if (added.length > 0) setEditAttachments((prev) => [...prev, ...added]);
	};
	/** Add a raw uploaded file (non-image, dropped in the editor) — read into
	 *  base64 fileData, same 20MB cap as the main input bar. */
	const addEditFile = async (f: File) => {
		if (f.size > MAX_EDIT_UPLOAD_BYTES) {
			pushEditNotice(t("fileTooLarge", { name: f.name, size: 20 }));
			return;
		}
		let base64: string;
		try {
			const dataUrl = await new Promise<string>((res, rej) => {
				const r = new FileReader();
				r.onload = () => res(r.result as string);
				r.onerror = () => rej(r.error ?? new Error("read failed"));
				r.readAsDataURL(f);
			});
			base64 = dataUrl.replace(/^data:[^;]*;base64,/, "");
		} catch {
			pushEditNotice(t("fileLoadFailed", { name: f.name }));
			return;
		}
		setEditAttachments((prev) => [
			...prev,
			{
				path: "",
				fileData: base64,
				name: f.name,
				size: f.size,
				mimeType: f.type || undefined,
			},
		]);
	};
	/** Add any dropped file: raster images through the resize pipeline, all
	 *  other files (incl. SVG) as raw uploads. */
	const addEditDropFiles = async (files: File[]) => {
		const imgs: File[] = [];
		for (const f of files) {
			if (isRasterImage(f.type)) imgs.push(f);
			else void addEditFile(f);
		}
		if (imgs.length > 0) await addEditImageFiles(imgs);
	};
	const startEdit = () => {
		setDraft(
			skillBlock
				? `/skill:${skillBlock.name}${
						skillBlock.userMessage ? ` ${skillBlock.userMessage}` : ""
				  }`
				: message.content
						.map((b) => asText(b)?.text ?? "")
						.filter(Boolean)
						.join("\n"),
		);
		setEditAttachments(questionAttachments ?? []);
		setEditing(true);
	};
	const submitEdit = () => {
		const text = draft.trim();
		if (!text) return;
		onEdit?.(
			message.id,
			text,
			// Original attachments (images / uploads / path refs) are always
			// preserved — restoring the visual context the fork would drop; a
			// text-only edit with none stays undefined.
			editAttachments.length > 0 ? editAttachments : undefined,
		);
		setEditing(false);
	};

	// Goal-review verdict cards (server customType "goal-review") and wizard
	// progress cards ("goal-wizard") get a distinct frame so they read as goal
	// feedback rather than a plain plugin message.
	const isGoalReview =
		message.role === "custom" &&
		(message.customType === "goal-review" || message.customType === "goal-wizard");
	const isGoalWizard = message.role === "custom" && message.customType === "goal-wizard";
	const recoveryKey = toolRecoveryKey(message);
	const renderContentBlocks = (skipText: boolean): ReactNode[] => {
		if (recoveryKey) return skipText ? [] : [<p key="recovery">{t(recoveryKey)}</p>];
		const elements: ReactNode[] = [];
		const viewFor = (item: UiToolCallBlock): ToolView => ({ result: toolResults.get(item.id), liveOutput: liveOutputs.get(item.id)?.text, status: toolStatuses.get(item.id), streaming });
		for (let i = 0; i < message.content.length; i++) {
			const block = message.content[i];
			if (skipText && block.type === "text") continue;
			const first = asToolCall(block);
			const todoView = first && todoViews?.get(first.id);
			if (first && todoView) {
				elements.push(<TodoChecklist key={first.id} toolCallId={first.id} view={todoView} />);
				continue;
			}
			if (first?.name === "write" || first?.name === "edit") {
				const changes: UiToolCallBlock[] = [first];
				while (i + 1 < message.content.length) {
					const next = asToolCall(message.content[i + 1]);
					if (next?.name !== "write" && next?.name !== "edit") break;
					changes.push(next);
					i++;
				}
				if (changes.length >= 3) elements.push(<EditWriteGroup key={`${message.id}-${first.id}`} items={changes.map((item) => ({ block: item, view: viewFor(item) }))} retriedIds={retriedEditIds} />);
				else elements.push(...changes.map((item) => <EditWriteCard key={`${message.id}-${item.id}`} item={{ block: item, view: viewFor(item) }} retried={retriedEditIds?.has(item.id)} />));
				continue;
			}
			if (first?.name === "read") {
				const reads: UiToolCallBlock[] = [first];
				while (i + 1 < message.content.length) {
					const next = asToolCall(message.content[i + 1]);
					if (next?.name !== "read") break;
					reads.push(next);
					i++;
				}
				elements.push(<ReadGroup key={`${message.id}-${first.id}`} items={reads.map((item) => ({ block: item, view: viewFor(item) }))} wrap={toolsWrap} />);
				continue;
			}
			if (first && isSubagentCall(first)) {
				const agents: UiToolCallBlock[] = [first];
				while (i + 1 < message.content.length) {
					const next = asToolCall(message.content[i + 1]);
					if (!next || !isSubagentCall(next)) break;
					agents.push(next);
					i++;
				}
				elements.push(<SubagentGroup key={`${message.id}-${first.id}`} items={agents.map((item) => ({ block: item, view: viewFor(item) }))} wrap={toolsWrap} startedAt={message.timestamp} />);
				continue;
			}
			if (first?.name === "grep") {
				elements.push(<GrepSummary key={`${message.id}-${first.id}`} block={first} view={viewFor(first)} wrap={toolsWrap} />);
				continue;
			}
			elements.push(<Block key={`${message.id}-${i}`} block={block} user={message.role === "user"} toolResults={toolResults} liveOutputs={liveOutputs} toolStatuses={toolStatuses} streaming={streaming} isLast={isLast && i === message.content.length - 1} onKillBash={onKillBash} toolsWrap={toolsWrap} thinkingWrap={thinkingWrap} />);
		}
		return elements;
	};

	return (
		<div
			className={`msg msg-${message.role}${isGoalReview ? " msg-goal-review" : ""}${continuation ? " msg-continuation" : ""}`}
			data-role={message.role}
			data-msg-id={message.id}
		>
			<div className="msg-meta">
				<span className="msg-role">
					{recoveryKey ? t("toolRecovery") : message.role === "custom"
						? isGoalWizard
							? t("goalWizardCard")
							: isGoalReview
								? t("goalBarTitle")
								: message.customType === "file"
									? t("attachment")
									: `${t("plugin")} · ${message.customType ?? t("unknown")}`
						: roleLabel(message.role, t)}
				</span>
				{message.model && <span className="msg-model">{message.model}</span>}
				{message.timestamp && (
					<span className="msg-time" title={new Date(message.timestamp).toLocaleString()}>{formatTime(message.timestamp)}</span>
				)}
				{onCollapse && (
					<button
						type="button"
						className="msg-collapse-btn"
						title={t("collapseMsg")}
						onClick={() => onCollapse(message.id)}
					>
						<FiChevronDown /> {t("collapseMsg")}
					</button>
				)}
				{qnIndex !== undefined && onJump && (
					<button
						type="button"
						className={`qn-tag ${qnActive ? "active" : ""}`}
						title={`${qnIndex + 1}. ${questionText}`}
						aria-label={`${qnIndex + 1}. ${questionText}`}
						onClick={() => onJump(message.id)}
					>
						<span className="qn-tag-bar" />
						<span className="qn-tag-idx">{qnIndex + 1}</span>
					</button>
				)}
			</div>
			<div className="msg-body">
				{editing ? (
					<div
						className={`msg-editor${editDragOver ? " drag-over" : ""}`}
						onDragOver={(e) => {
							e.preventDefault();
							e.stopPropagation();
							setEditDragOver(true);
						}}
						onDragLeave={(e) => {
							if (!e.currentTarget.contains(e.relatedTarget as Node))
								setEditDragOver(false);
						}}
						onDrop={(e) => {
							e.preventDefault();
							e.stopPropagation();
							setEditDragOver(false);
							void addEditDropFiles(
								Array.from(e.dataTransfer?.files ?? []),
							);
						}}
					>
						{editAttachments.length > 0 && (
							<div className="msg-editor-images">
								{editAttachments.map((att, i) => {
									const kind = editAttKind(att);
									return (
										<span
											key={`${att.name ?? att.path ?? "att"}-${i}`}
											className={`msg-editor-img ${kind === "image" ? "" : "file-chip"}`}
											title={editAttLabel(att, t)}
										>
											{kind === "image" ? (
												<img
													src={`data:${att.mimeType ?? "image/png"};base64,${att.imageData}`}
													alt={att.name}
												/>
											) : (
												<span className="msg-editor-file">
													<span className="msg-editor-file-icon">
														{kind === "path" ? (att.mode === "reference" ? "🔗" : "📎") : "📄"}
													</span>
													<span className="msg-editor-file-name">
														{att.name ?? att.path?.split("/").pop()}
													</span>
												</span>
											)}
											<button
												type="button"
												className="msg-editor-img-remove"
												title={t("removeAttachment")}
												onClick={() =>
													setEditAttachments((prev) =>
														prev.filter((_, j) => j !== i),
													)
												}
											>
												<FiX />
											</button>
										</span>
									);
								})}
							</div>
						)}
						{editNotice && (
							<div className="msg-editor-notice">{editNotice}</div>
						)}
						<textarea
							className="msg-editor-input"
							value={draft}
							autoFocus
							placeholder={t("editPlaceholder")}
							rows={Math.max(2, Math.min(10, draft.split("\n").length + 1))}
							onChange={(e) => setDraft(e.target.value)}
							onPaste={(e) => {
								const images: File[] = [];
								for (const item of e.clipboardData?.items ?? []) {
									if (item.kind === "file" && isRasterImage(item.type)) {
										const f = item.getAsFile();
										if (f) images.push(f);
									}
								}
								if (images.length === 0) return; // plain text paste
								e.preventDefault();
								void addEditImageFiles(images);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									submitEdit();
								} else if (e.key === "Escape") {
									setEditing(false);
								}
							}}
						/>
						<div className="msg-editor-actions">
							<span className="msg-editor-hint">
								<FiImage /> {t("editAttachmentHint")}
							</span>
							<button
								type="button"
								className="chip"
								onClick={() => setEditing(false)}
							>
								{t("cancel")}
							</button>
							<button
								type="button"
								className="chip primary"
								disabled={!draft.trim()}
								title={t("reaskFromHere")}
								onClick={submitEdit}
							>
								<FiEdit3 /> {t("reaskFromHere")}
							</button>
						</div>
					</div>
				) : (
					<>
						{message.errorMessage && (
							<div className="msg-error">{message.errorMessage}</div>
						)}
						{isFileAttachment ? (
							<AttachmentCard message={message} />
						) : skillBlock ? (
							<>
								<SkillCard block={skillBlock} />
								{skillBlock.userMessage && (
									<div className="msg-text">
										<Markdown text={preserveUserTree(skillBlock.userMessage)} fileLinks />
									</div>
								)}
								{renderContentBlocks(true)}
							</>
						) : message.role === "user" ? (
							<div ref={userContentRef} className={`user-message-content${foldableUser && !userExpanded ? " collapsed" : ""}`}>{renderContentBlocks(false)}</div>
						) : (
							renderContentBlocks(false)
						)}
						{foldableUser && userOverflow && !editing && !skillBlock && <button type="button" className="user-message-expand" onClick={() => setUserExpanded(value => !value)}>{userExpanded ? t("collapseCode") : t("expandAllLines", { n: userLineCount })}</button>}

					</>
				)}
			</div>
			{canEdit && !editing && (
				<div className="msg-actions">
					<button
						type="button"
						className="msg-action"
						title={t("editReaskTip")}
						onClick={startEdit}
					>
						<FiEdit3 /> {t("editReask")}
					</button>
				</div>
			)}
		</div>
	);
});

/** Collapsible card for an attached file (customType "file"). */
function AttachmentCard({ message }: { message: UiMessage }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const details = (message.details ?? {}) as {
		editorSnapshot?: PromptAttachment["editorSnapshot"];
		name?: string;
		path?: string;
		mode?: "inline" | "reference" | "lines" | "image" | "bridged";
		size?: number;
		lines?: number;
		startLine?: number;
		endLine?: number;
		type?: "folder";
	};
	const name = details.name ?? details.path ?? t("attachment");
	const isFolder = details.type === "folder";
	const isReference = details.mode === "reference";
	const isBridged = details.mode === "bridged";

	const text = message.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const clean = details.editorSnapshot?.text ?? stripFileWrapper(text);
	const image = message.content.find((b) => b.type === "image") as
		| { type: "image"; dataUrl?: string }
		| undefined;
	const lines = clean.split("\n").length;

	return (
		<div className={`attachcard ${isReference ? "reference" : ""}`}>
			<button
				type="button"
				className="attachcard-head"
				onClick={() => setOpen((v) => !v)}
			>
				<span className="attachcard-icon">{isFolder ? "📁" : "📎"}</span>
				<span className="attachcard-name">{name}</span>
				{details.editorSnapshot && <span className="attachcard-mode">{t(details.editorSnapshot.dirty ? "currentFileDraft" : "currentFileLabel")}</span>}
				{details.path && (
					<span className="attachcard-path">{details.path}</span>
				)}
				<span
					className={`attachcard-mode ${details.mode === "lines" ? "lines" : isReference ? "ref" : isBridged ? "bridged" : "inline"}`}
				>
					{isReference
						? isFolder
							? t("folderRefShort")
							: `${t("refOnlyShort")} · ${formatSize(details.size)}`
						: isBridged
							? t("bridgedVision")
							: image
								? t("image")
								: details.mode === "lines"
									? t("inlineLinesRange", {
											start: details.startLine ?? 1,
											end: details.endLine ?? details.lines ?? 1,
										})
									: t("inlineLines", { n: details.lines ?? lines })}
				</span>
				{!isReference && (open ? <FiChevronDown /> : <FiChevronRight />)}
			</button>
			{!isReference &&
				open &&
				(isBridged ? (
					<>
						<div className="attachcard-bridgenote">{t("bridgedVisionDetail")}</div>
						{image?.dataUrl && (
							<div className="attachcard-image">
								<img src={image.dataUrl} alt={name} />
							</div>
						)}
						{clean && <pre className="attachcard-content">{clean}</pre>}
					</>
				) : image?.dataUrl ? (
					<div className="attachcard-image">
						<img src={image.dataUrl} alt={name} />
					</div>
				) : (
					<pre className="attachcard-content">{clean}</pre>
				))}
			{isReference && (
				<div className="attachcard-refnote">
					{isFolder
						? t("folderNotExpanded")
						: t("fileNotExpanded", { size: formatSize(details.size) })}
				</div>
			)}
		</div>
	);
}

function formatSize(bytes?: number): string {
	if (bytes === undefined) return "";
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

/** Strip the <file path="..."> ``` ... ``` </file> or <vision-bridge> ...
 * </vision-bridge> wrapper for display. */
function stripFileWrapper(text: string): string {
	const m = text.match(
		/^\s*<file path="[^"]*"(?:\s+lines="[^"]*")?>\s*```\s*\n?([\s\S]*?)\n?```\s*<\/file>\s*$/,
	);
	if (m) return m[1].trim();
	const vb = text.match(
		/^\s*<vision-bridge>\s*([\s\S]*?)\s*<\/vision-bridge>\s*$/,
	);
	return vb ? vb[1].trim() : text.trim();
}

/**
 * Compact collapsible card for a skill invocation (the SDK's /skill:name
 * expansion) — the web counterpart of the CLI's SkillInvocationMessageComponent.
 * Collapsed shows a book icon + skill name + file path, expanded shows the
 * full SKILL.md content. The user's own question (args) renders separately.
 */
function SkillCard({ block }: { block: SkillBlock }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const content = splitFrontmatter(block.content);
	return (
		<div className={`skillcard${expanded ? " expanded" : ""}`}>
			<button
				type="button"
				className="skillcard-head"
				onClick={() => setExpanded((v) => !v)}
				title={block.location}
			>
				<span className="skillcard-icon" aria-hidden="true">◆</span>
				<span className="skillcard-name">{t("skillLabel")} · {block.name}</span>
				{expanded && <span className="skillcard-path">{block.location}</span>}
				<span className="skillcard-action">
					{expanded ? <FiChevronUp /> : <FiChevronDown />}
					{expanded ? t("collapseMsg") : t("expandMsg")}
				</span>
			</button>
			{expanded && (
				<div className="skillcard-body">
					{content.fields.length > 0 && <dl className="toolcall-frontmatter">{content.fields.map(({ name, value }) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>}
					<Markdown text={content.body} />
				</div>
			)}
		</div>
	);
}

function Block({
	block,
	user,
	toolResults,
	liveOutputs,
	toolStatuses,
	streaming,
	isLast,
	onKillBash,
	thinkingWrap,
	toolsWrap,
}: {
	block: UiContentBlock;
	user?: boolean;
	toolResults: ReadonlyMap<string, UiMessage>;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	streaming: boolean;
	isLast: boolean;
	onKillBash?: () => void;
	/** 思考文本是否换行（false = 不换行横向滚动）。 */
	thinkingWrap?: boolean;
	/** 工具调用是否默认展开（false = 默认折叠）。 */
	toolsWrap?: boolean;
}) {
	const t = useT();
	const text = asText(block);
	if (text) {
		const live = streaming && isLast;
		// Applied while streaming too: a half-emitted tag (`</thin`) simply
		// doesn't match the regex, so there is nothing to false-split on —
		// it folds away the moment the tag completes. Skipping this during
		// streaming meant the leak sat in plain view for the whole turn,
		// which is precisely when the user is watching.
		const leak = splitLeakedThinking(text.text);
		const body = leak ? leak.visible : text.text;
		if (!body.trim() && !leak?.leaked.trim() && !text.truncated) return null;
		return (
			<div className="msg-text">
				{leak && <LeakedThinkingBlock text={leak.leaked} />}
				{body &&
					(live ? (
						<StreamMarkdown text={user ? preserveUserTree(body) : body} />
					) : (
						<Markdown text={user ? preserveUserTree(body) : body} fileLinks={user} />
					))}
				{text.truncated && <div className="trunc-note">{t("truncated")}</div>}
			</div>
		);
	}

	const thinking = asThinking(block);
	if (thinking) {
		if (!thinking.thinking.trim()) return null;
		return (
			<ThinkingBlock
				thinking={thinking.thinking}
				durationMs={thinking.durationMs}
				streaming={streaming && isLast}
				wrap={thinkingWrap}
			/>
		);
	}

	const toolCall = asToolCall(block);
	if (toolCall) {
		const result = toolResults.get(toolCall.id);
		const live = liveOutputs.get(toolCall.id);
		const view: ToolView = {
			result,
			liveOutput: live?.text,
			streaming,
			status: toolStatuses.get(toolCall.id),
		};
		return <ToolCallBlock block={toolCall} view={view} onKillBash={onKillBash} wrap={toolsWrap} />;
	}

	const image = asImage(block);
	if (image && image.dataUrl) {
		return (
			<div className="msg-image">
				<img src={image.dataUrl} alt="attachment" />
			</div>
		);
	}

	const bash = asBash(block);
	if (bash) {
		return (
			<div className="bashblock">
				<div className="bashblock-command">
					<span className="bashblock-prompt">$</span>
					<code>{bash.command}</code>
					{bash.exitCode !== undefined && (
						<span
							className={`bashblock-exit ${bash.exitCode === 0 ? "ok" : "err"}`}
						>
							{t("exitCode", { code: bash.exitCode })}
						</span>
					)}
					{bash.cancelled && (
						<span className="bashblock-exit err">{t("cancelled")}</span>
					)}
				</div>
				{bash.output && <pre className="bashblock-output">{bash.output}</pre>}
				{bash.truncated && (
					<div className="trunc-note">{t("outputTruncated")}</div>
				)}
			</div>
		);
	}

	return null;
}

export function roleLabel(role: string, t: Translate): string {
	switch (role) {
		case "user":
			return t("role.user");
		case "assistant":
			return t("role.assistant");
		case "toolResult":
			return t("role.tool");
		case "bashExecution":
			return t("role.bash");
		case "branchSummary":
			return t("role.branch");
		case "compactionSummary":
			return t("role.compaction");
		default:
			return role;
	}
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}
