import type { NativeMcpServerStatus } from "./protocol.js";

/** Pi's official non-TUI /mcp output is the status API in 1.0.1. Keep unknown lines visible. */
export function parseNativeMcpStatus(text: string): NativeMcpServerStatus[] {
	const servers: NativeMcpServerStatus[] = [];
	for (const line of text.split("\n")) {
		const match = /^([\w-]+): (needs sign-in|disabled|disconnected|connecting|connected|starting|failed|error)(.*)$/.exec(line);
		if (match) servers.push({ name: match[1], state: match[2] === "needs sign-in" ? "needs-auth" : match[2], toolCount: Number(/, (\d+) tools/.exec(match[3])?.[1] ?? 0), detail: line });
		else if (/^\s+/.test(line) && servers.length) servers[servers.length - 1].detail += `\n${line.trim()}`;
	}
	return servers;
}
