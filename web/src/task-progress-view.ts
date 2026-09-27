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
	if (afterTest && /修复|修正|fix|debug|rerun|重跑|复测/.test(text)) return "fix";
	if (/pytest|vitest|npm\s+(?:run\s+)?test|测试|test\b/.test(text)) return "test";
	if (step.artifacts.length && step.artifacts.every((item) => ["read", "grep", "find", "ls"].includes(item.kind)) || /读取|查看|检查|调研|分析/.test(text) && !step.artifacts.some((item) => ["write", "edit"].includes(item.kind))) return "read";
	if (afterTest && step.artifacts.some((item) => ["write", "edit"].includes(item.kind))) return "fix";
	if (step.artifacts.some((item) => ["write", "edit"].includes(item.kind)) || /实现|搭建|编写|创建|修改/.test(text)) return "build";
	return "other";
}

const titles: Record<ProgressPhase["kind"], string> = {
	read: "读取与确认", build: "实现主体", migration: "补 migrations", test: "运行测试", fix: "运行并修复", commit: "提交", other: "处理任务",
};

/** Consecutive transcript steps become readable phases; every raw step remains available underneath. */
export function progressPhases(task: TaskProgress): ProgressPhase[] {
	const phases: ProgressPhase[] = [];
	let tested = false;
	for (const step of task.steps) {
		let kind = kindOf(step, tested);
		const previous = phases.at(-1)?.kind;
		if (kind === "read" && previous && previous !== "read" && previous !== "other") kind = previous;
		if (kind === "test" && previous === "fix") kind = "fix";
		if (kind === "other" && phases.length) kind = phases.at(-1)!.kind;
		if (kind === "test") tested = true;
		if (kind === "fix" && phases.at(-1)?.kind === "test") phases.at(-1)!.title = "运行测试";
		let phase = phases.at(-1);
		if (!phase || phase.kind !== kind) {
			phase = { id: step.id, kind, title: titles[kind], steps: [], status: "done", startedAt: step.startedAt, counts: { read: 0, write: 0, edit: 0, command: 0 } };
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
