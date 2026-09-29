import { memo } from "react";
import { FiChevronRight } from "react-icons/fi";
import type { UiMessage } from "../types";
import { useT } from "../i18n";
import {
	asBash,
	asImage,
	asText,
	asThinking,
	asToolCall,
	roleLabel,
} from "./Message";

import { toolRecoveryKey } from "../tool-call-recovery";
import { collapsedPreview } from "../collapsed-groups";

interface CollapsedGroupProps {
	/** One run of consecutive same-role messages (see collapsed-groups.ts). */
	messages: UiMessage[];
	onExpand: (messageIds: string[]) => void;
}

/** Distinct tool names to name before falling back to `+n`. */
const MAX_TOOL_CHIPS = 4;

/**
 * Cheap summary row for a run of messages outside the recent window. Renders NO
 * heavy content (no Markdown, no thinking, no tool output, no attachments) —
 * just a role label, a plain-text preview and what the round actually did. The
 * full messages are only rendered after the user clicks to expand.
 */
export const CollapsedGroup = memo(function CollapsedGroup({
	messages,
	onExpand,
}: CollapsedGroupProps) {
	const t = useT();
	const head = messages[0];

	// Plain-text preview: the first text block of the run, first line, ~90 chars
	// (no Markdown). Skill invocations collapse to a `skill:name · <args>` chip
	// instead of the raw SKILL.md dump.
	let preview = "";
	outer: for (const m of messages) {
		const recoveryKey = toolRecoveryKey(m);
		if (recoveryKey) { preview = t(recoveryKey); break; }
		for (const b of m.content) {
			const text = asText(b);
			if (text && text.text.trim()) {
				preview = collapsedPreview(text.text, m.role === "assistant");
				if (preview) break outer;
			}
		}
	}
	// Attached files get their name as the preview.
	if (!preview && head.role === "custom" && head.customType === "file") {
		const details = (head.details ?? {}) as { name?: string; path?: string };
		preview = details.name ?? details.path ?? "";
	}
	if (preview.length > 90) preview = `${preview.slice(0, 90)}…`;

	// What the run did. Naming the tools (`read ×2`) says far more than the old
	// opaque `工具调用 2`, and costs nothing — the name is already on the block.
	const tools = new Map<string, number>();
	let thinking = 0;
	let bash = 0;
	let images = 0;
	for (const m of messages) {
		for (const b of m.content) {
			const call = asToolCall(b);
			if (call) {
				tools.set(call.name, (tools.get(call.name) ?? 0) + 1);
				continue;
			}
			if (asThinking(b)) thinking++;
			else if (asBash(b)) bash++;
			else if (asImage(b)) images++;
		}
	}

	const named = [...tools.entries()].sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
	);
	const chips: { key: string; label: string; kind: string }[] = [];
	for (const [name, n] of named.slice(0, MAX_TOOL_CHIPS)) {
		chips.push({ key: `t:${name}`, label: count(name, n), kind: "tool" });
	}
	if (named.length > MAX_TOOL_CHIPS) {
		chips.push({
			key: "t:more",
			label: `+${named.length - MAX_TOOL_CHIPS}`,
			kind: "tool",
		});
	}
	if (thinking)
		chips.push({
			key: "thinking",
			label: count(t("thinking"), thinking),
			kind: "meta",
		});
	if (bash)
		chips.push({
			key: "bash",
			label: count(t("bashRuns"), bash),
			kind: "meta",
		});
	if (images)
		chips.push({
			key: "images",
			label: count(t("images"), images),
			kind: "meta",
		});

	const label = toolRecoveryKey(head)
		? t("toolRecovery")
		: head.role === "custom" && head.customType === "file"
			? t("attachment")
			: roleLabel(head.role, t);
	const ids = messages.map((m) => m.id);

	return (
		<button
			type="button"
			className="msg-collapsed"
			data-msg-id={head.id}
			title={`${t("expandMsg")} · ${preview || chips.map((c) => c.label).join(" · ") || head.role}`}
			onClick={() => onExpand(ids)}
		>
			<span className={`msg-collapsed-role role-${head.role}`}>{label}</span>
			<span className="msg-collapsed-body">
				{preview && <span className="msg-collapsed-preview">{preview}</span>}
				{chips.length > 0 && (
					<span className="msg-collapsed-chips">
						{chips.map((c) => (
							<span key={c.key} className={`msg-collapsed-chip is-${c.kind}`}>
								{c.label}
							</span>
						))}
					</span>
				)}
			</span>
			{head.timestamp ? (
				<span className="msg-collapsed-time">{formatTime(head.timestamp)}</span>
			) : null}
			<span className="msg-collapsed-action" aria-hidden="true">
				<FiChevronRight />
			</span>
		</button>
	);
});

/** `read` / `read ×3` — the multiplier is noise when there is only one. */
function count(label: string, n: number): string {
	return n > 1 ? `${label} ×${n}` : label;
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}
