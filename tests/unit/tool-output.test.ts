import { describe, it, expect } from "vitest";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { toolOutputUpdate } from "../../server/tool-output.js";
import { mergeLiveToolOutput } from "../../web/src/live-tool-output.js";

describe("SDK tool output → wire update → live output", () => {
	it("renders each line once when the real bash tool emits cumulative updates", async () => {
		const outputs = ["PID: 123\n", "mock started\n", "HTTP 200\n"];
		const tool = createBashTool(process.cwd(), { operations: { exec: async (_command, _cwd, { onData }) => {
			for (const output of outputs) { onData(Buffer.from(output)); await new Promise((r) => setTimeout(r, 120)); }
			return { exitCode: 0 };
		} } });
		let visible = "";
		await tool.execute("test-bash", { command: "fixture" }, undefined, (partial) => {
			const update = toolOutputUpdate(partial);
			if (update) visible = mergeLiveToolOutput(visible, update);
		});
		expect(visible).toBe(outputs.join(""));
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
