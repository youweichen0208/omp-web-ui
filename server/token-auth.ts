import { timingSafeEqual } from "node:crypto";

/** Constant-time check that any candidate equals the expected shared token. */
export function tokenMatches(candidates: string[], expected: string): boolean {
	const want = Buffer.from(expected);
	let ok = false;
	for (const candidate of candidates) {
		const got = Buffer.from(candidate);
		// Length is not secret; equal-length buffers are compared in constant time.
		if (got.length === want.length && timingSafeEqual(got, want)) ok = true;
	}
	return ok;
}

/** Cookie handed to the browser after a successful token login. */
export function tokenCookie(token: string, secure: boolean): string {
	return `pi_web_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? "; Secure" : ""}`;
}
