/**
 * Origin / Host admission policy for HTTP and WebSocket requests.
 *
 * Pure (no env, no I/O) so it can be unit-tested; server/index.ts builds one
 * instance from the environment.
 */

export interface OriginPolicyOptions {
	/** Bind address (PI_WEB_HOST). */
	bindHost: string;
	/** Explicit hostname allowlist (PI_WEB_ALLOW_HOSTS), lower-cased. */
	allowHosts: string[];
	/** Extra allowed Origins (PI_WEB_ALLOW_ORIGINS), lower-cased. */
	allowOrigins: string[];
}

export interface RequestHeaders {
	host?: string;
	origin?: string;
}

const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** URL#hostname spelling of the loopback names a local browser can use. */
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** "host" or "host:port" → { hostname, port }. */
export function parseAuthority(a: string): { hostname: string; port: string } {
	try {
		const u = new URL(`http://${a}`);
		return { hostname: u.hostname.toLowerCase(), port: u.port || "80" };
	} catch {
		return { hostname: "", port: "" };
	}
}

/**
 * Effective Host allowlist. An explicit list always wins. When the server is
 * bound to loopback only, default to loopback hostnames: otherwise a DNS
 * rebinding page (evil.com → 127.0.0.1) passes the same-authority Origin/Host
 * check and gets full control of the agent. Non-loopback binds (LAN, Docker,
 * reverse proxy) have no safe default and keep the old behavior.
 */
export function effectiveAllowHosts(bindHost: string, allowHosts: string[]): string[] {
	if (allowHosts.length > 0) return allowHosts;
	return LOOPBACK_BIND_HOSTS.has(bindHost.toLowerCase()) ? LOOPBACK_HOSTNAMES : [];
}

export function createOriginPolicy(options: OriginPolicyOptions): (headers: RequestHeaders) => boolean {
	const allowHosts = effectiveAllowHosts(options.bindHost, options.allowHosts);
	return (headers) => {
		const host = parseAuthority((headers.host ?? "").toLowerCase());
		if (allowHosts.length > 0 && !allowHosts.includes(host.hostname)) return false;
		const origin = headers.origin;
		if (!origin) return true; // non-browser client
		const o = origin.toLowerCase();
		if (options.allowOrigins.includes(o)) return true;
		if (o === "null") return false; // file:// pages etc. are not trusted
		const ori = parseAuthority(o.replace(/^[a-z]+:\/\//, ""));
		// Same host:port only; other ports on the same host are different origins.
		return ori.hostname === host.hostname && ori.port === host.port;
	};
}
