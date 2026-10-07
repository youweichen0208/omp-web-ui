import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PrivateWriteOptions {
	/** Mode for the written file (default 0600). Ignored on Windows. */
	mode?: number;
	/** Reuse the mode of an existing file (a user may have chosen it) instead of `mode`. */
	keepExistingMode?: boolean;
}

/**
 * Atomic write (tmp + rename) of a file that may hold secrets or personal state:
 * new directories are 0700, the file is 0600 unless told otherwise, and a crash
 * mid-write never leaves a truncated file.
 */
export function writeFileAtomic(path: string, data: string, options: PrivateWriteOptions = {}): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	let mode = options.mode ?? 0o600;
	if (options.keepExistingMode) {
		try {
			mode = statSync(path).mode & 0o777;
		} catch {
			/* new file */
		}
	}
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, data, { mode });
	try {
		chmodSync(tmp, mode); // the create mode is masked by umask; make it exact
	} catch {
		/* best effort on Windows */
	}
	renameSync(tmp, path);
}
