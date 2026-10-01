import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve, relative, delimiter } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readlinkSync, symlinkSync, renameSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const OMP_VERSION = "18.4.5";
export function ompWorkerPath(name: string): string {
	let directory = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 5; depth++, directory = dirname(directory)) {
		const candidate = join(directory, "omp-worker", `${name}.mjs`);
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`Missing OMP worker: ${name}`);
}
export function getAgentDir(): string {
	return resolve(process.env.OMP_WEB_AGENT_DIR || join(homedir(), ".omp", "agent"));
}

/** Resolve the installed runtime, never a global executable or the caller's PATH. */
export function ompRuntimePaths() {
	const bundledBun = resolve(dirname(ompWorkerPath("bootstrap")), "..", "runtime", "bun.exe");
	const bun = existsSync(bundledBun) ? bundledBun : join(dirname(require.resolve("bun/package.json")), "bin", "bun.exe");
	const root = resolve(dirname(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"))), "..");
	const cli = join(root, "dist", "cli.js");
	if (!existsSync(bun) || !existsSync(cli)) throw new Error("OMP runtime is incomplete; reinstall omp-web-ui with optional dependencies enabled");
	return { bun, cli, root };
}

/** OMP still names its directory override PI_CODING_AGENT_DIR. Never inherit a pi profile. */
export function ompEnvironment(agentDir = getAgentDir()): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "PI_PROFILE", "OMP_PROFILE", "ELECTRON_RUN_AS_NODE", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete env[key];
	const { bun } = ompRuntimePaths();
	let runtimeBin = dirname(bun);
	if (process.platform !== "win32") {
		// Upstream plugins invoke `bun` by name. The npm runtime's actual binary
		// is named bun.exe on every platform; expose it in an app-owned directory.
		runtimeBin = join(agentDir, "runtime-bin");
		mkdirSync(runtimeBin, { recursive: true });
		const shim = join(runtimeBin, "bun");
		let target: string | undefined;
		try { target = readlinkSync(shim); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (target !== bun) {
			const candidate = `${shim}.${randomUUID()}`;
			try { symlinkSync(bun, candidate); renameSync(candidate, shim); }
			finally { try { unlinkSync(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
		}
	}
	return { ...env, PATH: [runtimeBin, env.PATH].filter(Boolean).join(delimiter), PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_DIR: relative(homedir(), dirname(agentDir)), OMP_TELEMETRY_DISABLED: "1" };
}

/** Commands run in the app's visible bash terminal, including Windows bash. */
export function ompShellCommand(agentDir = getAgentDir()): string {
	const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
	const { bun } = ompRuntimePaths();
	const cli = ompWorkerPath("cli");
	return `env PI_CODING_AGENT_DIR=${quote(agentDir)} PI_CONFIG_DIR=${quote(relative(homedir(), dirname(agentDir)))} ${quote(bun)} ${quote(cli)}`;
}
