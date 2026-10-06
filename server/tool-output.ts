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
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

/** Open only a transcript-referenced workspace file or native bash/MCP/codemode spill file. */
export async function openToolOutput(cwd: string, path: string) {
	const root = await realpath(cwd);
	const candidate = resolve(cwd, path);
	const canonical = await realpath(candidate);
	const rel = relative(root, canonical);
	const workspace = rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
	const temporary = dirname(canonical) === await realpath(tmpdir()) && /^pi-(?:(?:bash|powershell)-[a-f0-9]{16}\.log|mcp-[a-f0-9]{16}\.[A-Za-z0-9]{1,8}|codemode-[a-f0-9]{16}\.(?:txt|png|jpg|gif|webp))$/.test(basename(canonical));
	if (!workspace && !temporary) throw Object.assign(new Error("Output access denied"), { code: "EACCES" });
	if ((await lstat(candidate)).isSymbolicLink()) throw Object.assign(new Error("Output access denied"), { code: "EACCES" });
	const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || await realpath(candidate) !== canonical) throw Object.assign(new Error("Output access denied"), { code: "EACCES" });
		return handle;
	} catch (error) { await handle.close(); throw error; }
}

import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export const toolOutputId = (path: string) => createHash("sha256").update(path).digest("hex");

/** Native 1.0.4 model-facing markers, not arbitrary paths from browser requests. */
export function outputReferences(text: string): string[] {
	return [...text.matchAll(/\[Image saved to ([^\r\n]+?) \(image\/(?:png|jpeg|gif|webp), [^\r\n]*?\)\]|\[Binary resource [^\r\n]*? saved to ([^\r\n]+?)\]/g)].map(m => m[1] ?? m[2]);
}
/** Bound I/O as well as memory; the final partial line may contain complete markers. */
async function scanOutputReferences(handle: FileHandle): Promise<string[]> {
	const limit = 8 * 1024 * 1024;
	const buffer = Buffer.alloc(64 * 1024), decoder = new StringDecoder("utf8");
	const paths: string[] = [];
	let position = 0, fragments: string[] = [];
	while (position < limit) {
		const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - position), position);
		if (!bytesRead) break;
		position += bytesRead;
		const text = decoder.write(buffer.subarray(0, bytesRead));
		let start = 0, newline: number;
		while ((newline = text.indexOf("\n", start)) !== -1) {
			fragments.push(text.slice(start, newline));
			for (const path of outputReferences(fragments.join(""))) paths.push(path);
			fragments = [];
			start = newline + 1;
		}
		if (start < text.length) fragments.push(text.slice(start));
	}
	// Do not flush an incomplete UTF-8 sequence at the scan limit.
	for (const path of outputReferences(fragments.join(""))) paths.push(path);
	return paths;
}

export async function toolOutputManifest(cwd: string, toolName: string, text: string, fullPath?: string) {
	const paths = new Set<string>();
	if (fullPath) paths.add(fullPath);
	const nativeResources = toolName === "codemode" || toolName === "read_mcp_resource" || /^mcp__.+?__.+$/.test(toolName);
	if (nativeResources) {
		for (const path of outputReferences(text)) paths.add(path);
		if (fullPath) {
			let handle;
			try {
				handle = await openToolOutput(cwd, fullPath);
				for (const path of await scanOutputReferences(handle)) paths.add(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			} finally { await handle?.close(); }
		}
	}
	return [...paths].map(path => ({ id: toolOutputId(path), name: basename(path), path, default: path === fullPath }));
}
