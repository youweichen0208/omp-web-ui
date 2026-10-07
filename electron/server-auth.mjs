import { randomBytes } from "node:crypto";

/**
 * The desktop server listens on a random loopback port. Without a shared token
 * any local process (or other user on a shared machine) that finds the port
 * could drive the agent, so every launch gets its own secret. An explicit
 * PI_WEB_TOKEN still wins so tests and managed setups can pin it.
 */
export function desktopServerToken(env = process.env) {
	return env.PI_WEB_TOKEN?.trim() || randomBytes(32).toString("hex");
}

/** First navigation carries the token; the web client moves it to storage and strips it. */
export function desktopWindowUrl(port, token) {
	return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

export function bearerHeaders(token) {
	return { Authorization: `Bearer ${token}` };
}
