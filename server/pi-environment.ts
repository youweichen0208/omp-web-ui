import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appVersion } from "./app-version.js";
import type { ServerMessage } from "./protocol.js";

type Emit = (msg: ServerMessage) => void;

/**
 * Whether the pi agent config looks ready: the agent dir exists and
 * auth.json has at least one provider credential. Cached for 2s.
 */
export class PiConfigProbe {
	private readonly agentDir: string;
	private cache: { at: number; configured: boolean } | null = null;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	isConfigured(): boolean {
		const now = Date.now();
		const cached = this.cache;
		if (cached && now - cached.at < 2000) return cached.configured;
		let configured = false;
		try {
			const authPath = join(this.agentDir, "auth.json");
			if (existsSync(authPath)) {
				const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
					string,
					unknown
				>;
				configured =
					typeof data === "object" &&
					data !== null &&
					Object.keys(data).length > 0;
			}
		} catch {
			configured = false;
		}
		this.cache = { at: now, configured };
		return configured;
	}

	invalidate(): void {
		this.cache = null;
	}
}

/**
 * Whether the pi CLI binary is installed and runnable (`pi --version`
 * probe). Cached machine-wide (same binary for every client) for 10s —
 * the check is only rerun after install or when the cache expires.
 */
let piCliProbe: { at: number; installed: boolean } | null = null;
const PI_CLI_PROBE_TTL_MS = 10_000;

export function isPiCliInstalled(): boolean {
	const now = Date.now();
	const cached = piCliProbe;
	if (cached && now - cached.at < PI_CLI_PROBE_TTL_MS) return cached.installed;
	let installed = false;
	try {
		const res = spawnSync("pi", ["--version"], {
			timeout: 5000,
			stdio: "ignore",
			// Windows: `pi` resolves to a pi.cmd shim — spawnSync can only
			// exec those through a shell (else ENOENT).
			shell: process.platform === "win32",
		});
		installed = !res.error && res.status === 0;
	} catch {
		installed = false;
	}
	piCliProbe = { at: now, installed };
	return installed;
}

function invalidatePiCliProbe(): void {
	piCliProbe = null;
}

/**
 * Run a command async, collecting stdout+stderr; kills on timeout.
 * Never throws / never crashes the server: spawn errors (ENOENT etc.)
 * resolve with code -1 so callers can report them as notices.
 */
function runAsync(
	cmd: string,
	args: string[],
	timeoutMs: number,
	cwd?: string,
): Promise<{ code: number | null; out: string }> {
	return new Promise((resolve) => {
		let p;
		try {
			p = spawn(cmd, args, {
				...(cwd ? { cwd } : {}),
				stdio: ["ignore", "pipe", "pipe"],
				// Windows: npm and friends are .cmd shims — Node can only exec
				// them through the shell (otherwise spawn npm → ENOENT).
				shell: process.platform === "win32",
			});
		} catch (err) {
			resolve({ code: -1, out: String(err) });
			return;
		}
		let out = "";
		let settled = false;
		const done = (code: number | null, text?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(t);
			resolve({ code, out: text ?? out });
		};
		const t = setTimeout(() => p.kill(), timeoutMs);
		p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
		p.stderr?.on("data", (d: Buffer) => (out += d.toString()));
		p.on("error", (err) => done(-1, String(err)));
		p.on("close", (code) => done(code));
	});
}

/** Simple numeric semver compare: >0 means a newer than b. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x - y;
	}
	return 0;
}

/** Ask the npm registry for the latest pi-harness version and report it. */
export async function checkUpdate(emit: Emit): Promise<void> {
	const current = appVersion();
	try {
		// Fetch the full package doc (not /latest): it carries the per-version
		// publish timestamps so the UI can hint when a version was JUST
		// published and the registry/CDN caches may not have caught up yet.
		const res = await fetch("https://registry.npmjs.org/@youweichen%2fpi-harness", {
			signal: AbortSignal.timeout(8_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as {
			"dist-tags"?: { latest?: string };
			time?: Record<string, string>;
		};
		const latest = data["dist-tags"]?.latest ?? null;
		const latestPublishedAt =
			latest && data.time ? (data.time[latest] ?? null) : null;
		const upToDate = latest === null || compareVersions(current, latest) >= 0;
		emit({
			type: "update_status",
			current,
			latest,
			latestPublishedAt,
			upToDate,
		});
	} catch (err) {
		emit({
			type: "update_status",
			current,
			latest: null,
			latestPublishedAt: null,
			upToDate: false,
			error: `检查更新失败：${(err as Error).message}`,
		});
	}
}

/**
 * Auto-install the pi agent: ensure the config dir exists and install the
 * pi CLI globally (npm i -g). Auth is configured afterwards via the API key
 * form or by running `pi` in a terminal. Callers should re-send a snapshot
 * afterwards so the UI re-probes the CLI.
 */
export async function installPiAgent(agentDir: string, emit: Emit): Promise<void> {
	try {
		mkdirSync(agentDir, { recursive: true });
		emit({
			type: "notice",
			level: "info",
			text: "正在安装 pi agent CLI（npm i -g @earendil-works/pi-coding-agent）…",
		});
		const { code, out } = await runAsync(
			"npm",
			["i", "-g", "@earendil-works/pi-coding-agent"],
			180_000,
		);
		if (code === 0) {
			emit({
				type: "notice",
				level: "info",
				text: "✅ pi agent CLI 安装完成。填入 API 密钥即可开始，或在终端运行 pi 完成登录。",
			});
			emit({ type: "install_result", ok: true, detail: "" });
		} else {
			emit({
				type: "notice",
				level: "error",
				text: `pi agent 安装失败（${code ?? "timeout"}）：${out.slice(0, 400)}`,
			});
			emit({
				type: "install_result",
				ok: false,
				detail: out.slice(0, 600),
			});
		}
	} catch (err) {
		emit({
			type: "notice",
			level: "error",
			text: `pi agent 安装失败：${(err as Error).message}`,
		});
	}
	// The CLI may just have landed on PATH (or the install may have failed) —
	// drop the probe cache so the next snapshot re-checks.
	invalidatePiCliProbe();
}
