import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { parseSessionEntries, type SessionManager } from "@earendil-works/pi-coding-agent";

type Source = Pick<SessionManager, "getEntry" | "getEntries" | "getSessionId">;
const stamp = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

/** Baseline belongs to the freshly loaded native manager. Subsequent reads cover only appended bytes. */
export class SessionTailValidator {
	private previous?: Stats;
	private verified = new Set<string>();
	/** Diagnostic counter: lets performance regressions assert I/O independently of machine speed. */
	bytesRead = 0;
	constructor(private path: string, source: Source) {
		try { this.previous = statSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (this.previous?.size) for (const entry of source.getEntries()) this.verified.add(entry.id);
	}
	check(source: Source): boolean {
		let fd: number | undefined;
		try {
			const current = statSync(this.path);
			const previous = this.previous;
			if (previous && stamp(previous) === stamp(current)) return true;
			if (previous && (previous.ino !== current.ino || previous.dev !== current.dev || current.size <= previous.size)) return false;
			const offset = previous?.size ?? 0;
			fd = openSync(this.path, "r");
			if (stamp(fstatSync(fd)) !== stamp(current)) return false;
			const tail = Buffer.alloc(current.size - offset);
			let read = 0;
			while (read < tail.length) {
				const n = readSync(fd, tail, read, tail.length - read, offset + read);
				if (!n) return false;
				read += n; this.bytesRead += n;
			}
			if (stamp(fstatSync(fd)) !== stamp(current) || stamp(statSync(this.path)) !== stamp(current)) return false;
			const text = tail.toString("utf8");
			if (!text.endsWith("\n")) return false;
			const lines = text.slice(0, -1).split("\n");
			if (offset === 0) {
				const header = JSON.parse(lines.shift()!);
				if (header.type !== "session" || header.id !== source.getSessionId()) return false;
			}
			const added = new Set<string>();
			for (const line of lines) {
				const entry = JSON.parse(line);
				const native = source.getEntry(entry.id);
				if (!native || this.verified.has(entry.id) || added.has(entry.id) || JSON.stringify(native) !== JSON.stringify(entry)) return false;
				added.add(entry.id);
			}
			for (const id of added) this.verified.add(id);
			this.previous = current;
			return true;
		} catch (error) {
			return !this.previous && (error as NodeJS.ErrnoException).code === "ENOENT";
		} finally { if (fd !== undefined) closeSync(fd); }
	}
}

/** Listing must never instantiate a SessionManager: open() can migrate and rewrite files. */
export class SessionBranchCounts {
	private cache = new Map<string, { stamp: string; count: number }>();
	async get(path: string): Promise<number | undefined> {
		try {
			const before = await stat(path), key = stamp(before);
			const cached = this.cache.get(path);
			if (cached?.stamp === key) return cached.count;
			const entries = parseSessionEntries(await readFile(path, "utf8"));
			if (stamp(await stat(path)) !== key) return undefined;
			const parents = new Map<string, number>();
			for (const entry of entries) if ("parentId" in entry && entry.parentId) parents.set(entry.parentId, (parents.get(entry.parentId) ?? 0) + 1);
			const count = [...parents.values()].filter(n => n > 1).length;
			this.cache.delete(path); this.cache.set(path, { stamp: key, count });
			if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
			return count;
		} catch { this.cache.delete(path); return undefined; }
	}
}
