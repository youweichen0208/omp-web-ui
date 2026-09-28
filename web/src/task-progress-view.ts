import type { TaskProgress, TaskStep, UiMessage } from "../../server/protocol.js";

export interface ProgressPhase {
	id: string;
	kind: "read" | "build" | "migration" | "test" | "fix" | "commit" | "other";
	title: string;
	steps: TaskStep[];
	status: TaskStep["status"];
	startedAt: number;
	endedAt?: number;
	counts: { read: number; write: number; edit: number; command: number };
}

export interface ProgressResult {
	commit?: { hash: string; subject?: string };
	tests?: { passed: number; total: number };
	changes?: { added: number; deleted: number; files: number };
}

export const plainTitle = (value: string) => value.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim();

function kindOf(step: TaskStep, afterTest: boolean): ProgressPhase["kind"] {
	const text = plainTitle(`${step.title} ${step.artifacts.map((item) => item.label).join(" ")}`).toLowerCase();
	if (/\bgit\s+commit\b|提交|commit\b/.test(text)) return "commit";
	if (/migration|迁移/.test(text)) return "migration";
	if (step.artifacts.length && step.artifacts.every((item) => ["read", "grep", "find", "ls"].includes(item.kind))) return "read";
	if (step.artifacts.some((item) => ["write", "edit"].includes(item.kind)) && !step.artifacts.some((item) => ["bash", "terminal"].includes(item.kind))) return afterTest || /修复|修正|fix|debug/.test(text) ? "fix" : "build";
	if (afterTest && /修复|修正|fix|debug|rerun|重跑|复测/.test(text)) return "fix";
	if (/pytest|vitest|npm\s+(?:run\s+)?test|测试|test\b/.test(text)) return "test";
	if (/读取|查看|检查|调研|分析/.test(text)) return "read";
	if (afterTest && step.artifacts.some((item) => ["write", "edit"].includes(item.kind))) return "fix";
	if (step.artifacts.some((item) => ["write", "edit"].includes(item.kind)) || /实现|搭建|编写|创建|修改/.test(text)) return "build";
	return "other";
}

const titles: Record<ProgressPhase["kind"], string> = {
	read: "读取与确认", build: "实现主体", migration: "补 migrations", test: "运行测试", fix: "运行并修复", commit: "提交", other: "执行操作",
};

function phaseTitle(kind: ProgressPhase["kind"], step: TaskStep): string {
	const title = plainTitle(step.title);
	if (title && !/^(?:处理任务|执行操作|当前任务|正在分析请求|运行工具|读取文件|修改文件)$/.test(title) && kind !== "test" && kind !== "commit") return title.slice(0, 32);
	return titles[kind];
}

export function phaseSummary(phase: ProgressPhase, tests?: { passed: number; total: number }, locale: "zh" | "en" = "zh"): string {
	const { read, write, edit, command } = phase.counts;
	const paths = [...new Set(phase.steps.flatMap((step) => step.artifacts.filter((item) => item.path && ["write", "edit"].includes(item.kind)).map((item) => item.path!)))];
	if ((phase.kind === "test" || phase.kind === "fix") && command) return locale === "en" ? `Ran ${command} command${command === 1 ? "" : "s"}${tests ? ` · ${tests.passed}/${tests.total} passed` : ""}${paths.length === 1 ? ` · Edited ${paths[0]}` : ""}` : `运行 ${command} 条命令${tests ? ` · ${tests.passed}/${tests.total} 通过` : ""}${paths.length === 1 ? ` · 修改 ${paths[0]}` : ""}`;
	if (paths.length === 1) return `${locale === "en" ? edit ? "Edited" : "Wrote" : edit ? "修改" : "写入"} ${paths[0]}`;
	if (paths.length > 1) return locale === "en" ? `${edit ? `Edited ${edit}` : ""}${edit && write ? " · " : ""}${write ? `Wrote ${write}` : ""} · ${paths.length} files` : `${edit ? `修改 ${edit}` : ""}${edit && write ? " · " : ""}${write ? `写入 ${write}` : ""} · ${paths.length} 个文件`;
	const readPaths = [...new Set(phase.steps.flatMap((step) => step.artifacts.filter((item) => item.path && item.kind === "read").map((item) => item.path!)))];
	if (readPaths.length) return readPaths.length <= 2 ? readPaths.join(" · ") : locale === "en" ? `Read ${readPaths.length} files` : `读取 ${readPaths.length} 个文件`;
	if (command) return locale === "en" ? `Ran ${command} command${command === 1 ? "" : "s"}` : `运行 ${command} 条命令`;
	if (read) return locale === "en" ? `Read ${read} items` : `读取 ${read} 项`;
	return "";
}

