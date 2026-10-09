import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiService, WikiConflictError, wikiPath } from "../../server/wiki-service.js";
import { wikiMetadata, resolveWikiLink, wikiReferences, wikiLinkIndex } from "../../server/wiki-links.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-wiki-unit-")); roots.push(root);
	const cwd = join(root, "workspace"); mkdirSync(cwd);
	const service = new WikiService(join(root, "history"));
	writeFileSync(join(cwd, "index.md"), "---\ntags: [knowledge, 中文]\n---\n# Welcome\n\nSee [[notes]] and [code](main.ts).\n");
	writeFileSync(join(cwd, "notes.md"), "# Notes\n\n#knowledge searchable text\n");
	writeFileSync(join(cwd, "main.ts"), "const limit = 2;\n");
	return { root, cwd, service };
}
describe("Wiki workspace", () => {
	it("creates empty files exclusively and records undo/redo without overwriting", async () => {
		const { cwd, service } = fixture();
		mkdirSync(join(cwd, "docs"));
		expect(service.createFile(cwd, "docs\\中文.md")).toEqual({ path: "docs/中文.md" });
		expect(readFileSync(join(cwd, "docs/中文.md"), "utf8")).toBe("");
		expect(() => service.createFile(cwd, "docs/中文.md")).toThrow();
		expect(() => service.createFile(cwd, "notes.md")).toThrow();
		expect(readFileSync(join(cwd, "notes.md"), "utf8")).toContain("# Notes");
		const state = await service.state(cwd);
		expect(state.entries.some(entry => entry.path === "docs/中文.md")).toBe(true);
		const revision = state.revisions[0];
		expect(revision.changes[0]).toMatchObject({ path: "docs/中文.md", before: null, after: "" });
		service.restore(cwd, revision.id, true);
		expect(existsSync(join(cwd, "docs/中文.md"))).toBe(false);
		service.restore(cwd, revision.id, false);
		expect(readFileSync(join(cwd, "docs/中文.md"), "utf8")).toBe("");
	});
	it("rejects unsafe creation paths, absent parents and external symlinks", async () => {
		const { cwd, root, service } = fixture();
		for (const path of ["", "../outside.md", "/absolute.md", "C:\\outside.md", "missing/note.md", "con.txt", "note.", "a\0b", "a//b"]) expect(() => service.createFile(cwd, path)).toThrow();
		mkdirSync(join(root, "outside"));
		symlinkSync(join(root, "outside"), join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
		expect(() => service.createFile(cwd, "linked/new.md")).toThrow(/outside/);
		expect(existsSync(join(root, "outside/new.md"))).toBe(false);
		await service.begin(cwd);
		expect(() => service.createFile(cwd, "busy.md")).toThrow(/finish/);
		service.cancel(cwd);
	});
	it("persists request/reply attribution only for actual Pi changes", async () => {
		const { cwd, root, service } = fixture();
		const before = await service.begin(cwd);
		writeFileSync(join(cwd, "notes.md"), "# Changed\n");
		const attribution = { conversationId: "wiki-session", requestId: "request", assistantTimestamp: 1234 };
		await service.finish(cwd, before, "Edit notes", attribution);
		const reloaded = new WikiService(join(root, "history"));
		expect((await reloaded.state(cwd)).revisions[0]).toMatchObject(attribution);
		const unchanged = await service.begin(cwd);
		await service.finish(cwd, unchanged, "hello", { ...attribution, requestId: "hello" });
		expect((await service.state(cwd)).revisions).toHaveLength(1);
		const doc = await service.documentContent(cwd, "notes.md");
		writeFileSync(join(cwd, "notes.md"), "External");
		expect(() => service.write(cwd, "notes.md", "Mine", doc.version)).toThrow(WikiConflictError);
		expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("External");
	});

	it("background indexing and undo snapshots skip worktree copies and Python dependencies", async () => {
		const { cwd, service } = fixture();
		const ignored = [".claude/worktrees/copy", ".venv/lib", "services/runner/.venv/lib", "src/__pycache__", ".pytest_cache"];
		for (const path of ignored) {
			mkdirSync(join(cwd, path), { recursive: true });
			writeFileSync(join(cwd, path, "oversized.md"), Buffer.alloc(2 * 1024 * 1024 + 1));
		}
		mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
		writeFileSync(join(cwd, ".claude/skills/guide.md"), "# Keep workspace skills");
		writeFileSync(join(cwd, ".claude/worktrees/copy/note.md"), "# Copy content");
		const index = await service.index(cwd);
		expect(index.status).toMatchObject({ indexed: 4, total: 4, totalIsLowerBound: false, issues: [] });
		expect(index.texts.has(".claude/skills/guide.md")).toBe(true);
		const snapshot = await service.begin(cwd);
		expect(snapshot.files.size).toBe(4);
		expect(snapshot.skipped).toEqual([]);
		service.cancel(cwd);
		// Exclusion is only for automatic traversal; explicit browsing still works.
		expect((await service.directory(cwd, ".claude")).entries.some(e => e.path === ".claude/worktrees")).toBe(true);
		expect((await service.documentContent(cwd, ".claude/worktrees/copy/note.md")).text).toBe("# Copy content");
		expect((await service.index(join(cwd, ".claude/worktrees/copy"))).texts.has("note.md")).toBe(true);
	});

	it("snapshot traversal excludes history, symlinks and oversized files", async () => {
		const { cwd, root } = fixture();
		const data = join(cwd, "history");
		const service = new WikiService(data);
		writeFileSync(join(data, "private.txt"), "history must not snapshot itself");
		writeFileSync(join(cwd, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
		writeFileSync(join(root, "outside.txt"), "outside");
		symlinkSync(join(root, "outside.txt"), join(cwd, "link.txt"));
		const snapshot = await service.begin(cwd);
		expect(snapshot.files.has("history/private.txt")).toBe(false);
		expect(snapshot.files.has("link.txt")).toBe(false);
		expect(snapshot.files.has("large.bin")).toBe(false);
		expect(snapshot.files.has("index.md")).toBe(true);
		expect(snapshot.skipped).toEqual(expect.arrayContaining(["large.bin", "link.txt"]));
		service.cancel(cwd);
	});
	it("captures fresh undo bytes without building a Markdown index before sending", async () => {
		const { cwd, service } = fixture();
		await service.index(cwd);
		writeFileSync(join(cwd, "new.md"), "new before request");
		const index = vi.spyOn(service, "index").mockRejectedValue(new Error("slow index must not delay prompt"));
		const before = await service.begin(cwd);
		expect(before.files.get("new.md")?.toString()).toBe("new before request");
		writeFileSync(join(cwd, "new.md"), "changed by request");
		await service.finish(cwd, before, "hello");
		expect(index).not.toHaveBeenCalled();
		index.mockRestore();
		const history = await service.state(cwd);
		service.restore(cwd, history.revisions[0].id, true);
		expect(readFileSync(join(cwd, "new.md"), "utf8")).toBe("new before request");
	});

	it("reads editable content without waiting for an index and keeps references separate", async () => {
		const { cwd, service } = fixture();
		const original = service.index.bind(service);
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const index = vi.spyOn(service, "index").mockImplementation(async () => { await gate; return original(cwd); });
		const references = service.documentReferences(cwd, "notes.md");
		const content = await service.documentContent(cwd, "notes.md");
		expect(content.editable).toBe(true);
		expect(content.text).toContain("# Notes");
		expect(index).toHaveBeenCalledTimes(1);
		release();
		expect((await references).backlinks).toHaveLength(1);
	});
	it("coalesces concurrent scans, serves stale cache, and refreshes invalidated references", async () => {
		const { cwd, service } = fixture();
		const [a, b] = await Promise.all([service.index(cwd), service.index(cwd)]);
		expect(a).toBe(b);
		a.at = 0;
		writeFileSync(join(cwd, "notes.md"), "# Changed");
		expect(await service.index(cwd)).toBe(a);
		service.invalidate(cwd);
		writeFileSync(join(cwd, "new.md"), "[[notes]]");
		const fresh = await service.index(cwd, true);
		expect(fresh).not.toBe(a);
		expect((await service.documentReferences(cwd, "notes.md")).backlinks.map(link => link.path)).toEqual(["index.md", "new.md"]);
	});

	it("indexes a large code project without parsing source files as Markdown", async () => {
		const { cwd, service } = fixture();
		// Link-like text in source files used to be parsed and resolved against every path.
		const source = "const doc = '[[notes]] [x](index.md) #tag';\n".repeat(200);
		for (let d = 0; d < 20; d++) { mkdirSync(join(cwd, `src${d}`)); for (let i = 0; i < 100; i++) writeFileSync(join(cwd, `src${d}`, `module${i}.ts`), source); }
		const started = performance.now();
		const state = await service.state(cwd);
		expect(performance.now() - started).toBeLessThan(10000);
		expect(state.entries.find(e => e.path === "src0/module0.ts")).toMatchObject({ kind: "code", tags: [] });
		expect(state.tags.map(t => t.name)).not.toContain("tag");
		expect((await service.documentReferences(cwd, "notes.md")).backlinks.map(link => link.path)).toEqual(["index.md"]);
		expect((await service.search(cwd, "const doc")).results[0].path).toMatch(/^src/);
	}, 30000);

	it("reuses parsed documents across rebuilds and re-parses changed ones", async () => {
		const { cwd, service } = fixture();
		await service.index(cwd);
		writeFileSync(join(cwd, "notes.md"), "# Renamed\n\n#fresh [[index]]\n");
		service.invalidate(cwd);
		const state = await service.state(cwd);
		expect(state.entries.find(e => e.path === "notes.md")).toMatchObject({ title: "Renamed", tags: ["fresh"] });
		expect(state.tags).toContainEqual({ name: "knowledge", count: 1 });
		expect((await service.documentReferences(cwd, "index.md")).backlinks.map(link => link.path)).toEqual(["notes.md"]);
	});

	it("indexes tags, full-text snippets, code references and backlinks", async () => {
		const { cwd, service } = fixture();
		const state = await service.state(cwd);
		expect(state.tags).toContainEqual({ name: "knowledge", count: 2 });
		expect((await service.document(cwd, "notes.md")).backlinks).toEqual([{ path: "index.md", line: 6, snippet: "See [[notes]] and [code](main.ts)." }]);
		expect((await service.document(cwd, "main.ts")).backlinks).toHaveLength(1);
		expect((await service.search(cwd, "searchable")).results[0]).toMatchObject({ path: "notes.md", line: 3 });
	});
	it("records an agent request including creates/deletes and restores individual files and a whole request", async () => {
		const { cwd, service } = fixture();
		const before = await service.begin(cwd);
		writeFileSync(join(cwd, "notes.md"), "changed\n");
		writeFileSync(join(cwd, "new.md"), "created\n");
		rmSync(join(cwd, "main.ts"));
		await service.finish(cwd, before, "change documents");
		const revision = (await service.state(cwd)).revisions[0];
		expect(revision.changes).toHaveLength(3);
		service.restore(cwd, revision.id, true, "notes.md");
		expect(readFileSync(join(cwd, "notes.md"), "utf8")).toContain("# Notes");
		expect(existsSync(join(cwd, "new.md"))).toBe(true);
		service.restore(cwd, revision.id, true);
		expect(existsSync(join(cwd, "new.md"))).toBe(false);
		expect(readFileSync(join(cwd, "main.ts"), "utf8")).toBe("const limit = 2;\n");
		service.restore(cwd, revision.id, false);
		expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("changed\n");
		expect(existsSync(join(cwd, "new.md"))).toBe(true);
		expect(existsSync(join(cwd, "main.ts"))).toBe(false);
	});
	it("preflights every file so one later edit prevents a partial bulk undo", async () => {
		const { cwd, service } = fixture();
		const before = await service.begin(cwd);
		writeFileSync(join(cwd, "notes.md"), "first change"); writeFileSync(join(cwd, "main.ts"), "second change");
		await service.finish(cwd, before, "batch");
		const revision = (await service.state(cwd)).revisions[0];
		writeFileSync(join(cwd, "notes.md"), "later external change");
		expect(() => service.restore(cwd, revision.id, true)).toThrow("File changed");
		expect(readFileSync(join(cwd, "main.ts"), "utf8")).toBe("second change");
	});
	it("persists history across restarts and uses optimistic versions for manual saves", async () => {
		const { cwd, root, service } = fixture();
		const doc = await service.document(cwd, "notes.md");
		service.write(cwd, "notes.md", "manual edit", doc.version);
		expect(() => service.write(cwd, "notes.md", "stale edit", doc.version)).toThrow("File changed");
		const restart = new WikiService(join(root, "history"));
		const revision = (await restart.state(cwd)).revisions[0];
		expect(revision.author).toBe("user"); restart.restore(cwd, revision.id, true);
		expect(readFileSync(join(cwd, "notes.md"), "utf8")).toContain("# Notes");
	});
	it("pages large directories without losing entries and keeps non-indexed folders browsable", async () => {
		const { cwd, service } = fixture();
		mkdirSync(join(cwd, "many"));
		for (let i = 0; i < 505; i++) writeFileSync(join(cwd, "many", `${i}.txt`), "same");
		const first = await service.directory(cwd, "many"), second = await service.directory(cwd, "many", first.nextOffset);
		expect(first.entries).toHaveLength(500); expect(second.entries).toHaveLength(5);
		expect(new Set([...first.entries, ...second.entries].map(e => e.path)).size).toBe(505);
		expect(second.nextOffset).toBeUndefined();
	});
	it("refuses traversal, symlink escape and dangling link writes", async () => {
		const { cwd, root, service } = fixture();
		writeFileSync(join(root, "secret"), "outside");
		expect(() => wikiPath(cwd, "../secret")).toThrow("outside");
		symlinkSync(join(root, "secret"), join(cwd, "escape"));
		await expect(service.document(cwd, "escape")).rejects.toThrow("outside");
		symlinkSync(join(root, "missing"), join(cwd, "dangling"));
		expect(() => wikiPath(cwd, "dangling")).toThrow("symbolic");
	});
	it("preserves binary bytes and refuses concurrent wiki mutations", async () => {
		const { cwd, service } = fixture();
		writeFileSync(join(cwd, "data.bin"), Buffer.from([0, 255, 4]));
		const before = await service.begin(cwd);
		await expect(service.begin(cwd)).rejects.toThrow("Wait");
		expect(() => service.write(cwd, "notes.md", "change", "version")).toThrow("Wait");
		writeFileSync(join(cwd, "data.bin"), Buffer.from([0, 254, 5]));
		await service.finish(cwd, before, "binary");
		const revision = (await service.state(cwd)).revisions[0];
		expect(revision.changes[0].binary).toBe(true);
		service.restore(cwd, revision.id, true);
		expect(readFileSync(join(cwd, "data.bin"))).toEqual(Buffer.from([0, 255, 4]));
	});
});
describe("Wiki metadata and link resolution", () => {
	it("ignores tags in fences and resolves adjacent files before globally unique names", () => {
		expect(wikiMetadata('---\ntags:\n  - 中文\n  - test\n---\n# Title\n#inline\n```py\n#hidden\n```').tags).toEqual(["中文", "test", "inline"]);
		const files = ["a/notes.md", "b/notes.md", "unique.md"];
		expect(resolveWikiLink("a/index.md", "notes#section", files)).toBe("a/notes.md");
		expect(resolveWikiLink("index.md", "notes", files)).toBeUndefined();
		expect(resolveWikiLink("a/index.md", "unique", files)).toBe("unique.md");
		const index = wikiLinkIndex(files);
		for (const [source, target] of [["a/index.md", "notes#section"], ["index.md", "notes"], ["a/index.md", "unique"], ["a/x.md", "../b/notes.md"]]) expect(resolveWikiLink(source, target, index)).toBe(resolveWikiLink(source, target, files));
		expect(wikiReferences('`[[not a link]]`\n[[real]]')).toHaveLength(1);
		expect(wikiReferences('See `src/main.ts`')[0].target).toBe('src/main.ts');
	});
});

describe("Wiki visible request", () => {
	it("limits tag scope to matching files and preserves explicit references", async () => {
		const { wikiPrompt } = await import("../../web/src/wiki-document.js");
		const text = wikiPrompt("Update", "outside.md", "", ["explicit.md"], "work", [{ path: "inside.md", name: "inside.md", kind: "document", tags: ["work"], size: 10, modified: 0 }], false, false, { scope: "Scope", selection: "Selection", documentsOnly: "Documents only", skip: "Explain skipped files" });
		expect(text).toContain('"inside.md"'); expect(text).toContain('"explicit.md"'); expect(text).not.toContain('"outside.md"');
	});
});

describe("Wiki reading metadata", () => {
	it("only removes the first matching H1, preserving different headings and source", () => {
		const matching = wikiMetadata('---\ntitle: "Same title"\n---\nIntro\n\n# Same title\n\n# Same title\n');
		expect(matching.title).toBe("Same title");
		expect(matching.body.match(/# Same title/g)).toHaveLength(2);
		expect(matching.readingBody.match(/# Same title/g)).toHaveLength(1);
		const different = wikiMetadata('---\ntitle: Page title\n---\n# Body title\n');
		expect(different.title).toBe("Page title");
		expect(different.readingBody).toContain("# Body title");
		expect(wikiMetadata('# Plain title\n\nBody').readingBody.trim()).toBe("Body");
	});
	it("filters hex colors, inline code, fenced code, indented code and link destinations", () => {
		const text = '---\ntags: [Work, ff475040, 中文]\n---\n#visible #fff #abcd #AABBCC #11223344 #face-to-face\n\n`#inline` ``a ` #nested``\n\n~~~js\n#fenced\n~~~~\n\n    #indented\n\n[label](https://example.test/#url)\n\n[ref]: https://example.test/#definition\n';
		expect(wikiMetadata(text).tags).toEqual(["Work", "中文", "visible", "face-to-face"]);
		expect(wikiMetadata('```\n#unclosed\n').tags).toEqual([]);
		expect(wikiMetadata('word**#adjacent** \\#escaped [#label](https://example.test)').tags).toEqual([]);
	});
	it("estimates mixed Chinese and English reading time without fenced code", () => {
		expect(wikiMetadata('中'.repeat(400) + '\n\n' + 'word '.repeat(200) + '\n```\n' + 'ignored '.repeat(1000) + '\n```').minutes).toBe(2);
	});
	it("reports file and byte-budget limits with real paths and sizes", async () => {
		const { cwd, service } = fixture();
		writeFileSync(join(cwd, "a-too-large.md"), Buffer.alloc(2 * 1024 * 1024 + 1));
		for (let i = 0; i < 32; i++) writeFileSync(join(cwd, `budget-${i}.bin`), Buffer.alloc(2 * 1024 * 1024));
		const state = await service.state(cwd);
		expect(state.index).toMatchObject({ indexed: 32, total: 36, totalIsLowerBound: false });
		expect(state.index?.issues).toContainEqual({ path: "a-too-large.md", size: 2 * 1024 * 1024 + 1, reason: "file-size" });
		expect(state.index?.issues.some(i => i.path === "index.md" && i.reason === "byte-budget")).toBe(true);
	});
	it("marks totals as lower bounds when a subtree cannot be scanned", async () => {
		const { cwd, service } = fixture();
		const deep = Array(34).fill("nested").join("/"); mkdirSync(join(cwd, deep), { recursive: true });
		writeFileSync(join(cwd, deep, "deep.md"), "unscanned");
		const state = await service.state(cwd);
		expect(state.index?.totalIsLowerBound).toBe(true);
		expect(state.index?.issues.some(i => i.reason === "depth-limit" && i.subtree)).toBe(true);
	});
});
