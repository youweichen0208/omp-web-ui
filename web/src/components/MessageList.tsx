import { activeTool, assistantPredecessors, toolTarget } from "../agent-activity";
import { WaitingHeaderStatus, WorkingStatus } from "./WorkingStatus";
import { goalEventText, goalCompletedText, groupGoalEvents } from "../goal-events";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";

import type { ReactNode } from "react";
import { FiArrowDown } from "react-icons/fi";
import type {
	PromptAttachment,
	ToolStatus,
	UiMessage,
	UiState,
} from "../types";
import type { PendingEcho, ReloadStatus } from "../use-chat";
import { Message, asText } from "./Message";

import { collectQuestionAttachments } from "../question-attachments";
import { retriedEditIds as findRetriedEditIds } from "../edit-write-presentation";

import { parseSkillBlock } from "../skill-block";
import { buildCollapsedGroups } from "../collapsed-groups";
import { messageTimeGaps } from "../time-gaps";
import { CollapsedGroup } from "./CollapsedGroup";
import { LazyMount } from "./LazyMount";
import {
	applyPlan,
	estimateMessageHeight,
	pickAlways,
	planWindow,
	type WinRect,
} from "../lazy-window";
import { SearchBar } from "./SearchBar";
import { clusterQuestionMarkers, questionPreviewText } from "../question-markers";
import { useT, type Translate } from "../i18n";

/** Stable shared empty map — passing this (instead of a fresh Map) lets
 *  React.memo skip messages that have no live tool output to show. */
const EMPTY_LIVE = new Map<string, { toolName: string; text: string }>();

/**
 * Messages beyond the most recent KEEP_RECENT are rendered as cheap collapsed
 * summary rows (no Markdown / thinking / tool output) until clicked. Only kicks
 * in once the chat grows past COLLAPSE_MIN, so short conversations are untouched.
 */
const KEEP_RECENT = 15;
const COLLAPSE_MIN = 30;

/** 惰性窗口化缓冲带：视口上下各多保留 1200px 的真实内容再开始收起。 */
const LAZY_MARGIN = 1200;
/** 底部常驻区高度预算（px）：贴底滚动 / 流式输出区域零占位延迟，
 *  但按累计高度截断——单条巨型消息不允许把常驻区撑成半个文档。 */
const ALWAYS_BUDGET = 1600;

function hasToolCall(m: UiMessage): boolean {
	return m.content.some((b) => b.type === "toolCall");
}

/** Suggested prompts shown on the empty-state welcome page. */
const EXAMPLE_DEFS: {
	key: "ex.understand" | "ex.debug" | "ex.test" | "ex.review";
	icon: string;
}[] = [
	{ key: "ex.understand", icon: "🔍" },
	{ key: "ex.debug", icon: "🐛" },
	{ key: "ex.test", icon: "🧪" },
	{ key: "ex.review", icon: "🧹" },
];

function examples(
	t: Translate,
): { icon: string; text: string; prompt: string }[] {
	return EXAMPLE_DEFS.map(({ key, icon }) => ({
		icon,
		text: t(key),
		prompt: t(`${key}.prompt`),
	}));
}

interface MessageListProps {
	active?: boolean;
	connected?: boolean;
	silenceNotified?: boolean;
	state: UiState;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	/** Edit-and-re-ask handler (forwarded to user message bubbles). */
	onEdit?: (
		messageId: string,
		text: string,
		attachments?: PromptAttachment[],
	) => void;
	/** Kill the running bash command from its tool card (agent run continues). */
	onKillBash?: () => void;
	/** 思考文本是否换行（设置面板开关；false = 不换行横向滚动）。 */
	thinkingWrap?: boolean;
	/** 工具调用是否默认展开（设置面板开关；false = 默认折叠）。 */
	toolsWrap?: boolean;
	/** 乐观本地回显（见 ChatState.pendingEcho）——服务端确认前立即显示的
	 *  用户消息幻影气泡，与 state.conversationId 匹配时才渲染。 */
	pendingEcho?: PendingEcho | null;
	reloadEvents?: ReloadStatus[];
}

const scrollPositions = new Map<string, { top: number; bottom: boolean; hidden: Set<string>; expanded: Set<string>; heights: Map<string, number> }>();

