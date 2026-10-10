import { StringDecoder } from "node:string_decoder";
import type { Client, ClientChannel } from "ssh2";

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
export function nodeCommand(cwd: string, command: string): string {
	if (!cwd.startsWith("/") || /[\0\r\n]/.test(cwd) || cwd.length > 4096) throw new Error("Invalid remote working directory");
	if (!command.trim() || command.includes("\0") || command.length > 100000) throw new Error("Invalid remote command");
	return `sh -lc ${quote(`cd ${quote(cwd)} || exit $?\n${command}`)}`;
}

/** One bounded, cancellable SSH exec; never writes into the user's PTY. */
export function runNodeCommand(client: Client, cwd: string, command: string, timeout: number, signal?: AbortSignal): Promise<string> {
	const script = nodeCommand(cwd, command);
	if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600) throw new Error("Invalid command timeout");
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		let channel: ClientChannel | undefined, settled = false, output = "", truncated = false;
		let code: number | undefined, exitSignal: string | undefined;
		const stdout = new StringDecoder("utf8"), stderr = new StringDecoder("utf8");
		const append = (text: string) => { output += text; if (Buffer.byteLength(output) > 64 * 1024) { output = Buffer.from(output).subarray(-64 * 1024).toString("utf8"); truncated = true; } };
		const stop = () => { try { channel?.signal("TERM"); } catch { /* already closed */ } channel?.close(); };
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
			if (error) { stop(); reject(error); }
			else resolve(`${truncated ? "[输出已截断]\n" : ""}${output}\n[exit: ${code ?? "unknown"}]`);
		};
		const abort = () => finish(new Error("SSH command aborted"));
		const timer = setTimeout(() => finish(new Error(`SSH command timed out (${timeout}s)\n${output}`)), timeout * 1000);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			client.exec(script, (error, stream) => {
				if (error) { finish(error); return; }
				channel = stream;
				if (settled || signal?.aborted) { stop(); if (!settled) abort(); return; }
				stream.on("data", (data: Buffer) => append(stdout.write(data)));
				stream.stderr.on("data", (data: Buffer) => append(stderr.write(data)));
				stream.on("error", finish);
				stream.on("exit", (status: number | null, name?: string) => { if (typeof status === "number") code = status; exitSignal = name; });
				stream.on("close", () => {
					append(stdout.end()); append(stderr.end());
					finish(code === 0 ? undefined : new Error(`SSH command ${exitSignal ? `signal: ${exitSignal}` : `exit: ${code ?? "unknown"}`}\n${output}`));
				});
			});
		} catch (error) { finish(error as Error); }
	});
}
