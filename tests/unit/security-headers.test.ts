import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { SECURITY_HEADERS, securityHeaders } from "../../server/security-headers.js";

describe("securityHeaders", () => {
	it("sets every baseline header and continues the chain", () => {
		const set = new Map<string, string>();
		const res = { setHeader: (n: string, v: string) => void set.set(n, v) } as unknown as Response;
		const next = vi.fn();
		securityHeaders({} as Request, res, next);
		expect(next).toHaveBeenCalledOnce();
		expect(Object.fromEntries(set)).toEqual(SECURITY_HEADERS);
	});

	it("blocks foreign framing but allows the same-origin PDF preview iframe", () => {
		expect(SECURITY_HEADERS["Content-Security-Policy"]).toBe("frame-ancestors 'self'");
		expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("SAMEORIGIN");
	});
});
