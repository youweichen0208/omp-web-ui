import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

type AuthData = Record<string, unknown>;

/**
 * Read-modify-write of the SDK's auth.json.
 *
 * The SDK stores credentials (including refreshed OAuth tokens) in this file
 * under a proper-lockfile lock, so writing it by hand without the same lock can
 * lose a concurrent token refresh. We take the same lock (same options, same
 * `<file>.lock` directory), write atomically, keep an existing file's mode and
 * create new files as 0600. An unreadable file is never replaced: the caller
 * gets an error instead of a silently emptied credential store.
 *
 * `mutate` returns the new content, or undefined to leave the file untouched.
 * Resolves true when the file was rewritten.
 */
export async function updateAuthFile(
	authPath: string,
	mutate: (data: AuthData) => AuthData | undefined,
): Promise<boolean> {
	mkdirSync(dirname(authPath), { recursive: true });
	if (!existsSync(authPath)) writeFileSync(authPath, "{}", { mode: 0o600, flag: "wx" });
	const release = await lockfile.lock(authPath, {
		realpath: false,
		stale: 30_000,
		// Same order of patience as the SDK (it waits up to 30s): contention is brief but real.
		retries: { retries: 30, minTimeout: 20, maxTimeout: 500 },
	});
	try {
		const raw = readFileSync(authPath, "utf8").replace(/^﻿/, "");
		let current: AuthData = {};
		if (raw.trim()) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				throw new Error("auth.json 无法解析，已保留原文件，未做任何修改");
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("auth.json 格式不正确，已保留原文件，未做任何修改");
			}
			current = parsed as AuthData;
		}
		const next = mutate(current);
		if (next === undefined) return false;
		const mode = statSync(authPath).mode & 0o777;
		const tmp = `${authPath}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode });
		try {
			chmodSync(tmp, mode); // umask can narrow the create mode, never widen it here
		} catch {
			/* best effort on Windows */
		}
		renameSync(tmp, authPath);
		return true;
	} finally {
		await release();
	}
}
