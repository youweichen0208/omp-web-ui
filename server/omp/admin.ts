import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { ompEnvironment, ompRuntimePaths, ompWorkerPath, getAgentDir } from "./paths.js";

/** Secrets travel on a private pipe, never argv, URLs, browser snapshots or logs. */
export function runOmpAdmin<T>(operation: string, data: Record<string, unknown> = {}, options: { cwd?: string; agentDir?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
	const input = JSON.stringify({ operation, ...data });
	return new Promise((resolve, reject) => {
		const child = spawn(ompRuntimePaths().bun, [ompWorkerPath("admin")], { cwd: options.cwd ?? process.cwd(), env: ompEnvironment(options.agentDir ?? getAgentDir()), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let output = "", bytes = 0, failed = false;
		const decoder = new StringDecoder("utf8");
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const finishError = (error: Error) => {
			if (failed) return;
			failed = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
			killTimer.unref();
			reject(error);
		};
		const abort = () => finishError(new Error("OMP management operation cancelled"));
		const timer = setTimeout(() => finishError(new Error(`OMP management operation timed out: ${operation}`)), options.timeoutMs ?? 60_000);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		child.on("error", finishError);
		child.stdin.on("error", finishError);
		child.stdout.on("data", (chunk: Buffer) => {
			if (failed) return;
			bytes += chunk.length;
			if (bytes > 32 * 1024 * 1024) { finishError(new Error("OMP management response exceeds limit")); return; }
			output += decoder.write(chunk);
		});
		// Drain diagnostics; upstream diagnostics are not an approved secret-redaction boundary.
		child.stderr.resume();
		child.on("close", code => {
			clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener("abort", abort);
			if (failed) return;
			output += decoder.end();
			try {
				const result = JSON.parse(output) as { ok: boolean; data: T; error?: string };
				if (code !== 0 || !result.ok) reject(new Error(result.error || "OMP management operation failed"));
				else resolve(result.data);
			} catch { reject(new Error(`OMP management process failed (${code})`)); }
		});
		if (!failed) child.stdin.end(input);
	});
}