/** Consecutive transcript steps become readable phases; every raw step remains available underneath. */
export function progressPhases(task: TaskProgress): ProgressPhase[] {
	const phases: ProgressPhase[] = [];
	let tested = false;
	for (const step of task.steps) {
		let kind = kindOf(step, tested);
		const previous = phases.at(-1)?.kind;
		if (kind === "read" && previous && previous !== "read" && previous !== "other") kind = previous;
		if (kind === "other" && phases.length) kind = phases.at(-1)!.kind;
		if (kind === "test") tested = true;
		if (kind === "fix" && phases.at(-1)?.kind === "test") phases.at(-1)!.title = "运行测试";
		let phase = phases.at(-1);
		if (!phase || phase.kind !== kind) {
			phase = { id: step.id, kind, title: phaseTitle(kind, step), steps: [], status: "done", startedAt: step.startedAt, counts: { read: 0, write: 0, edit: 0, command: 0 } };
			phases.push(phase);
		}
		phase.steps.push(step);
		phase.startedAt = Math.min(phase.startedAt || step.startedAt, step.startedAt || phase.startedAt);
		phase.endedAt = Math.max(phase.endedAt ?? 0, step.endedAt ?? step.startedAt);
		if (step.status === "running" || phase.status !== "running" && step.status === "failed") phase.status = step.status;
		for (const item of step.artifacts) {
			if (item.kind === "read") phase.counts.read++;
			else if (item.kind === "write") phase.counts.write++;
			else if (item.kind === "edit") phase.counts.edit++;
			else if (["bash", "terminal"].includes(item.kind)) phase.counts.command++;
		}
	}
	return phases;
}

/** Only report concrete values present in the current task's transcript. */
export function progressResult(task: TaskProgress, messages: UiMessage[]): ProgressResult {
	const start = messages.findIndex((message) => message.id === task.sourceMessageId);
	const text = (start < 0 ? [] : messages.slice(start + 1)).flatMap((message) => message.content.filter((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string").map((part) => (part as { text: string }).text)).join("\n");
	const result: ProgressResult = {};
	const commit = text.match(/(?:提交|commit|\[main\s+)(?:\s*[:：#]\s*|\s+)?([0-9a-f]{7,40})(?:\s+([^\n，。]+))?/i);
	if (commit) result.commit = { hash: commit[1].slice(0, 8), subject: commit[2]?.trim().slice(0, 80) };
	const tests = [...text.matchAll(/(\d+)\s*\/\s*(\d+)\s*(?:通过|passed)/gi)].at(-1);
	const passed = [...text.matchAll(/(\d+)\s+passed\b/gi)].at(-1);
	if (tests) result.tests = { passed: Number(tests[1]), total: Number(tests[2]) };
	else if (passed) result.tests = { passed: Number(passed[1]), total: Number(passed[1]) };
	const changes = [...text.matchAll(/\+(\d+)\s+[−-](\d+)\s*[·,，]?\s*(\d+)\s*个文件/g)].at(-1);
	const gitStat = [...text.matchAll(/(\d+) files? changed,\s*(\d+) insertions?\(\+\),\s*(\d+) deletions?\(-\)/gi)].at(-1);
	if (changes) result.changes = { added: Number(changes[1]), deleted: Number(changes[2]), files: Number(changes[3]) };
	else if (gitStat) result.changes = { files: Number(gitStat[1]), added: Number(gitStat[2]), deleted: Number(gitStat[3]) };
	return result;
}

/** Split authored labels without inventing a phase or rewriting its meaning. */
export function planStepPresentation(value: string): { tag: string; title: string; detail: string } {
	let title = plainTitle(value);
	const prefix = /^([A-Za-z][\w-]{0,24}):\s*(.+)$/.exec(title);
	const tag = prefix ? prefix[1].toLowerCase().replace(/^agent-runtime$/, "runtime") : "";
	if (prefix) title = prefix[2];
	const details = /\s*[（(]([^()（）]+)[）)]\s*$/.exec(title);
	return { tag, title: details ? title.slice(0, details.index).trim() : title, detail: details?.[1] ?? "" };
}

/** New snapshots carry transcript-order ownership; old snapshots use their recorded time range. */
export function planStepArtifacts(task: TaskProgress, item: NonNullable<TaskProgress["plan"]>["items"][number]) {
	const ids = item.toolCallIds ? new Set(item.toolCallIds) : null;
	const nextStart = task.plan?.items.filter((other) => other.startedAt && other.startedAt > (item.startedAt ?? Infinity)).map((other) => other.startedAt!).sort((a, b) => a - b)[0];
	return task.steps.flatMap((step) => step.artifacts.filter((artifact) => ids ? ids.has(artifact.toolCallId) : !!item.startedAt && step.startedAt >= item.startedAt && step.startedAt < (item.endedAt ?? nextStart ?? Infinity)).map((artifact) => ({ messageId: step.messageId, artifact })));
}
