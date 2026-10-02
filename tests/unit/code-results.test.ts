import { it, expect } from "vitest";
import {
	boundedCodeResult,
	publicCodeLocations,
} from "../../server/code-intelligence.js";
import { codeTool } from "../../server/code-tools.js";
it("bounds diagnostic and symbol output without silently claiming completeness", () => {
	const result = boundedCodeResult({
		diagnostics: Array.from({ length: 100 }, () => ({
			message: "large diagnostic".repeat(100),
		})),
	});
	expect(result).toMatchObject({ partial: true });
	expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32768);
});
it("uses one-based UTF-16 public positions recursively", () => {
	expect(
		publicCodeLocations({
			uri: "file:///a.ts",
			range: {
				start: { line: 0, character: 3 },
				end: { line: 1, character: 4 },
			},
		}),
	).toEqual({
		uri: "file:///a.ts",
		range: { start: { line: 1, column: 4 }, end: { line: 2, column: 5 } },
	});
});
it("keeps the single tool definition within the estimated token budget", () => {
	const tool = codeTool("/project");
	const serialized = JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	});
	expect(Math.ceil(serialized.length / 3)).toBeLessThan(1500);
});

it("keeps oversized results structured", () => {
	const result = boundedCodeResult({
		diagnostics: Array.from({ length: 100 }, () => ({
			message: "x".repeat(2000),
		})),
	}) as any;
	expect(Array.isArray(result.diagnostics)).toBe(true);
	expect(result.preview).toBeUndefined();
});
