import { describe, expect, it } from "vitest";
import { createBashTool, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { boundedBashOperations } from "../../server/bounded-bash.js";

describe("one-shot bash timeout", () => {
	it("supplies a 120 second fallback and preserves explicit timeouts", async () => {
		const seen: Array<number | undefined> = [];
		const operations = boundedBashOperations({ exec: async (_command, _cwd, options) => {
			seen.push(options.timeout);
			return { exitCode: 0 };
		} });
		const tool = createBashTool(process.cwd(), { operations });
		await tool.execute("default", { command: "fixture" });
		await tool.execute("explicit", { command: "fixture", timeout: 600 });
		expect(seen).toEqual([120, 600]);
	});
	it("ends a real silent command and returns the timeout to the SDK", async () => {
		const tool = createBashTool(process.cwd(), {
			operations: boundedBashOperations(createLocalBashOperations(), 0.15),
		});
		await expect(tool.execute("silent", { command: "sleep 1" })).rejects.toThrow("Command timed out after 0.15 seconds");
	});
});
