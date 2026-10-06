import type { ServerMessage } from "./protocol.js";

type OutputUpdate = Pick<Extract<ServerMessage, { type: "tool_delta" }>, "delta" | "replace">;

/** SDK tool updates are output snapshots; user_bash has a separate delta event. */
export function toolOutputUpdate(partial: unknown): OutputUpdate | null {
	const content = (partial as { content?: unknown } | null | undefined)?.content;
	if (!Array.isArray(content)) return null;
	const text = content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").join("");
	return { delta: text, replace: true };
}

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

/** Open only a transcript-referenced workspace file or native bash/MCP/codemode spill file. */
export async function openToolOutput(cwd: string, path: string) {
	const root = await realpath(cwd);
	const candidate = resolve(cwd, path);
	const canonical = await realpath(candidate);
	const rel = relative(root, canonical);
	const workspace = rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
	const temporary = dirname(canonical) === await realpath(tmpdir()) && /^pi-(?:bash-[a-f0-9]{16}\.log|(?:mcp|codemode)-[a-f0-9]{16}\.txt)$/.test(basename(canonical));
	if (!workspace && !temporary) throw new Error("Output unavailable");
	if ((await lstat(candidate)).isSymbolicLink()) throw new Error("Output unavailable");
	const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || await realpath(candidate) !== canonical) throw new Error("Output unavailable");
		return handle;
	} catch (error) { await handle.close(); throw error; }
}
