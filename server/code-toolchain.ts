import {
	readFile,
	mkdir,
	rename,
	rm,
	open,
	readdir,
	stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { extract } from "tar";
const resource = fileURLToPath(
	new URL(
		import.meta.url.endsWith(".ts")
			? "../resources/code-toolchain/"
			: "../../resources/code-toolchain/",
		import.meta.url,
	),
);
const preparations = new Map<string, Promise<string>>();
const alive = (pid: number) => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};
export function prepareToolchain(dataDir: string): Promise<string> {
	let result = preparations.get(dataDir);
	if (!result) {
		result = prepare(dataDir).catch((error) => {
			preparations.delete(dataDir);
			throw error;
		});
		preparations.set(dataDir, result);
	}
	return result;
}
export async function cleanupUnusedToolchains(dataDir: string) {
	const manifest = JSON.parse(
		await readFile(join(resource, "manifest.json"), "utf8"),
	) as { sha256: string };
	if (!/^[a-f0-9]{64}$/.test(manifest.sha256))
		throw new Error("Invalid toolchain manifest");
	const base = join(dataDir, "code-intelligence", "toolchains");
	try {
		await stat(base);
	} catch {
		return;
	}
	// Never remove caches still leased by another live application instance.
	for (const name of await readdir(base))
		if (name !== manifest.sha256 && !name.endsWith(".lock")) {
			if (name.includes(".tmp-") && alive(Number(name.split(".tmp-")[1])))
				continue;
			const path = join(base, name);
			try {
				const leases = (await readdir(path)).filter((n) =>
					n.startsWith("lease-"),
				);
				if (!leases.some((n) => alive(Number(n.slice(6)))))
					await rm(path, { recursive: true, force: true });
			} catch {
				/* another preparer */
			}
		}
}

async function prepare(dataDir: string): Promise<string> {
	const manifest = JSON.parse(
		await readFile(join(resource, "manifest.json"), "utf8"),
	) as { sha256: string };
	if (!/^[a-f0-9]{64}$/.test(manifest.sha256))
		throw new Error("Invalid toolchain manifest");
	const base = join(dataDir, "code-intelligence", "toolchains"),
		root = join(base, manifest.sha256);
	await mkdir(base, { recursive: true });
	await cleanupUnusedToolchains(dataDir);
	try {
		await stat(join(root, "ready"));
		return root;
	} catch {
		/* first use */
	}
	const deadline = Date.now() + 120_000,
		lock = root + ".lock";
	let handle;
	while (!handle) {
		try {
			handle = await open(lock, "wx");
			await handle.writeFile(String(process.pid));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const pid = Number(await readFile(lock, "utf8"));
				if (pid && !alive(pid)) await rm(lock, { force: true });
			} catch {}
			if (Date.now() > deadline)
				throw new Error("Toolchain preparation timed out");
			await new Promise((r) => setTimeout(r, 100));
			try {
				await stat(join(root, "ready"));
				return root;
			} catch {}
		}
	}
	const staging = root + `.tmp-${process.pid}`;
	try {
		try {
			await stat(join(root, "ready"));
			return root;
		} catch {}
		const archive = await readFile(join(resource, "toolchain.tar.gz"));
		if (createHash("sha256").update(archive).digest("hex") !== manifest.sha256)
			throw new Error("Toolchain integrity mismatch");
		await mkdir(staging, { recursive: true });
		await extract({
			file: join(resource, "toolchain.tar.gz"),
			cwd: staging,
			strict: true,
			filter: (path, entry) =>
				!path.split(/[\\/]/).includes("..") &&
				!path.startsWith("/") &&
				!/^[A-Za-z]:/.test(path) &&
				!(
					"type" in entry &&
					(entry.type === "SymbolicLink" || entry.type === "Link")
				),
		});
		await (
			await import("node:fs/promises")
		).writeFile(join(staging, "ready"), manifest.sha256);
		await rename(staging, root);
		return root;
	} finally {
		await handle.close();
		await rm(lock, { force: true });
		await rm(staging, { recursive: true, force: true });
	}
}
export async function leaseToolchain(root: string): Promise<() => void> {
	const path = join(resolve(root), `lease-${process.pid}`);
	await (await import("node:fs/promises")).writeFile(path, String(process.pid));
	// A process has one lease for its shared manager, removed at manager shutdown.
	return () => {
		void rm(path, { force: true });
	};
}
