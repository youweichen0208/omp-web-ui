import { describe, expect, it } from "vitest";
import { tokenCookie, tokenMatches } from "../../server/token-auth.js";

describe("token auth", () => {
	it("matches only an equal candidate", () => {
		expect(tokenMatches(["nope", "s3cret"], "s3cret")).toBe(true);
		expect(tokenMatches(["s3cre"], "s3cret")).toBe(false);
		expect(tokenMatches(["s3cret!"], "s3cret")).toBe(false);
		expect(tokenMatches([], "s3cret")).toBe(false);
	});

	it("issues a 30-day HttpOnly cookie, Secure only over https", () => {
		const plain = tokenCookie("a b", false);
		expect(plain).toContain("pi_web_token=a%20b");
		expect(plain).toContain("HttpOnly");
		expect(plain).toContain("Max-Age=2592000");
		expect(plain).not.toContain("Secure");
		expect(tokenCookie("x", true)).toContain("; Secure");
	});
});
