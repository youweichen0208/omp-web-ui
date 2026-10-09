import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { documentDataDir, getDocumentSettings } from "./settings.js";
import { runDocumentProcess, type RuntimeDoctor, type RuntimeOptions } from "./runtime.js";

export const CHM_PROFILE = "chm-html-v1";
export function chmRuntimeDirectory(): string {
	return getDocumentSettings().runtimePath ? join(getDocumentSettings().runtimePath!, CHM_PROFILE) : join(documentDataDir(), "runtimes", CHM_PROFILE);
}
export function chmPython(): string { return join(chmRuntimeDirectory(), "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"); }
export function chmBridgePath(): string { return fileURLToPath(new URL("./python/chm/bridge.py", import.meta.url)); }

export async function doctorChmRuntime(options: RuntimeOptions = {}): Promise<RuntimeDoctor> {
	const pythonPath = chmPython();
	try {
		await access(pythonPath);
		return { ...JSON.parse(await runDocumentProcess(pythonPath, [chmBridgePath(), "doctor"], { ...options, offline: true, timeout: 60_000 })), pythonPath };
	} catch (error) {
		options.signal?.throwIfAborted();
		return { ready: false, pythonPath, missing: [error instanceof Error ? error.message : String(error)], warnings: [] };
	}
}

export async function setupChmRuntime(options: RuntimeOptions = {}): Promise<RuntimeDoctor> {
	const root = chmRuntimeDirectory(), python = chmPython();
	await mkdir(root, { recursive: true });
	const release = await lockfile.lock(root, { realpath: false, stale: 120_000, retries: 0 });
	try {
		const existing = await doctorChmRuntime(options);
		if (existing.ready) return existing;
		try { await access(python); } catch {
			const configured = getDocumentSettings().pythonPath;
			if (configured) {
				const version = await runDocumentProcess(configured, ["-c", "import sys; print('.'.join(map(str,sys.version_info[:2])))"], options);
				if (version !== "3.12") throw new Error(`CHM runtime requires Python 3.12; found ${version}`);
				await runDocumentProcess(configured, ["-m", "venv", join(root, "venv")], options);
			} else {
				try { await runDocumentProcess("uv", ["venv", "--seed", "--python", "3.12", join(root, "venv")], options); }
				catch (error) { throw new Error(`Install uv or configure Python 3.12 with /pdf-md settings python <path>. ${error}`); }
			}
		}
		options.onProgress?.("Installing the isolated CHM parser (no OCR models required)");
		const requirements = fileURLToPath(new URL("./python/chm/requirements.txt", import.meta.url));
		await runDocumentProcess(python, ["-m", "pip", "install", "--index-url", "https://pypi.org/simple", "-r", requirements], options);
		return await doctorChmRuntime(options);
	} finally { await release(); }
}

export async function chmRuntimeFingerprint(doctor: RuntimeDoctor): Promise<string> {
	const hash = createHash("sha256").update(JSON.stringify(doctor));
	for (const name of ["bridge.py", "fixture.py", "requirements.txt"]) hash.update(await readFile(new URL(`./python/chm/${name}`, import.meta.url)));
	return hash.digest("hex");
}

export async function runChmConversion(input: { inputPath: string; outputDir: string; sourceHash: string; archiveName?: string }, options: RuntimeOptions): Promise<{ status: "complete" | "partial"; warnings: string[] }> {
	return JSON.parse(await runDocumentProcess(chmPython(), [chmBridgePath(), "convert"], { ...options, input, offline: true }));
}
