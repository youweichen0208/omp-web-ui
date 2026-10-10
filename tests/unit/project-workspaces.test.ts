import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectWorkspaceStore } from "../../server/project-workspaces.js";
import { workspaceProjects } from "../../web/src/project-workspaces.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-workspaces-")); roots.push(root);
	const file = join(root, "data", "project-workspaces.json");
	return { root, file, store: new ProjectWorkspaceStore(file) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("persistent project workspaces", () => {
	it("keeps older members, permits shared membership, and deletes groups without touching evidence", () => {
		const { root, file, store } = fixture();
		const a = store.apply(0, { kind: "create", name: "  Work  " }).workspaceId;
		const b = store.apply(1, { kind: "create", name: "Personal" }).workspaceId;
		const paths = Array.from({ length: 25 }, (_, i) => join(root, `project-${i}`));
		for (const path of paths) { mkdirSync(path); writeFileSync(join(path, "history.jsonl"), "original"); store.apply(store.read().revision, { kind: "add", id: a, path }); }
		store.apply(store.read().revision, { kind: "add", id: b, path: paths[0] });
		const reopened = new ProjectWorkspaceStore(file);
		expect(reopened.read().workspaces[0].name).toBe("Work");
		expect(workspaceProjects([], reopened.read(), a, "")).toHaveLength(25);
		expect(workspaceProjects([], reopened.read(), a, "project-24").map((p) => p.path)).toEqual([paths[24]]);
		reopened.apply(reopened.read().revision, { kind: "delete", id: a });
		expect(reopened.read().workspaces).toEqual([{ id: b, name: "Personal", paths: [paths[0]] }]);
		for (const path of paths) expect(readFileSync(join(path, "history.jsonl"), "utf8")).toBe("original");
	});
	it("never imports recent projects without explicit workspace membership", () => {
		const recent = [{ path: "/old/project", firstAdded: 1, lastUsed: 2 }];
		expect(workspaceProjects(recent, null, "", "")).toEqual([]);
		expect(workspaceProjects(recent, {revision: 0, workspaces: []}, "", "")).toEqual([]);
		const catalog = {revision: 1, workspaces: [{id: "new", name: "New", paths: []}]};
		expect(workspaceProjects(recent, catalog, "new", "")).toEqual([]);
		expect(workspaceProjects(recent, catalog, "deleted", "")).toEqual([]);
	});

	it("rejects stale writes and invalid input without modifying the stored catalog", () => {
		const { root, file, store } = fixture();
		const id = store.apply(0, { kind: "create", name: "Team" }).workspaceId;
		const before = readFileSync(file, "utf8");
		expect(() => store.apply(0, { kind: "delete", id })).toThrow(/another window/);
		expect(() => store.apply(1, { kind: "create", name: "team" })).toThrow(/already exists/);
		expect(() => store.apply(1, { kind: "rename", id, name: "  " })).toThrow();
		expect(() => store.apply(1, { kind: "add", id, path: "relative" })).toThrow(/absolute/);
		expect(() => store.apply(1, { kind: "add", id, path: join(root, "missing") })).toThrow();
		expect(() => store.apply(1, { kind: "add", id, path: file })).toThrow(/directory/);
		expect(readFileSync(file, "utf8")).toBe(before);
		store.apply(1, { kind: "rename", id, name: "Engineering" });
		expect(store.read().workspaces[0].name).toBe("Engineering");
	});
	it("retains a corrupt catalog and does not acknowledge a failed write", () => {
		const { root, file, store } = fixture();
		mkdirSync(join(root, "data")); writeFileSync(file, "broken");
		expect(() => store.apply(0, { kind: "create", name: "Team" })).toThrow();
		expect(readFileSync(file, "utf8")).toBe("broken");
		rmSync(file); expect(store.read().revision).toBe(0);
		mkdirSync(file);
		expect(() => store.apply(0, { kind: "create", name: "Team" })).toThrow();
		expect(store.read()).toEqual({ revision: 0, workspaces: [] });
	});
	it("allows removing missing folders and protects returned snapshots from mutation", () => {
		const { root, store } = fixture();
		const id = store.apply(0, { kind: "create", name: "Team" }).workspaceId;
		const path = join(root, "gone"); mkdirSync(path);
		store.apply(1, { kind: "add", id, path }); rmSync(path, { recursive: true });
		store.read().workspaces[0].paths.length = 0;
		expect(store.read().workspaces[0].paths).toEqual([path]);
		store.apply(2, { kind: "remove", id, path });
		expect(store.read().workspaces[0].paths).toEqual([]); expect(existsSync(path)).toBe(false);
	});
});
