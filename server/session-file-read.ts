import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { parseSessionEntries, type SessionManager } from "@earendil-works/pi-coding-agent";

type Source = Pick<SessionManager, "getEntry" | "getEntries" | "getHeader">;
const stamp = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const matches = (native: unknown, disk: unknown) => native !== undefined && isDeepStrictEqual(JSON.parse(JSON.stringify(native)), disk);

/** Verify the baseline once, then read only appended bytes except for equal-size stamp changes. */
export class SessionTailValidator {
	private previous?: Stats;
	private verified = new Set<string>();
	private invalid = false;
	/** Includes baseline I/O; callers can measure subsequent reads by subtracting the initial value. */
	bytesRead = 0;
	constructor(private path: string, source: Source) {
		this.check(source);
	}
	check(source: Source): boolean {
		if (this.invalid) return false;
		const valid = this.validate(source);
		this.invalid = !valid;
		return valid;
	}
	private validate(source: Source): boolean {
		let fd: number | undefined;
		let observed = false;
		try {
			const current = statSync(this.path);
			observed = true;
			const previous = this.previous;
			if (previous && stamp(previous) === stamp(current)) return true;
			if (previous && (previous.ino !== current.ino || previous.dev !== current.dev || current.size < previous.size)) return false;
			const full = !previous || current.size === previous.size;
			const offset = full ? 0 : previous.size;
			const expected = full ? [source.getHeader(), ...source.getEntries()] : undefined;
			const added = new Set<string>();
			let index = 0;
			const accept = (line: string): boolean => {
				if (!line.trim()) return true;
				const entry = JSON.parse(line);
				if (full) {
					if (!matches(expected![index], entry)) return false;
				} else if (!matches(source.getEntry(entry.id), entry) || this.verified.has(entry.id)) return false;
				if (!(full && index === 0)) {
					if (typeof entry.id !== "string" || added.has(entry.id)) return false;
					added.add(entry.id);
				}
				index++;
				return true;
			};
			fd = openSync(this.path, "r");
			if (stamp(fstatSync(fd)) !== stamp(current)) return false;
			const buffer = Buffer.alloc(64 * 1024), decoder = new StringDecoder("utf8");
			let position = offset;
			let fragments: string[] = [];
			while (position < current.size) {
				const n = readSync(fd, buffer, 0, Math.min(buffer.length, current.size - position), position);
				if (!n) return false;
				position += n; this.bytesRead += n;
				const text = decoder.write(buffer.subarray(0, n));
				let start = 0, newline: number;
				while ((newline = text.indexOf("\n", start)) !== -1) {
					fragments.push(text.slice(start, newline));
					if (!accept(fragments.join(""))) return false;
					fragments = [];
					start = newline + 1;
				}
				if (start < text.length) fragments.push(text.slice(start));
			}
			if (decoder.end() || fragments.length || !index || (expected && index !== expected.length)) return false;
			if (stamp(fstatSync(fd)) !== stamp(current) || stamp(statSync(this.path)) !== stamp(current)) return false;
			if (full) this.verified = added;
			else for (const id of added) this.verified.add(id);
			this.previous = current;
			return true;
		} catch (error) {
			return !observed && !this.previous && (error as NodeJS.ErrnoException).code === "ENOENT";
		} finally { if (fd !== undefined) closeSync(fd); }
	}
}

/** Listing must never instantiate a SessionManager: open() can migrate and rewrite files. */
export class SessionBranchCounts {
	private cache = new Map<string, { stamp: string; count: number }>();
	async getMany(paths: readonly string[]): Promise<(number | undefined)[]> {
		const results = new Array<number | undefined>(paths.length);
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(8, paths.length) }, async () => {
			while (next < paths.length) {
				const index = next++;
				results[index] = await this.get(paths[index]);
			}
		}));
		return results;
	}
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