function ReloadEvent({ event }: { event: ReloadStatus }) {
	const t = useT();
	const errors = event.errors ?? [];
	const failed = event.phase === "done" && errors.length > 0;
	const summary = event.phase === "running" ? t("reloadRunning")
		: failed ? t("reloadPartial", { count: errors.length }) : t("reloadDone");
	const counts = event.extensions === undefined ? "" : t("reloadCounts", {
		extensions: event.extensions, skills: event.skills ?? 0, prompts: event.prompts ?? 0,
	});
	const duration = event.durationMs === undefined ? "" : ` · ${(event.durationMs / 1000).toFixed(1)}s`;
	const names = (items: string[]) => items.length > 8 ? `${items.slice(0, 8).join(", ")} +${items.length - 8}` : items.join(", ");
	const detail = event.resources ? [
		t("reloadExtensionList", { names: names(event.resources.extensions) || "—" }),
		t("reloadSkillList", { names: names(event.resources.skills) || "—" }),
		t("reloadPromptList", { names: names(event.resources.prompts) || "—" }),
	].join("\n") : "";
	return <div className={`reload-event${failed ? " failed" : ""}`} role="status" title={counts ? `${counts}${duration}\n${detail}` : undefined}>
		<div className="reload-command"><code>/reload</code></div>
		<div className="reload-event-line">
			<span className={event.phase === "running" ? "reload-dots" : "reload-mark"} aria-hidden="true">{event.phase === "running" ? <><i /><i /><i /></> : failed ? "!" : "✓"}</span>
			<span>{summary}{event.phase === "done" && counts ? ` · ${counts}${duration}` : duration}</span>
		</div>
		{failed && <details className="reload-errors"><summary>{t("reloadDetails")}</summary><ul>{errors.map((error, index) => <li key={`${error.path}-${index}`}><strong>{error.path || t("reloadGeneralError")}</strong><span>{error.message}</span></li>)}</ul></details>}
	</div>;
}

