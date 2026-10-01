import { it, expect } from "vitest";
import { ThinkingTimings, ThinkingDurationStore } from "../../server/thinking-timing.js";
import type { UiMessage } from "../../server/protocol.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const message: UiMessage = { id: "a", role: "assistant", content: [{ type: "thinking", thinking: "test" }] };
it("measures each block, freezes at end, and leaves old history unknown", () => {
	const timings = new ThinkingTimings();
	expect(timings.annotate(message, 42)).toBe(message);
	timings.observe(42, { type: "thinking_start", contentIndex: 0 }, 1000);
	timings.observe(42, { type: "thinking_delta", contentIndex: 0 }, 2000);
	expect(timings.annotate(message, 42, 3000)?.content[0]).toMatchObject({ durationMs: 2000 });
	timings.observe(42, { type: "thinking_end", contentIndex: 0 }, 4500);
	expect(timings.annotate(message, 42, 9000)?.content[0]).toMatchObject({ durationMs: 3500 });
	expect(message.content[0]).not.toHaveProperty("durationMs");
	expect(new ThinkingTimings().annotate(message, 42)).toBe(message);
});
it("finishes interrupted thinking at message end", () => {
	const timings = new ThinkingTimings();
	timings.observe(7, { type: "thinking_delta", contentIndex: 0 }, 100);
	timings.finish(7, 1100);
	expect(timings.annotate(message, 7, 9000)?.content[0]).toMatchObject({ durationMs: 1000 });
});
it("restores measured block durations after a service restart, scoped to the transcript", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-thinking-duration-"));
	try {
		const file = join(dir, "thinking-durations.json");
		const timings = new ThinkingTimings();
		timings.observe(42, { type: "thinking_start", contentIndex: 0 }, 1000);
		timings.finish(42, 2200);
		new ThinkingDurationStore(file).save("/sessions/one.jsonl", 42, timings.finishedDurations(42));
		const restored = new ThinkingDurationStore(file);
		expect(restored.annotate(message, "/sessions/one.jsonl", 42)?.content[0]).toMatchObject({ durationMs: 1200 });
		expect(restored.annotate(message, "/sessions/two.jsonl", 42)).toBe(message);
		expect(restored.annotate(message, "/sessions/one.jsonl", 43)).toBe(message);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
