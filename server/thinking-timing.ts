import type { UiMessage } from "./protocol.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Per-conversation observed timings. Historical blocks without events stay unknown. */
export class ThinkingTimings {
	private messages = new Map<number, Map<number, { start: number; end?: number }>>();
	observe(timestamp: number, event: { type: string; contentIndex?: number }, now = Date.now()) {
		if (!event.type.startsWith("thinking_") || event.contentIndex === undefined) return;
		let blocks = this.messages.get(timestamp);
		if (!blocks) {
			blocks = new Map(); this.messages.set(timestamp, blocks);
			if (this.messages.size > 256) this.messages.delete(this.messages.keys().next().value!);
		}
		const index = event.contentIndex;
		let timing = blocks.get(index);
		if (!timing && event.type !== "thinking_end") {
			timing = { start: now }; blocks.set(index, timing);
		}
		if (timing && event.type === "thinking_end") timing.end = now;
	}
	finish(timestamp: number, now = Date.now()) {
		for (const timing of this.messages.get(timestamp)?.values() ?? []) timing.end ??= now;
	}
	finishedDurations(timestamp: number): Record<string, number> {
		const result: Record<string, number> = {};
		for (const [index, timing] of this.messages.get(timestamp) ?? []) {
			if (timing.end !== undefined) result[index] = Math.max(0, timing.end - timing.start);
		}
		return result;
	}
	annotate(message: UiMessage | null, timestamp: number, now = Date.now()): UiMessage | null {
		const blocks = this.messages.get(timestamp);
		if (!message || !blocks) return message;
		return { ...message, content: message.content.map((block, index) => {
			const timing = blocks.get(index);
			return block.type === "thinking" && timing ? { ...block, durationMs: Math.max(0, (timing.end ?? now) - timing.start) } : block;
		}) };
	}
}

/** Preserve measured durations across server restarts without changing SDK transcripts. */
export class ThinkingDurationStore {
	private values: Record<string, Record<string, number>>;
	constructor(private readonly filePath: string) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
			this.values = parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? parsed as Record<string, Record<string, number>> : {};
		} catch { this.values = {}; }
	}
	private key(sessionFile: string, timestamp: number): string { return `${sessionFile}\u0000${timestamp}`; }
	save(sessionFile: string | null | undefined, timestamp: number, durations: Record<string, number>): void {
		if (!sessionFile || !Number.isFinite(timestamp) || timestamp <= 0 || Object.keys(durations).length === 0) return;
		const key = this.key(sessionFile, timestamp);
		this.values[key] = durations;
		const keys = Object.keys(this.values);
		for (const old of keys.slice(0, Math.max(0, keys.length - 2048))) delete this.values[old];
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			const tmp = `${this.filePath}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.values));
			renameSync(tmp, this.filePath);
		} catch { /* Duration metadata must never interrupt a reply. */ }
	}
	annotate(message: UiMessage | null, sessionFile: string | null | undefined, timestamp: number): UiMessage | null {
		if (!message || !sessionFile || !Number.isFinite(timestamp)) return message;
		const durations = this.values[this.key(sessionFile, timestamp)];
		if (!durations || typeof durations !== "object") return message;
		return { ...message, content: message.content.map((block, index) => {
			const durationMs = durations[index];
			return block.type === "thinking" && block.durationMs === undefined && typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
				? { ...block, durationMs } : block;
		}) };
	}
}
