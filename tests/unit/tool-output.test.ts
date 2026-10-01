import { describe, it, expect } from "vitest";
import { toolOutputUpdate } from "../../server/tool-output.js";
import { mergeLiveToolOutput } from "../../web/src/live-tool-output.js";

describe("SDK tool output → wire update → live output", () => {
	it("renders cumulative OMP tool updates without duplicate lines", () => {
		let visible = "";
		for (const text of ["PID: 123\n", "PID: 123\nmock started\n", "PID: 123\nmock started\nHTTP 200\n"]) {
			const update = toolOutputUpdate({ content: [{ type: "text", text }] });
			if (update) visible = mergeLiveToolOutput(visible, update);
		}
		expect(visible).toBe("PID: 123\nmock started\nHTTP 200\n");
	});
	it("replaces rolling snapshots and allows an empty snapshot to clear output", () => {
		const snapshot = (text: string) => toolOutputUpdate({ content: [{ type: "text", text }] })!;
		let visible = mergeLiveToolOutput("", snapshot("first\nsecond\n"));
		visible = mergeLiveToolOutput(visible, snapshot("second\nthird\n"));
		expect(visible).toBe("second\nthird\n");
		expect(mergeLiveToolOutput(visible, snapshot(""))).toBe("");
	});
	it("still appends the genuine user_bash deltas", () => {
		const first = mergeLiveToolOutput("", { delta: "one\n" });
		expect(mergeLiveToolOutput(first, { delta: "two\n" })).toBe("one\ntwo\n");
	});
	it("retains the newest output when a snapshot exceeds the cap", () => {
		const output = "x".repeat(210000) + "latest";
		const visible = mergeLiveToolOutput("old", { delta: output, replace: true });
		expect(visible.endsWith("latest")).toBe(true);
		expect(visible.length).toBeLessThan(200100);
	});
});