export const MessageList = memo(function MessageList({ state, connected = true, silenceNotified = false, liveOutputs, toolStatuses, onEdit, onKillBash, thinkingWrap, toolsWrap, pendingEcho, reloadEvents = [] }: MessageListProps) {
	const t = useT();
	const timeline = useMemo(() => {
		const events = [
			...reloadEvents.filter((event) => event.conversationId === state.conversationId).map((event) => ({ kind: "reload" as const, event })),
			...state.cwdEvents.filter((event) => event.cwd === state.cwd).map((event) => ({ kind: "cwd" as const, event })),
		].sort((a, b) => a.event.timestamp - b.event.timestamp);
		const items: ({ kind: "message"; message: UiMessage; index: number } | (typeof events)[number])[] = [];
		let next = 0;
		state.messages.forEach((message, index) => {
			while (next < events.length && events[next].event.timestamp <= (message.timestamp ?? 0)) items.push(events[next++]);
			items.push({ kind: "message", message, index });
		});
		while (next < events.length) items.push(events[next++]);
		return items;
	}, [state.messages, state.conversationId, state.cwd, state.cwdEvents, reloadEvents]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [stickBottom, setStickBottom] = useState(true);
	const stickRef = useRef(true);
	/** 上一帧 scrollTop —— 判定滚动方向（向上 = 用户要离开底部）。 */
	const prevStRef = useRef(0);
	/** 用户已主动离开底部：流式结束 / finalize 塌缩时不再自动吸回。 */
	const escapedRef = useRef(false);
	useLayoutEffect(() => {
		const el = scrollRef.current;
		const saved = scrollPositions.get(state.conversationId);
		if (el && saved) {
			stickRef.current = saved.bottom;
			escapedRef.current = !saved.bottom;
			setStickBottom(saved.bottom);
			el.scrollTop = saved.bottom ? el.scrollHeight : saved.top;
		}
		return () => {
			if (el) {
				scrollPositions.delete(state.conversationId);
				scrollPositions.set(state.conversationId, { top: el.scrollTop, bottom: stickRef.current, hidden: hiddenRef.current, expanded: expandedRef.current, heights: heightsRef.current });
				if (scrollPositions.size > 24) scrollPositions.delete(scrollPositions.keys().next().value!);
			}
		};
	}, [state.conversationId]);
	/** Messages the user expanded from the collapsed view — stay expanded. */
	const [expanded, setExpanded] = useState<Set<string>>(() => scrollPositions.get(state.conversationId)?.expanded ?? new Set());
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	/** 会话内搜索栏（Ctrl+F / Cmd+F）。 */
	const [searchOpen, setSearchOpen] = useState(false);
	/** Persisted messages + the live in-progress assistant message (if any). */
	const messages = state.streamingMessage
		? [...state.messages, state.streamingMessage]
		: state.messages;
	/**
	 * toolResult lookup, memoized on the messages array. The server keeps the
	 * array reference stable while the message set is unchanged, so this Map is
	 * rebuilt only when a new tool result actually arrives — not every snapshot.
	 */
	const toolResults = useMemo(() => {
		const m = new Map<string, UiMessage>();
		for (const msg of state.messages) {
			if (msg.role === "toolResult" && msg.toolCallId)
				m.set(msg.toolCallId, msg);
		}
		return m;
	}, [state.messages]);
	const retriedEditIds = useMemo(() => findRetriedEditIds(state.messages, toolResults), [state.messages, toolResults]);
	/**
	 * Original attachments per user question (memoized on the stable messages
	 * array) — restored in the edit composer because the fork drops the
	 * attachment asides that follow the question. Pure logic lives in
	 * question-attachments.ts (unit-tested).
	 */
	const questionAttachments = useMemo(
		() => collectQuestionAttachments(state.messages),
		[state.messages],
	);
	const goalEvents = useMemo(() => groupGoalEvents(state.messages), [state.messages]);
	const timeGaps = useMemo(() => messageTimeGaps(state.messages), [state.messages]);
	const predecessors = assistantPredecessors(messages);
	const lastUserIndex = state.messages.findLastIndex((message) => message.role === "user");
	const runningTool = state.isStreaming ? activeTool(messages, toolStatuses) : undefined;
	const currentAssistant = state.messages.slice(lastUserIndex + 1).findLast((message) => message.role === "assistant");
	const lastBlock = state.streamingMessage?.content.at(-1) ?? currentAssistant?.content.at(-1);
	const completedTool = lastBlock?.type === "toolCall" && typeof lastBlock.id === "string" && (toolStatuses.has(lastBlock.id) || toolResults.has(lastBlock.id));
	const activityLabel = runningTool ? runningTool.name === "bash" ? t("waitingCommand") : t(runningTool.name === "read" ? "activityReading" : "activityTool", { name: runningTool.name === "read" ? toolTarget(runningTool) : runningTool.name }) : t(completedTool ? "waitingModel" : lastBlock?.type === "text" ? "activityReply" : "activityAnalyze");
	const activityPhase = `${state.conversationId}:${runningTool?.id ?? state.streamingMessage?.id ?? "waiting"}:${state.streamingMessage?.content.length ?? 0}:${lastBlock?.type ?? ""}`;
	const streamingHasContent = state.streamingMessage?.content.some((block) => block.type === "text" ? (typeof block.text === "string" && !!block.text.trim()) || !!block.truncated : block.type === "thinking" ? typeof block.thinking === "string" && !!block.thinking.trim() : true) ?? false;
	const awaitingFirstAssistant = state.isStreaming && !streamingHasContent && lastUserIndex >= 0 && !state.messages.slice(lastUserIndex + 1).some((message) => message.role === "assistant");
	const showWorkingFooter = runningTool?.name !== "bash" && (!streamingHasContent || !!runningTool || !!completedTool);
	const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;
	// Only the last KEEP_RECENT persisted messages are fully rendered; older
	// ones collapse to summary rows (unless the user expanded them).
	const recentStart =
		state.messages.length > COLLAPSE_MIN
			? Math.max(0, state.messages.length - KEEP_RECENT)
			: 0;
	// 相邻的同角色折叠消息并成一条摘要：一次「想一下 → 调几个工具 → 回话」在
	// transcript 里是 8 条 assistant 消息，一条一行会把历史区堆成 8 条长得一模
	// 一样的条带。纯逻辑在 collapsed-groups.ts（有单测）。
	const collapsed = useMemo(
		() => buildCollapsedGroups(state.messages, recentStart, expanded, new Set(timeGaps.keys())),
		[state.messages, recentStart, expanded, timeGaps],
	);

	// ---- 惰性窗口化（lazy windowing，纯函数见 lazy-window.ts）----------------
	// 视口缓冲带之外的重型消息替换为等高占位 div；滚动临近时换回真实内容并
	// 在同一帧内补偿 scrollTop。占位保留 data-msg-id，导航/跳转/搜索不受影响。
	/** 当前处于占位状态的消息 id。 */
	const [hidden, setHidden] = useState<Set<string>>(() => scrollPositions.get(state.conversationId)?.hidden ?? new Set());
	/** 用户跳转过的消息——永久保持真实渲染，避免占位符闪现。 */
	const [pinned, setPinned] = useState<Set<string>>(() => new Set());
	/** 已实测的消息高度（隐藏时用作占位高度）。 */
	const heightsRef = useRef(scrollPositions.get(state.conversationId)?.heights ?? new Map<string, number>());
	/** 所有受管外层元素（sweep 测量用；挂载时注册，消息移除时清理）。 */
	const elsRef = useRef(new Map<string, HTMLDivElement>());
	const sweepRafRef = useRef(0);
	// 镜像最新值，供 rAF 回调 / 事件处理器读取而不重建（沿用 questionsRef 模式）
	const hiddenRef = useRef(hidden);
	hiddenRef.current = hidden;
	/** 短会话与搜索打开期间不做窗口化（全量渲染，行为与旧版一致）。 */
	const virtualOn = state.messages.length > COLLAPSE_MIN && !searchOpen;
	const virtualOnRef = useRef(virtualOn);
	virtualOnRef.current = virtualOn;
	// 底部常驻区（永不占位）：随每次渲染按预算重算（读取最新实测高度），
	// 首次全量测量后巨型消息会被预算挤出常驻区、参与正常窗口化。
	const alwaysSet = pickAlways(
		state.messages,
		heightsRef.current,
		ALWAYS_BUDGET,
	);
	const alwaysRef = useRef(alwaysSet);
	alwaysRef.current = alwaysSet;

	/** 全量测量受管元素 → 窗口计划（rAF 节流调用；也用于初始与特殊迁移后）。 */
	const sweep = useCallback(() => {
		const root = scrollRef.current;
		if (!root) return;
		if (!virtualOnRef.current) {
			setHidden((prev) => (prev.size ? new Set<string>() : prev));
			return;
		}
		const rootRect = root.getBoundingClientRect();
		const viewport = {
			top: rootRect.top - LAZY_MARGIN,
			bottom: rootRect.bottom + LAZY_MARGIN,
		};
		const items: WinRect[] = [];
		for (const [id, el] of elsRef.current) {
			const b = el.getBoundingClientRect();
			items.push({ id, top: b.top, bottom: b.bottom });
			// 显示中的元素顺手记录实测高度——pickAlways 的预算与占位高度都靠它；
			// 只在隐藏时测量的话，「初始就显示」的消息会永远停留在估算值。
			if (!hiddenRef.current.has(id)) heightsRef.current.set(id, b.bottom - b.top);
		}
		const plan = planWindow(items, viewport, alwaysRef.current, hiddenRef.current);
		// 收起时用刚实测的高度做占位 ⇒ 流总高度不变 ⇒ 无需任何 scrollTop 补偿。
		// （曾在此做 shrink 补偿：它触发的 scroll 事件会让缓冲带重新罩住刚收起的
		// 元素 → 再挂载 → 再收起，自搏循环把用户钉在原地永远滚不到底。）
		for (const id of plan.hide) {
			const el = elsRef.current.get(id);
			if (el) heightsRef.current.set(id, el.offsetHeight);
		}
		setHidden((prev) => applyPlan(prev, plan));
	}, []);

	const scheduleSweep = useCallback(() => {
		if (sweepRafRef.current) return;
		sweepRafRef.current = requestAnimationFrame(() => {
			sweepRafRef.current = 0;
			sweep();
		});
	}, [sweep]);


	// 初始挂载：首帧绘制前就把远端内容换成占位（大会话 attach 不再全量布局绘制）
	useLayoutEffect(() => {
		sweep();
	}, [sweep]);

	// 搜索关闭瞬间重新收起远端内容（打开期间强制全渲染以兼容 DOM 高亮/Range 收集）
	const prevSearchRef = useRef(searchOpen);
	useLayoutEffect(() => {
		if (prevSearchRef.current && !searchOpen) sweep();
		prevSearchRef.current = searchOpen;
	}, [searchOpen, sweep]);

	const storeHeight = useCallback((id: string, h: number) => {
		heightsRef.current.set(id, h);
	}, []);

	/** 外层元素注册（sweep 测量用）；卸载侧由下方清理 effect 兑底（React 18 的
	 *  ref(null) 回调拿不到 data-lazy-id，无法定点反注册）。 */
	const attachEl = useCallback((el: HTMLDivElement | null) => {
		if (el) elsRef.current.set(el.dataset.lazyId ?? "", el);
	}, []);

	// 消息集或展开状态变化后，清掉已不存在的受管元素 / 高度缓存 / 隐藏项
	// （依赖用服务端缓存的消息数组——引用稳定，流式增量不会每帧重跑）
	useEffect(() => {
		const ids = new Set(state.messages.map((m) => m.id));
		for (const [id, el] of elsRef.current) {
			if (ids.has(id)) continue;
			elsRef.current.delete(id);
			heightsRef.current.delete(id);
		}
		setHidden((prev) => {
			let changed = false;
			const next = new Set<string>();
			for (const id of prev)
				if (ids.has(id)) next.add(id);
				else changed = true;
			return changed ? next : prev;
		});
	}, [state.messages, expanded]);

	useEffect(() => () => cancelAnimationFrame(sweepRafRef.current), []);

	// All user questions of the current conversation — the source for the
	// floating question-nav rail (memoized on the stable messages array).
	const questions = useMemo(() => {
		const qs: { id: string; text: string }[] = [];
		for (const m of state.messages) {
			if (m.role !== "user" || goalEventText(m) || goalCompletedText(m)) continue;
			const joined = m.content
				.map((b) => asText(b)?.text ?? "")
				.filter(Boolean)
				.join(" ");
			// Skill invocations show the user's own args (or the skill name),
			// never the expanded SKILL.md dump.
			const sb = parseSkillBlock(joined);
			const text = questionPreviewText(sb ? (sb.userMessage ?? `skill:${sb.name}`) : joined);
			if (!text) continue;
			qs.push({ id: m.id, text });
		}
		return qs;
	}, [state.messages]);

	/** Question ordinal by message id — each user question renders its own tag. */
	const qnIndex = useMemo(() => {
		const m = new Map<string, number>();
		questions.forEach((q, i) => m.set(q.id, i));
		return m;
	}, [questions]);

	// -- floating question-nav rail --------------------------------------------
	/** Index of the question currently on screen (or last jumped to); -1 = none. */
	const [activeIdx, setActiveIdx] = useState(-1);
	const activeIdxRef = useRef(-1);
	// Scroll handlers read the latest questions without recreating.
	const questionsRef = useRef(questions);
	useEffect(() => {
		questionsRef.current = questions;
	}, [questions]);
	const [markerPositions, setMarkerPositions] = useState<Record<string, number>>({});
	const updateMarkerPositions = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const top = el.getBoundingClientRect().top;
		const height = Math.max(el.scrollHeight, 1);
		const next: Record<string, number> = {};
		for (const question of questionsRef.current) {
			const node = el.querySelector<HTMLElement>(`[data-msg-id="${question.id}"]`);
			if (node) next[question.id] = Math.max(0.02, Math.min(0.98, (node.getBoundingClientRect().top - top + el.scrollTop) / height));
		}
		setMarkerPositions((previous) => Object.keys(next).length === Object.keys(previous).length &&
			Object.keys(next).every((id) => Math.abs(next[id] - previous[id]) < 0.002) ? previous : next);
	}, []);
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		let frame = requestAnimationFrame(updateMarkerPositions);
		const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(updateMarkerPositions); };
		const observer = new MutationObserver(schedule);
		observer.observe(el, { childList: true, subtree: true });
		window.addEventListener("resize", schedule);
		return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", schedule); };
	}, [questions, updateMarkerPositions]);

	// Which question is currently on screen (drives the bar highlight).
	const updateActiveFromScroll = useCallback(() => {
		const el = scrollRef.current;
		const qs = questionsRef.current;
		if (!el || qs.length === 0) return;
		const containerTop = el.getBoundingClientRect().top;
		const margin = 140;
		let best = -1;
		for (let i = 0; i < qs.length; i++) {
			const node = el.querySelector<HTMLElement>(`[data-msg-id="${qs[i].id}"]`);
			if (!node) continue;
			if (node.getBoundingClientRect().top <= containerTop + margin) best = i;
			else break;
		}
		if (best !== activeIdxRef.current) {
			activeIdxRef.current = best;
			setActiveIdx(best);
		}
	}, []);

	// Pick the initial active question when the message set changes (also
	// covers expand/collapse since it re-renders with new DOM).
	useEffect(() => {
		updateActiveFromScroll();
	}, [questions, updateActiveFromScroll]);

	const expand = useCallback((id: string) => {
		setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
	}, []);

	/** 展开一整组折叠消息（摘要行代表的是整轮，不是单条）。 */
	const expandGroup = useCallback((ids: string[]) => {
		setExpanded((prev) => {
			if (ids.every((id) => prev.has(id))) return prev;
			const next = new Set(prev);
			for (const id of ids) next.add(id);
			return next;
		});
	}, []);

	// 搜索跳转目标若是折叠的旧消息，先同步展开（flushSync 保证本轮 DOM 就绪）
	const ensureExpanded = useCallback(
		(id: string) => {
			const idx = state.messages.findIndex((m) => m.id === id);
			if (idx >= 0 && idx < recentStart && !expanded.has(id)) {
				flushSync(() => expand(id));
			}
		},
		[state.messages, recentStart, expanded, expand],
	);

	// Ctrl+F / Cmd+F 打开搜索（可编辑元素内不抢占）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "f") return;
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.isContentEditable)
			)
				return;
			e.preventDefault();
			setSearchOpen(true);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	const collapse = useCallback((id: string) => {
		setExpanded((prev) => {
			if (!prev.has(id)) return prev;
			const next = new Set(prev);
			next.delete(id);
			return next;
		});
	}, []);

	/** Scroll the conversation to a question; expand it first if it's collapsed. */
	const jumpTo = useCallback(
		(id: string) => {
			const idx = state.messages.findIndex((m) => m.id === id);
			// 占位中的目标先同步恢复真实渲染（折叠行同步展开），再滚动定位——
			// flushSync 保证本轮 commit 后 DOM 即为最终形态。
			flushSync(() => {
				if (idx >= 0 && idx < recentStart && !expanded.has(id)) expand(id);
				setPinned((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
			});
			const qIdx = questionsRef.current.findIndex((q) => q.id === id);
			activeIdxRef.current = qIdx;
			setActiveIdx(qIdx);
			requestAnimationFrame(() => {
				const el = scrollRef.current?.querySelector<HTMLElement>(
					`[data-msg-id="${id}"]`,
				);
				if (el) {
					// Clear the flash from any previously jumped-to message, then
					// restart the highlight animation on the target.
					scrollRef.current
						?.querySelectorAll(".msg-flash")
						.forEach((n) => n.classList.remove("msg-flash"));
					el.scrollIntoView({ block: "start" });
					el.classList.remove("msg-flash");
					void el.offsetWidth; // restart the highlight animation
					el.classList.add("msg-flash");
					// 问题跳转 = 主动离开底部；流结束时不要被吸回去
					if (el !== scrollRef.current?.lastElementChild) escapedRef.current = true;
				}
			});
		},
		[state.messages, recentStart, expanded, expand],
	);
	useEffect(() => {
		const onTaskJump = (event: Event) => {
			const id = (event as CustomEvent<{ messageId?: string }>).detail?.messageId;
			if (id && messages.some((message) => message.id === id)) jumpTo(id);
		};
		const onToolJump = (event: Event) => {
			const { messageId, toolCallId } = (event as CustomEvent<{ messageId?: string; toolCallId?: string }>).detail ?? {};
			if (!messageId || !toolCallId || !messages.some((message) => message.id === messageId)) return;
			jumpTo(messageId);
			requestAnimationFrame(() => requestAnimationFrame(() => {
				const card = scrollRef.current?.querySelector<HTMLElement>(`[data-tool-call-id="${CSS.escape(toolCallId)}"]`);
				if (!card) return;
				card.scrollIntoView({ block: "center" });
				card.classList.remove("change-card-flash");
				void card.offsetWidth;
				card.classList.add("change-card-flash");
				window.setTimeout(() => card.classList.remove("change-card-flash"), 1800);
			}));
		};
		window.addEventListener("pi:jump-message", onTaskJump);
		window.addEventListener("pi:jump-tool", onToolJump);
		return () => { window.removeEventListener("pi:jump-message", onTaskJump); window.removeEventListener("pi:jump-tool", onToolJump); };
	}, [jumpTo, messages]);

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const dSt = el.scrollTop - prevStRef.current;
		prevStRef.current = el.scrollTop;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		if (dSt < -4 && dSt > -500) {
			// 明确的向上滚动意图：立即松开贴底——即使仍在 80px 阈值内。
			// 流式期间每个 delta 都会把视口钉回底部，若只看距离阈值，
			// 用户永远逃不出去（表现为「自己滚动一直弹回来」）。
			// 大幅负跳变（<-500）不算：那是布局塌缩（finalize 一帧收起巨消息）
			// 引发的原生 clamp，不是用户手势。
						escapedRef.current = true;
		} else if (nearBottom && dSt >= 0) {
			escapedRef.current = false; // 滚回了底部
		}
		stickRef.current = nearBottom && !escapedRef.current;
		setStickBottom(stickRef.current);
		updateActiveFromScroll();
		updateMarkerPositions();
		scheduleSweep();
	}, [updateActiveFromScroll, updateMarkerPositions, scheduleSweep]);

	// 流结束兜底：finalize 瞬间 streaming→persisted 切换可能让内容高度塌缩一帧，
	// 浏览器把视口 clamp 到半路；若用户并未主动离开（!escaped），等布局稳定后吸回底部。
	const wasStreamingRef = useRef(false);
	useEffect(() => {
		const was = wasStreamingRef.current;
		wasStreamingRef.current = !!state.isStreaming;
		if (was && !state.isStreaming && !escapedRef.current) {
			const snap = () => {
				const el = scrollRef.current;
				if (el && !escapedRef.current) {
					el.scrollTop = el.scrollHeight;
					stickRef.current = true;
					setStickBottom(true);
				}
			};
			requestAnimationFrame(() => requestAnimationFrame(snap));
			const t = setTimeout(snap, 180);
			return () => clearTimeout(t);
		}
	}, [state.isStreaming]);

	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages, state.isStreaming, liveOutputs]);

	// Queued prompts (插队/排队) render as pending bubbles at the list bottom —
	// include them in the stick-to-bottom deps so a newly queued message is
	// scrolled into view when the user hasn't left the bottom.
	const queueSig = state.queue.steering.join("\u0000") + "\u0001" + state.queue.followUp.join("\u0000");
	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [queueSig]);

	const scrollToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
		stickRef.current = true;
		escapedRef.current = false;
		setStickBottom(true);
	}, []);

	// The rail is a pointer-event target so it can expand on hover; forward
	// wheel over it (collapsed strip or expanded panel) to the message list.
	const railRef = useRef<HTMLDivElement>(null);
	const [navOpen, setNavOpen] = useState(false);
	useEffect(() => {
		if (!navOpen) return;
		const closeOutside = (event: PointerEvent) => { if (!railRef.current?.contains(event.target as Node)) setNavOpen(false); };
		const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setNavOpen(false); };
		document.addEventListener("pointerdown", closeOutside, true);
		document.addEventListener("keydown", closeEscape);
		return () => { document.removeEventListener("pointerdown", closeOutside, true); document.removeEventListener("keydown", closeEscape); };
	}, [navOpen]);
	useEffect(() => {
		const rail = railRef.current;
		const el = scrollRef.current;
		if (!rail || !el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			// In "many questions" mode the hover panel is a scrollable list —
			// wheel over it scrolls the list itself (when it overflows),
			// otherwise it falls through to the message list.
			const list = rail.querySelector<HTMLElement>(".qn-list");
			if (list && list.contains(e.target as Node) && list.scrollHeight > list.clientHeight) {
				list.scrollTop += e.deltaY;
				return;
			}
			el.scrollTop += e.deltaY;
		};
		rail.addEventListener("wheel", onWheel, { passive: false });
		return () => rail.removeEventListener("wheel", onWheel);
	}, []);

	// Visible height of the scroll area — drives the adaptive row gap so the
	// centered tick cluster always fits (no top/bottom clipping).
	const [railH, setRailH] = useState(0);
	useEffect(() => {
		const update = () => {
			setRailH(scrollRef.current?.clientHeight ?? 0);
			scheduleSweep(); // 宽高变化后旧占位高度可能失准，重新评估窗口
		};
		update();
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, [scheduleSweep]);
	const positionedQuestions = questions.filter((question) => markerPositions[question.id] !== undefined);
	const markerGroups = clusterQuestionMarkers(positionedQuestions.map((question) => ({ id: question.id, position: markerPositions[question.id] })), railH);
	/** Clustered marks retain the existing hover list for precise navigation. */
	const many = markerGroups.some((group) => group.ids.length > 1);

	return (
		<div className="messages-wrap">
			<div className="messages" ref={scrollRef} onScroll={onScroll}>
				{timeline.length === 0 && !state.streamingMessage && (
					<div className="empty-state">
						<div className="empty-logo-wrap">
							<img className="empty-logo" src="/favicon.svg" alt="" />
						</div>
						<h2 className="empty-title">{t("welcomeTitle")}</h2>
						<p className="empty-sub">{t("welcomeSub")}</p>
						<div className="empty-cwd">
							<span className="empty-cwd-label">{t("directory")}</span>
							<span className="empty-cwd-path">{state.cwd}</span>
						</div>
						<div className="empty-examples">
							{examples(t).map((ex) => (
								<button
									type="button"
									key={ex.prompt}
									className="empty-example"
									title={t("clickToFill")}
									onClick={() =>
										window.dispatchEvent(
											new CustomEvent("pi-web:fill", { detail: ex.prompt }),
										)
									}
								>
									<span className="empty-example-icon">{ex.icon}</span>
									<span className="empty-example-text">{ex.text}</span>
								</button>
							))}
						</div>
					</div>
				)}
				{timeline.map((item) => {
					if (item.kind === "reload") return <ReloadEvent key={`reload-${item.event.requestId}`} event={item.event} />;
					if (item.kind === "cwd") return <div key={`cwd-${item.event.timestamp}`} className="goal-event cwd-event" role="status"><span aria-hidden="true">↪</span><span>{t("cwdSwitchEvent", { path: item.event.cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~") })}</span></div>;
					const { message: m, index: i } = item;
					if (goalEvents.absorbed.has(m.id)) return null;
					const withGap = (content: ReactNode) => {
						const label = timeGaps.get(i);
						return label ? <Fragment key={m.id}><div className="time-gap" aria-label={t("timeGapAt", { time: label })} title={m.timestamp ? new Date(m.timestamp).toLocaleString() : undefined}><span>{label}</span></div>{content}</Fragment> : content;
					};
					const event = goalEvents.groups.get(m.id);
					if (event) return withGap(<div key={m.id} className={`goal-event ${event.kind}`} data-msg-id={m.id}>
						<span aria-hidden="true">{event.kind === "complete" ? "✓" : "◎"}</span><span>{t(event.kind === "complete" ? "goalEventComplete" : "goalEventSet", { text: event.text })}</span>
						{event.ids.length > 1 && <span className="goal-event-count">×{event.ids.length}</span>}
						{event.kind === "complete" && <details className="goal-event-details"><summary>{t("goalReviewDetails")}</summary><pre>{m.content.map(block => block.type === "text" ? block.text : "").join("\n")}</pre></details>}
						{event.ids.slice(1).map((id) => <span key={id} data-msg-id={id} />)}
					</div>);
					const isOld = i < recentStart;
					const isExpandedOld = isOld && expanded.has(m.id);
					if (isOld && !isExpandedOld) {
						// Folded into an earlier group's summary row (or a toolResult,
						// whose content lives inside its toolCall card) — render nothing.
						if (collapsed.absorbed.has(i)) return null;
						const group = collapsed.groupAt.get(i);
						if (!group) return null;
						return withGap(
							<CollapsedGroup
								key={m.id}
								messages={group}
								onExpand={expandGroup}
							/>
						);
					}
					const qIdx = m.role === "user" ? qnIndex.get(m.id) : undefined;
					const show =
						!virtualOn ||
						alwaysSet.has(m.id) ||
						pinned.has(m.id) ||
						!hidden.has(m.id);
					return withGap(
						<LazyMount
							key={m.id}
							id={m.id}
							show={show}
							height={
								heightsRef.current.get(m.id) ??
								estimateMessageHeight(m.role, m.customType)
							}
							containerRef={scrollRef}
							onMeasured={storeHeight}
							lazyRef={attachEl}
						>
						<Message
							key={m.id}
							message={m}
							continuation={!!predecessors.get(m.id) && !hidden.has(predecessors.get(m.id)!) && !(i < recentStart && !expanded.has(predecessors.get(m.id)!))}
							qnIndex={qIdx}
							qnActive={qIdx !== undefined ? qIdx === activeIdx : undefined}
							onJump={jumpTo}
							toolResults={toolResults}
							retriedEditIds={retriedEditIds}
							liveOutputs={hasToolCall(m) ? liveOutputs : EMPTY_LIVE}
							toolStatuses={toolStatuses}
							streaming={state.isStreaming && connected}
							onKillBash={onKillBash}
							toolsWrap={toolsWrap}
							thinkingWrap={thinkingWrap}
							isLast={m.id === lastId}
							onEdit={onEdit}
							questionAttachments={questionAttachments.get(m.id)}
							onCollapse={isExpandedOld ? collapse : undefined}
						/>
						</LazyMount>
					);
				})}
				{state.streamingMessage && streamingHasContent && (
					<Message
						key={state.streamingMessage.id}
						message={state.streamingMessage}
						continuation={!!predecessors.get(state.streamingMessage.id)}
						toolResults={toolResults}
						retriedEditIds={retriedEditIds}
						liveOutputs={
							hasToolCall(state.streamingMessage) ? liveOutputs : EMPTY_LIVE
						}
						toolStatuses={toolStatuses}
						streaming={connected}
						isLast
						onEdit={onEdit}
						onKillBash={onKillBash}
						toolsWrap={toolsWrap}
						thinkingWrap={thinkingWrap}
					/>
				)}
				{state.isStreaming && (connected ? (awaitingFirstAssistant ? <div className="msg msg-assistant agent-working-placeholder"><div className="msg-meta"><span className="msg-role">{t("role.assistant")}</span>{state.model?.id && <span className="msg-model">{state.model.id}</span>}<span className="msg-time">{new Date(state.messages[lastUserIndex].timestamp ?? Date.now()).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span></div><WaitingHeaderStatus key={`${state.conversationId}:${state.messages[lastUserIndex].id}`} startedAt={state.messages[lastUserIndex].timestamp} silenceNotified={silenceNotified} /></div> : showWorkingFooter ? <WorkingStatus key={state.conversationId} label={activityLabel} phase={activityPhase} durationMs={!runningTool && lastBlock?.type === "thinking" && typeof lastBlock.durationMs === "number" ? lastBlock.durationMs : undefined} /> : null) : <div className="agent-working disconnected" role="status">{t("workDisconnected")}</div>)}
				{/* 乐观本地回显：刚点发送、服务端确认（snapshot_delta 追加）之前，
				 *  立刻把用户刚输入的文字显示出来，避免等待服务端往返的空白期。
				 *  一旦真实消息落地（reducer 里 appended.length>0）就会清空 pendingEcho，
				 *  这里绝不会与随后的真实气泡重复显示。 */}
				{pendingEcho && pendingEcho.conversationId === state.conversationId && (
					<div className="msg msg-user pending-echo" data-role="user">
						<div className="msg-meta">
							<span className="msg-role">{t("role.user")}</span>
							<span className="pending-echo-tag">
								<span className="thinking-spinner" aria-hidden="true" />
								{t("sending")}
							</span>
						</div>
						<div className="msg-body">
							<div className="msg-text">{pendingEcho.text}</div>
						</div>
					</div>
				)}
				{state.queue.steering.map((text, i) => (
					<div className="queued-msg" key={`q-steer-${i}`}>
						<div className="queued-bubble">
							<span className="queued-tag steer">{t("queueSteerTag")}</span>
							<div className="queued-text">{text}</div>
						</div>
					</div>
				))}
				{state.queue.followUp.map((text, i) => (
					<div className="queued-msg" key={`q-fu-${i}`}>
						<div className="queued-bubble">
							<span className="queued-tag follow">{t("queueFollowTag")}</span>
							<div className="queued-text">{text}</div>
						</div>
					</div>
				))}
			</div>
			{!stickBottom && (() => {
				const button = <button type="button" className="scroll-bottom" onClick={scrollToBottom}><FiArrowDown /> {t("backToBottom")}</button>;
				const composer = document.querySelector<HTMLElement>(".design-workspace .view-pane:not(.hidden) .main > .inputbar");
				return composer ? createPortal(button, composer) : button;
			})()}
			<SearchBar
				containerRef={scrollRef}
				messages={messages}
				open={searchOpen}
				onClose={() => setSearchOpen(false)}
				onEnsureExpanded={ensureExpanded}
			/>
			{questions.length > 0 && (
				<div
					className={`qn-rail ${many ? "many" : ""} ${navOpen ? "open" : ""}`}
					ref={railRef}
					aria-label={t("questionNavTitle")}
					onPointerEnter={() => setNavOpen(true)}
					onPointerLeave={() => setNavOpen(false)}
					onFocusCapture={() => setNavOpen(true)}
				>
					{markerGroups.map((group) => {
						const q = positionedQuestions.find((question) => question.id === group.ids[0])!;
						return (
						<button
							type="button"
							key={group.ids.join(":")}
							className={`qn-bar ${group.ids.length > 1 ? "cluster" : ""} ${group.ids.includes(questions[activeIdx]?.id ?? "") ? "active" : ""}`}
							style={{ top: `${group.position * 100}%` }}
							aria-label={group.ids.length > 1 ? t("questionMarkerGroup", { n: group.ids.length }) : `${questions.indexOf(q) + 1}. ${q.text}`}
							onClick={() => { jumpTo(q.id); setNavOpen(false); }}
						>
							<span className="qn-bar-text">{questions.indexOf(q) + 1}. {q.text}</span>
						</button>
						);
					})}
					{many && (
						<div className="qn-list">
							{questions.map((q, i) => (
								<button
									type="button"
									key={q.id}
									className={`qn-list-item ${i === activeIdx ? "active" : ""}`}
									aria-label={`${i + 1}. ${q.text}`}
									onClick={() => { jumpTo(q.id); setNavOpen(false); }}
								>
									<span className="qn-list-idx">{i + 1}</span>
									<span className="qn-list-text">{q.text}</span>
								</button>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
} , (prev, next) => {
	if (prev.active === false && next.active === false && prev.state.conversationId === next.state.conversationId) return true;
	return Object.keys(next).every((key) => prev[key as keyof MessageListProps] === next[key as keyof MessageListProps]);
});
