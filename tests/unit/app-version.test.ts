import { expect, test } from "vitest";
import { compareAppVersions } from "../../server/app-version.js";

test.each([
	["1.0.0-beta.1", "1.0.0-beta.2"],
	["1.0.0-beta.2", "1.0.0-beta.10"],
	["1.0.0-beta.10", "1.0.0"],
	["1.0.0", "1.1.0-beta.1"],
])("update ordering %s precedes %s", (a, b) => {
	expect(compareAppVersions(a, b)).toBeLessThan(0);
	expect(compareAppVersions(b, a)).toBeGreaterThan(0);
});
test("build metadata does not change precedence", () => {
	expect(compareAppVersions("1.0.0-beta.1+build1", "1.0.0-beta.1+build2")).toBe(0);
});
