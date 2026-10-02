import { execFile } from "node:child_process";
export async function stopCodeProcess(pid: number): Promise<void> {
	if (process.platform === "win32")
		await new Promise<void>((done) =>
			execFile(
				"taskkill",
				["/PID", String(pid), "/T", "/F"],
				{ timeout: 10000, windowsHide: true },
				() => done(),
			),
		);
	else
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
}
