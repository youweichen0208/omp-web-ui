import { expect, test } from "vitest";
import { cacheHitPercent, cacheObservation, recentModelUsages } from "../../web/src/usage-metrics.js";

test("cache rates use provider input, cache reads and writes without double counting output", () => {
	expect(cacheHitPercent({ input: 10, cacheRead: 80, cacheWrite: 10 })).toBe(80);
	expect(cacheHitPercent({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
});

test("recent cache trend includes only model responses with reported prompt usage", () => {
	const messages = [{ role: "user" }, ...Array.from({ length: 14 }, (_, index) => ({ role: "assistant", usage: { input: index + 1, output: 999, cacheRead: 0, cacheWrite: 0 } }))];
	expect(recentModelUsages(messages).map((usage) => usage.input)).toEqual(Array.from({ length: 12 }, (_, index) => index + 3));
	expect(cacheObservation({ input: 70, cacheRead: 20, cacheWrite: 10, output: 0 })).toBe("fresh-input");
});
