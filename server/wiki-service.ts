import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { decodeText, looksLikeText, previewKind } from "./text-sniff.js";
import { wikiMetadata, wikiReferences, resolveWikiLink } from "./wiki-links.js";
import { readWikiPdf } from "./wiki-pdf.js";
import type { WikiEntry, WikiState, WikiDocument, WikiRevision, WikiChange, WikiSearchResult, WikiDirectory, WikiIndexStatus, WikiDocumentContent, WikiDocumentReferences } from "./protocol.js";

const MAX_FILE = 2 * 1024 * 1024;
const MAX_SNAPSHOT = 64 * 1024 * 1024;
const IGNORED = new Set([".git", "node_modules", ".pi-web", ".DS_Store"]);
// Generated dependencies and duplicate checkouts must not consume the main
// workspace's index or undo budget. Explicit directory/file requests stay usable.
const TRAVERSAL_IGNORED_DIRS = new Set([".venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
function skipTraversalDirectory(parent: string, name: string) {
	return TRAVERSAL_IGNORED_DIRS.has(name) || (name === "worktrees" && basename(parent) === ".claude");
}
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
type Snapshot = { files: Map<string, Buffer>; skipped: string[]; limited?: boolean };
export class WikiConflictError extends Error {}
type RevisionAttribution = Pick<WikiRevision, "conversationId" | "requestId" | "assistantTimestamp">;
type StoredRevision = WikiRevision & { blobs: Record<string, { before: string | null; after: string | null }> };

/** Resolve real paths, including every existing parent of a new file. */
export function wikiPath(cwd: string, path: string): string {
	if (typeof path !== "string" || path.includes("\0") || path.length > 4096) throw new Error("Invalid path");
	const root = realpathSync(cwd), absolute = resolve(root, path);
	const inside = (p: string) => { const r = relative(root, p); return r !== ".." && !r.startsWith(`..${sep}`) && !/^[A-Za-z]:/.test(r) && !r.startsWith(sep); };
	if (!inside(absolute)) throw new Error("Path outside workspace");
	let p = absolute;
	while (p !== root) {
		if (existsSync(p)) { if (!inside(realpathSync(p))) throw new Error("Path outside workspace"); break; }
		// A dangling symlink must never be treated as an absent regular file.
		try { if (lstatSync(p).isSymbolicLink()) throw new Error("Invalid symbolic link"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
		p = dirname(p);
	}
	return absolute;
}
function kindOf(path: string, text: boolean): WikiEntry["kind"] {
	if (/\.(md|markdown|txt)$/i.test(path)) return "document";
	if (/\.pdf$/i.test(path)) return "pdf";
	if (previewKind(path) === "image") return "image";
	return text || previewKind(path) === "text" ? "code" : "other";
}
type WikiIndex = { at: number; entries: WikiEntry[]; texts: Map<string, string>; limited: boolean; status: WikiIndexStatus; references: Map<string, ReturnType<typeof wikiReferences>>; backlinks: Map<string, WikiDocument["backlinks"]> };
export class WikiService {
	private active = new Set<string>();
	private cache = new Map<string, WikiIndex>();
	private scans = new Map<string, Promise<WikiIndex>>();
	private generations = new Map<string, number>();
	constructor(private dataDir: string) { mkdirSync(dataDir, { recursive: true }); }
	private key(cwd: string) { return hash(realpathSync(cwd)); }
	private folder(cwd: string) { const dir = join(this.dataDir, this.key(cwd)); mkdirSync(join(dir, "blobs"), { recursive: true }); return dir; }
	busy(cwd: string) { return this.active.has(this.key(cwd)); }
	invalidate(cwd: string) { const key = this.key(cwd); this.cache.delete(key); this.generations.set(key, (this.generations.get(key) ?? 0) + 1); }
	private history(cwd: string): StoredRevision[] {
		const file = join(this.folder(cwd), "history.json");
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
	}
	private persist(cwd: string, records: StoredRevision[]) {
		records = records.slice(-100);
		let total = 0;
		for (let i = records.length - 1; i >= 0; i--) {
			const bytes = Object.values(records[i].blobs).flatMap(b => [b.before, b.after]).reduce((sum, id) => sum + (id ? statSync(join(this.folder(cwd), "blobs", id)).size : 0), 0);
			if (i < records.length - 1 && total + bytes > 128 * 1024 * 1024) { records = records.slice(i + 1); break; }
			total += bytes;
		}
		const file = join(this.folder(cwd), "history.json"), temporary = file + ".tmp";
		writeFileSync(temporary, JSON.stringify(records.slice(-100)), { mode: 0o600 }); renameSync(temporary, file);
		// Retain only blobs referenced by the latest 100 requests.
		const retained = new Set(records.slice(-100).flatMap(r => Object.values(r.blobs).flatMap(b => [b.before, b.after]).filter(Boolean)));
		for (const name of readdirSync(join(this.folder(cwd), "blobs"))) if (!retained.has(name)) rmSync(join(this.folder(cwd), "blobs", name), { force: true });
	}
	async index(cwd: string, fresh = false): Promise<WikiIndex> {
		const key = this.key(cwd), cached = this.cache.get(key);
		if (!fresh && cached) {
			if (Date.now() - cached.at >= 30000) void this.scan(cwd).catch(() => {});
			return cached;
		}
		if (!fresh && this.scans.has(key)) {
			const result = await this.scans.get(key)!;
			return this.cache.has(key) ? result : this.scan(cwd);
		}
		// Forced snapshots must observe changes after any already running scan.
		if (fresh && this.scans.has(key)) await this.scans.get(key);
		return this.scan(cwd);
	}
	private scan(cwd: string): Promise<WikiIndex> {
		const key = this.key(cwd), pending = this.scans.get(key);
		if (pending) return pending;
		const generation = this.generations.get(key) ?? 0;
		const task = this.buildIndex(cwd).then(result => {
			if ((this.generations.get(key) ?? 0) === generation) {
				if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
				this.cache.set(key, result);
			}
			return result;
		}).finally(() => this.scans.delete(key));
		this.scans.set(key, task);
		return task;
	}
	private async buildIndex(cwd: string): Promise<WikiIndex> {
		const entries: WikiEntry[] = [], texts = new Map<string, string>();
		let limited = false, bytes = 0, visited = 0;
		const status: WikiIndexStatus = { indexed: 0, total: 0, totalIsLowerBound: false, issues: [] };
		const walk = async (path: string, depth: number) => {
			if (depth > 32) { limited = true; status.totalIsLowerBound = true; status.issues.push({ path, reason: "depth-limit", subtree: true }); return; }
			let children;
			try { children = await readdir(wikiPath(cwd, path), { withFileTypes: true }); } catch { limited = true; status.totalIsLowerBound = true; status.issues.push({ path, reason: "unreadable", subtree: true }); return; }
			children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
			for (const child of children) {
				if (IGNORED.has(child.name) || child.isDirectory() && skipTraversalDirectory(path, child.name)) continue;
				if (visited >= 20000) { limited = true; status.totalIsLowerBound = true; status.issues.push({ path: path || ".", reason: "entry-limit", subtree: true }); break; }
				visited++;
				const p = path ? `${path}/${child.name}` : child.name;
				let size: number | undefined, counted = false;
				try {
					const abs = wikiPath(cwd, p);
					if (realpathSync(abs) === realpathSync(this.dataDir)) continue;
					const info = await stat(abs);
					if (info.isDirectory()) { entries.push({ path: p, name: child.name, kind: "directory", size: 0, modified: info.mtimeMs, tags: [], symlink: child.isSymbolicLink() }); if (!child.isSymbolicLink()) await walk(p, depth + 1); continue; }
					if (!info.isFile()) continue;
					status.total++; counted = true; size = info.size;
					let text: string | undefined;
					if (info.size <= MAX_FILE && bytes + info.size <= MAX_SNAPSHOT) {
						const data = await readFile(abs); bytes += data.length; status.indexed++;
						if (!/\.pdf$/i.test(p) && previewKind(p) !== "image" && looksLikeText(data)) { text = decodeText(data); texts.set(p, text); }
					} else { limited = true; status.issues.push({ path: p, size: info.size, reason: info.size > MAX_FILE ? "file-size" : "byte-budget" }); }
					const metadata = text === undefined ? { tags: [] } : wikiMetadata(text);
					entries.push({ path: p, name: child.name, kind: kindOf(p, text !== undefined), size: info.size, modified: info.mtimeMs, tags: metadata.tags, title: "title" in metadata ? metadata.title : undefined });
				} catch { limited = true; if (!counted && !child.isDirectory()) status.total++; if (child.isDirectory()) status.totalIsLowerBound = true; status.issues.push({ path: p, size, reason: "unreadable", subtree: child.isDirectory() }); }
			}
		};
		await walk("", 0);
		const paths = entries.map(e => e.path), references = new Map<string, ReturnType<typeof wikiReferences>>(), backlinks = new Map<string, WikiDocument["backlinks"]>();
		for (const [source, body] of texts) {
			const refs = wikiReferences(body); references.set(source, refs);
			for (const ref of refs) {
				const target = resolveWikiLink(source, ref.target, paths);
				if (!target || target === source) continue;
				const links = backlinks.get(target) ?? [];
				links.push({ path: source, snippet: ref.snippet, line: ref.line }); backlinks.set(target, links);
			}
			// Let foreground document requests run between files.
			await new Promise<void>(resolve => setImmediate(resolve));
		}
		return { at: Date.now(), entries, texts, limited, status, references, backlinks };
	}
	async directory(cwd: string, path: string, offset = 0): Promise<WikiDirectory> {
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error("Invalid directory offset");
		const children = (await readdir(wikiPath(cwd, path), { withFileTypes: true })).filter(e => !IGNORED.has(e.name));
		children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
		const known = new Map(this.cache.get(this.key(cwd))?.entries.map(e => [e.path, e]));
		const entries: WikiEntry[] = [];
		for (const child of children.slice(offset, offset + 500)) {
			const p = path ? `${path}/${child.name}` : child.name;
			try {
				const absolute = wikiPath(cwd, p);
				if (realpathSync(absolute) === realpathSync(this.dataDir)) continue;
				const info = await stat(absolute);
				entries.push(known.get(p) ?? { path: p, name: child.name, kind: info.isDirectory() ? "directory" : kindOf(p, false), size: info.size, modified: info.mtimeMs, tags: [], symlink: child.isSymbolicLink() });
			} catch { /* Unreadable or outside-workspace symlinks are omitted. */ }
		}
		return { path, entries, ...(offset + 500 < children.length ? { nextOffset: offset + 500 } : {}) };
	}
	async state(cwd: string, fresh = false): Promise<WikiState> {
		const index = await this.index(cwd, fresh), counts = new Map<string, number>();
		for (const entry of index.entries) for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
		return { entries: index.entries, index: index.status, tags: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), revisions: this.history(cwd).reverse().map(({ blobs: _blobs, ...r }) => r), running: this.busy(cwd), limited: index.limited };
	}
	async document(cwd: string, path: string): Promise<WikiDocument> {
		return { ...await this.documentContent(cwd, path), ...await this.documentReferences(cwd, path) };
	}
	async documentReferences(cwd: string, path: string): Promise<WikiDocumentReferences> {
		wikiPath(cwd, path);
		return { backlinks: (await this.index(cwd)).backlinks.get(path) ?? [] };
	}
	async documentContent(cwd: string, path: string): Promise<WikiDocumentContent> {
		const abs = wikiPath(cwd, path), info = statSync(abs), size = info.size;
		if (!info.isFile()) throw new Error("Not a file");
		const data = size <= MAX_FILE ? readFileSync(abs) : undefined;
		const text = data && !/\.pdf$/i.test(path) && previewKind(path) !== "image" && looksLikeText(data) ? decodeText(data) : undefined;
		const metadata = wikiMetadata(text ?? "");
		return { entry: { path, name: basename(path), size, modified: info.mtimeMs, kind: kindOf(path, text !== undefined), tags: metadata.tags, title: metadata.title }, text, version: data ? hash(data) : "", editable: text !== undefined && Buffer.from(text).equals(data!) };
	}
	async search(cwd: string, query: string): Promise<{ results: WikiSearchResult[]; limited: boolean }> {
		const index = await this.index(cwd), q = query.trim().toLocaleLowerCase().slice(0, 200);
		if (!q) return { results: [], limited: index.limited };
		const results: WikiSearchResult[] = []; let limited = index.limited, pdfs = 0;
		for (const entry of index.entries) {
			if (entry.kind === "directory") continue;
			if (results.length >= 100) { limited = true; break; }
			const body = index.texts.get(entry.path);
			const lines = body?.split(/\r?\n/) ?? [];
			let matches = 0;
			for (let line = 0; line < lines.length && matches < 3; line++) {
				const at = lines[line].toLocaleLowerCase().indexOf(q); if (at < 0) continue;
				results.push({ path: entry.path, kind: entry.kind, line: line + 1, snippet: lines[line].slice(Math.max(0, at - 65), at + q.length + 100) }); matches++;
			}
			if (!matches && entry.path.toLocaleLowerCase().includes(q)) { results.push({ path: entry.path, kind: entry.kind, line: 1, snippet: lines.find(l => l.trim())?.slice(0, 160) ?? entry.name }); matches++; }
			if (entry.kind === "pdf" && !matches) {
				if (++pdfs > 8 || entry.size > 20 * 1024 * 1024) { limited = true; continue; }
				try {
					const pages = await readWikiPdf(wikiPath(cwd, entry.path));
					for (let i = 0; i < pages.length; i++) { const at = pages[i].toLocaleLowerCase().indexOf(q); if (at >= 0) { results.push({ path: entry.path, kind: "pdf", line: 1, page: i + 1, snippet: pages[i].slice(Math.max(0, at - 65), at + q.length + 100) }); break; } }
				} catch { limited = true; }
			}
		}
		return { results: results.slice(0, 100), limited };
	}
	private async snapshot(cwd: string): Promise<Snapshot> {
		// Undo needs fresh bytes, not Markdown metadata, backlinks or a cached index.
		// Walk independently so an in-flight search/index cannot hold up sending.
		const files = new Map<string, Buffer>(), skipped: string[] = [];
		const dataRoot = realpathSync(this.dataDir);
		let size = 0, visited = 0, limited = false;
		const skip = (path: string) => { skipped.push(path || "."); limited = true; };
		const walk = async (path: string, depth: number): Promise<void> => {
			if (depth > 32) { skip(path); return; }
			let children;
			try { children = await readdir(wikiPath(cwd, path), { withFileTypes: true }); }
			catch { skip(path); return; }
			children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
			for (const child of children) {
				if (IGNORED.has(child.name) || child.isDirectory() && skipTraversalDirectory(path, child.name)) continue;
				if (visited++ >= 20000) { skip(path); break; }
				const p = path ? `${path}/${child.name}` : child.name;
				try {
					if (child.isSymbolicLink()) { skipped.push(p); continue; }
					const absolute = wikiPath(cwd, p);
					if (realpathSync(absolute) === dataRoot) continue;
					const info = lstatSync(absolute);
					if (info.isSymbolicLink()) { skipped.push(p); continue; }
					if (info.isDirectory()) { await walk(p, depth + 1); continue; }
					if (!info.isFile()) continue;
					if (info.size > MAX_FILE || size + info.size > MAX_SNAPSHOT) { skip(p); continue; }
					const data = await readFile(absolute);
					if (data.length > MAX_FILE || size + data.length > MAX_SNAPSHOT) { skip(p); continue; }
					files.set(p, data); size += data.length;
				} catch { skip(p); }
			}
		};
		await walk("", 0);
		return { files, skipped, limited };
	}
	private record(cwd: string, before: Snapshot, after: Snapshot, author: "pi" | "user", title: string, attribution: RevisionAttribution = {}) {
		const blobs: StoredRevision["blobs"] = {}, changes: WikiChange[] = [], skipped = [...new Set([...before.skipped, ...after.skipped])];
		const put = (data: Buffer | undefined) => { if (!data) return null; const id = hash(data); writeFileSync(join(this.folder(cwd), "blobs", id), data, { mode: 0o600 }); return id; };
		for (const path of new Set([...before.files.keys(), ...after.files.keys()])) {
			if (skipped.includes(path)) continue;
			const a = before.files.get(path), b = after.files.get(path);
			if ((!a && before.limited) || (!b && existsSync(wikiPath(cwd, path)))) { skipped.push(path); continue; }
			if (a?.equals(b ?? Buffer.alloc(0)) && b !== undefined) continue;
			const binary = /\.pdf$/i.test(path) || previewKind(path) === "image" || !!((a && !looksLikeText(a)) || (b && !looksLikeText(b)));
			const old = a ? decodeText(a) : null, next = b ? decodeText(b) : null;
			const oldLines = new Set(old?.split("\n") ?? []), newLines = new Set(next?.split("\n") ?? []);
			changes.push({ path, before: binary ? null : old?.slice(0, 4000) ?? null, after: binary ? null : next?.slice(0, 4000) ?? null, truncated: (old?.length ?? 0) > 4000 || (next?.length ?? 0) > 4000, binary, undone: false, additions: [...newLines].filter(l => !oldLines.has(l)).length, deletions: [...oldLines].filter(l => !newLines.has(l)).length });
			blobs[path] = { before: put(a), after: put(b) };
		}
		if (changes.length || skipped.length) this.persist(cwd, [...this.history(cwd), { id: randomUUID(), at: Date.now(), author, ...attribution, title: title.slice(0, 300), changes, blobs, skipped }]);
		this.invalidate(cwd);
	}
	async begin(cwd: string): Promise<Snapshot> {
		const key = this.key(cwd); if (this.busy(cwd)) throw new Error("Wait for the current Wiki request to finish");
		this.active.add(key);
		try { return await this.snapshot(cwd); } catch (e) { this.active.delete(key); throw e; }
	}
	async finish(cwd: string, before: Snapshot, title: string, attribution: RevisionAttribution = {}) {
		try { this.record(cwd, before, await this.snapshot(cwd), "pi", title, attribution); } finally { this.active.delete(this.key(cwd)); }
	}
	cancel(cwd: string) { this.active.delete(this.key(cwd)); }
	write(cwd: string, path: string, text: string, version: string) {
		if (this.busy(cwd)) throw new Error("Wait for the current Wiki request to finish");
		const abs = wikiPath(cwd, path), data = readFileSync(abs), next = Buffer.from(text);
		if (data.length > MAX_FILE || next.length > MAX_FILE || !looksLikeText(data) || !Buffer.from(decodeText(data)).equals(data)) throw new Error("File is read-only");
		if (hash(data) !== version) throw new WikiConflictError("File changed on disk; reload before saving");
		writeFileSync(abs, next);
		this.record(cwd, { files: new Map([[path, data]]), skipped: [] }, { files: new Map([[path, next]]), skipped: [] }, "user", path);
	}
	change(cwd: string, id: string, path: string): WikiChange {
		const revision = this.history(cwd).find(r => r.id === id), change = revision?.changes.find(c => c.path === path);
		if (!revision || !change) throw new Error("Change record not found");
		const blobs = revision.blobs[path];
		return { ...change, before: !change.binary && blobs.before ? decodeText(readFileSync(join(this.folder(cwd), "blobs", blobs.before))) : null, after: !change.binary && blobs.after ? decodeText(readFileSync(join(this.folder(cwd), "blobs", blobs.after))) : null, truncated: false };
	}
	restore(cwd: string, id: string, undo: boolean, path?: string) {
		if (this.busy(cwd)) throw new Error("Wait for the current Wiki request to finish");
		const records = this.history(cwd), revision = records.find(r => r.id === id);
		if (!revision) throw new Error("Change record not found");
		const changes = revision.changes.filter(c => (!path || c.path === path) && c.undone !== undo);
		const writes = changes.map(c => {
			const abs = wikiPath(cwd, c.path), blob = revision.blobs[c.path];
			const current = existsSync(abs) ? readFileSync(abs) : null;
			if ((current ? hash(current) : null) !== (undo ? blob.after : blob.before)) throw new Error(`File changed since this request: ${c.path}`);
			const target = undo ? blob.before : blob.after;
			return { abs, current, next: target ? readFileSync(join(this.folder(cwd), "blobs", target)) : null, c };
		});
		const done: typeof writes = [];
		try {
			for (const w of writes) { if (w.next === null) rmSync(w.abs); else { mkdirSync(dirname(w.abs), { recursive: true }); writeFileSync(w.abs, w.next); } done.push(w); }
			for (const w of writes) w.c.undone = undo;
			this.persist(cwd, records);
		} catch (error) {
			for (const w of done.reverse()) { if (w.current === null) rmSync(w.abs, { force: true }); else writeFileSync(w.abs, w.current); }
			throw error;
		} finally { this.invalidate(cwd); }
	}
}
