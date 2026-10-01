import { mkdirSync, readlinkSync, symlinkSync, renameSync, unlinkSync } from "node:fs";
import { join, delimiter } from "node:path";
import { randomUUID } from "node:crypto";

/** User extensions and their child sessions must resolve the desktop-owned SDK. */
export function agentRuntimeEnvironment(pkgRoot, dataDir, executable = process.execPath) {
	const env = {
		...process.env,
		ELECTRON_RUN_AS_NODE: "1",
		PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: join(pkgRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
	};
	if (process.platform !== "win32") {
		// The detached subagent runner invokes `node`. Reuse Electron's Node
		// runtime even when the app was opened from Finder with a minimal PATH.
		const directory = join(dataDir, "runtime-bin");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const node = join(directory, "node");
		let target;
		try { target = readlinkSync(node); } catch (error) { if (error.code !== "ENOENT") throw error; }
		if (target !== executable) {
			const candidate = `${node}.${randomUUID()}`;
			try { symlinkSync(executable, candidate); renameSync(candidate, node); }
			finally { try { unlinkSync(candidate); } catch (error) { if (error.code !== "ENOENT") throw error; } }
		}
		env.PATH = [directory, env.PATH].filter(Boolean).join(delimiter);
	}
	return env;
}
