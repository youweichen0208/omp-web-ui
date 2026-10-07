import { describe, expect, it } from "vitest";
import { needsTokenCookie, tokenCookie, tokenMatches } from "../../server/token-auth.js";

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

	it("re-issues the cookie when it is missing, stale or malformed", () => {
		expect(needsTokenCookie(undefined, "new")).toBe(true);
		expect(needsTokenCookie("pi_web_token=old; other=1", "new")).toBe(true);
		expect(needsTokenCookie("pi_web_token=%E0%A4%A", "new")).toBe(true);
		expect(needsTokenCookie("a=1; pi_web_token=new", "new")).toBe(false);
		expect(needsTokenCookie(`pi_web_token=${encodeURIComponent("a b")}`, "a b")).toBe(false);
	});
});
