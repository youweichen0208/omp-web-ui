import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiService, wikiPath } from "../../server/wiki-service.js";
import { wikiMetadata, resolveWikiLink, wikiReferences } from "../../server/wiki-links.js";
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
