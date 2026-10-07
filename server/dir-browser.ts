import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ServerMessage } from "./protocol.js";

/** List subdirectories for the workspace picker (`browse_dirs`).
 *
 * Deliberately NOT routed through FilesService.listFiles(), which pins
 * every listing inside the current workspace — choosing a new workspace
 * is exactly the case that has to look outside it. Scope is kept narrow
 * instead: directory *names* only, never file contents, and the same
 * loopback binding + PI_WEB_TOKEN auth as every other message guards it.
 * (The agent can already shell out with bash, so this exposes nothing it
 * could not already reach — it just makes it clickable.)
 */
export async function browseDirs(path: string | undefined, emit: (msg: ServerMessage) => void): Promise<void> {
	const MAX = 500;
	const target = resolve(path?.trim() || homedir());
	try {
		const dirents = await readdir(target, { withFileTypes: true });
		const dirs: string[] = [];
		for (const d of dirents) {
			// Symlinked directories are worth following (project checkouts
			// are often symlinked), but a broken link must not abort the
			// whole listing — isDirectory() is false for those, which is
			// the behaviour we want anyway.
			if (!d.isDirectory()) continue;
			if (d.name.startsWith(".")) continue; // dotfolders: noise here
			dirs.push(d.name);
			if (dirs.length >= MAX) break;
		}
		dirs.sort((a, b) => a.localeCompare(b));
		const parent = dirname(target);
		emit({
			type: "dir_browse",
			path: target,
			parent: parent === target ? null : parent,
			dirs,
			truncated: dirs.length >= MAX,
			drives: await listWindowsDrives(),
		});
	} catch (err) {
		emit({
			type: "notice",
			level: "error",
			text: `无法读取目录：${(err as Error).message}`,
		});
	}
}

/**
 * Windows drive roots that currently exist ("C:\\", "D:\\", …); empty on
 * POSIX (where "/" already reaches everything).
 *
 * Needed because Windows has no unified filesystem root: dirname("C:\\") is
 * "C:\\", so the picker's walk-up hits a ceiling on the boot drive and can
 * never reach D:. Probing A–Z with access() avoids shelling out to wmic /
 * PowerShell (both slow to spawn, and wmic is gone on recent Windows).
 * Missing/empty drives simply reject, so they drop out.
 */
async function listWindowsDrives(): Promise<string[] | undefined> {
	if (process.platform !== "win32") return undefined;
	const letters = Array.from({ length: 26 }, (_, i) =>
		String.fromCharCode(65 + i),
	);
	const found = await Promise.all(
		letters.map(async (letter) => {
			const root = `${letter}:\\`;
			try {
				await access(root);
				return root;
			} catch {
				return null;
			}
		}),
	);
	return found.filter((d): d is string => d !== null);
}
