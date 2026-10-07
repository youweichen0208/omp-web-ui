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

/**
 * Cookies are not scoped by port, so a cookie from an earlier run (other port or
 * rotated token) would shadow a fresh login and make asset requests fail.
 * Re-issue the cookie unless the browser already holds the current token.
 */
export function needsTokenCookie(cookieHeader: string | undefined, token: string): boolean {
	for (const part of (cookieHeader ?? "").split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name !== "pi_web_token") continue;
		try {
			if (decodeURIComponent(rest.join("=")) === token) return false;
		} catch {
			/* malformed value: replace it */
		}
	}
	return true;
}
