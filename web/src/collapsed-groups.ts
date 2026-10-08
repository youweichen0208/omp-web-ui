import { goalEventText, goalCompletedText } from "./goal-events.js";
import { skillAwarePreview } from "./skill-block.js";
import { splitLeakedThinking } from "./leaked-thinking.js";

/** Lightweight plain-text summary; full Markdown is rendered only on expansion. */
export function collapsedPreview(text: string, assistant = true): string {
	const visible = assistant ? splitLeakedThinking(text)?.visible ?? text : text;
	return skillAwarePreview(visible)
		.replace(/`+([^`]+)`+/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_match, bold, underline) => bold ?? underline)
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/^#{1,6}\s+/, "");
}
// 直接引协议源（而不是 ./types）：这个模块也被 tsconfig.tests.json 编译，
// 那边是 NodeNext 解析，要求显式扩展名，而 web/src/types.ts 的再导出写法
// 不带扩展名。纯类型导入，构建时整体擦除，运行时不解析这条路径。
import type { UiMessage } from "../../server/protocol.js";

/**
 * A run of consecutive collapsed messages that renders as a single summary row.
 *
 * The transcript stores one assistant *message* per model turn, so a single
 * "PI ran a few tools and answered" round trip can be 8 messages. Rendered one
 * row each, an old conversation degenerates into a ladder of identical
 * `PI · 工具调用 1 · 展开` strips that carries almost no information. Grouping
 * the run back together restores the unit the user actually thinks in.
 */
export interface CollapsedGrouping {
	/** Index of a run's first member → every message in that run (≥ 1). */
	groupAt: Map<number, UiMessage[]>;
	/** Indices folded into an earlier run (or invisible) — render nothing. */
	absorbed: Set<number>;
}

/**
 * Group the collapsed region (`[0, recentStart)`) into runs of same-role
 * messages.
 *
 * Rules:
 *  - `toolResult` messages are invisible here (their content lives inside the
 *    matching toolCall card), so they neither render nor split a run.
 *  - A message the user has expanded renders in full and therefore ends the run
 *    it sits in.
 *  - A role change ends the run: a user question never merges into PI's replies.
 *  - A time gap ends the run so its divider remains visible.
 */
export function buildCollapsedGroups(
	messages: readonly UiMessage[],
	recentStart: number,
	expanded: ReadonlySet<string>,
	breakBefore: ReadonlySet<number> = new Set(),
	hiddenMessages: ReadonlySet<string> = new Set(),
): CollapsedGrouping {
	const groupAt = new Map<number, UiMessage[]>();
	const absorbed = new Set<number>();
	let head = -1;
	let run: UiMessage[] = [];

	const flush = (): void => {
		if (head >= 0 && run.length > 0) groupAt.set(head, run);
		head = -1;
		run = [];
	};

	const end = Math.min(recentStart, messages.length);
	for (let i = 0; i < end; i++) {
		const m = messages[i];
		if (m.role === "toolResult" || m.origin === "auto-reminder" || hiddenMessages.has(m.id)) {
			absorbed.add(i);
			continue;
		}
		if (breakBefore.has(i)) flush();
		if (expanded.has(m.id) || goalEventText(m) || goalCompletedText(m)) {
			flush();
			continue;
		}
		if (head >= 0 && run[0].role === m.role) {
			run.push(m);
			absorbed.add(i);
		} else {
			flush();
			head = i;
			run = [m];
		}
	}
	flush();

	return { groupAt, absorbed };
}
