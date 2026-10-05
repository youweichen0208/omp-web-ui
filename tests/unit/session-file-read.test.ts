import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, renameSync, statSync, utimesSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionBranchCounts, SessionTailValidator } from "../../server/session-file-read.js";
vi.mock("node:fs/promises", { spy: true });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });
function fixture(count = 1) {
	const root = mkdtempSync(join(tmpdir(), "pi-tail-")); roots.push(root);
	const path = join(root, "session.jsonl"), sm = SessionManager.inMemory(root);
	for (let i = 0; i < count; i++) sm.appendMessage({ role: "user", content: "x".repeat(2300), timestamp: i });
	writeFileSync(path, [sm.getHeader(), ...sm.getEntries()].map(e => JSON.stringify(e)).join("\n") + "\n");
	const append = () => { const id = sm.appendMessage({ role: "user", content: "new result", timestamp: Date.now() }); const line = JSON.stringify(sm.getEntry(id)) + "\n"; appendFileSync(path, line); return line; };
	return { path, sm, append };
}
test("5000-entry file: own writes read only the new tail and never scan native history again", () => {
	const f = fixture(5000); expect(statSync(f.path).size).toBeGreaterThan(11_000_000);
	const validator = new SessionTailValidator(f.path, f.sm);
	vi.spyOn(f.sm, "getEntries").mockImplementation(() => { throw Error("must not rescan history"); });
	const start = performance.now(); let bytes = 0;
	for (let i = 0; i < 30; i++) { bytes += Buffer.byteLength(f.append()); expect(validator.check(f.sm)).toBe(true); }
	expect(validator.bytesRead).toBe(bytes); expect(performance.now() - start).toBeLessThan(200);
});
for (const kind of ["append", "partial", "truncate", "replace", "same-size", "duplicate"] as const) test(`detects external ${kind}`, () => {
	const f = fixture(), guard = new SessionTailValidator(f.path, f.sm);
	if (kind === "append") appendFileSync(f.path, JSON.stringify({ id: "external", type: "custom" }) + "\n");
	if (kind === "partial") appendFileSync(f.path, '{"id":');
	if (kind === "truncate") writeFileSync(f.path, "");
	if (kind === "replace") { renameSync(f.path, f.path + ".old"); writeFileSync(f.path, readFileSync(f.path + ".old")); }
	if (kind === "same-size") { const text = readFileSync(f.path, "utf8"); writeFileSync(f.path, text.replace("xxx", "yyy")); utimesSync(f.path, new Date(), new Date(Date.now() + 1000)); }
	if (kind === "duplicate") appendFileSync(f.path, JSON.stringify(f.sm.getEntries()[0]) + "\n");
	expect(guard.check(f.sm)).toBe(false);
});
test("handles native delayed first flush without falsely reporting an external write", () => {
	const f = fixture(); rmSync(f.path);
	const guard = new SessionTailValidator(f.path, f.sm);
	expect(guard.check(f.sm)).toBe(true);
	writeFileSync(f.path, [f.sm.getHeader(), ...f.sm.getEntries()].map(e => JSON.stringify(e)).join("\n") + "\n");
	expect(guard.check(f.sm)).toBe(true); f.append(); expect(guard.check(f.sm)).toBe(true);
});
test("listing old, empty and branched files is read-only and uses a file-state cache", async () => {
	const f = fixture(), cache = new SessionBranchCounts();
	const old = join(f.path + ".old"), empty = f.path + ".empty";
	writeFileSync(old, '{"type":"session","version":1,"id":"old","timestamp":"2020-01-01","cwd":"/tmp"}\n'); writeFileSync(empty, "");
	const baseline = [old, empty].map(p => ({ bytes: readFileSync(p), stat: statSync(p) }));
	await cache.get(old); await cache.get(empty);
	for (const [i, path] of [old, empty].entries()) { expect(readFileSync(path)).toEqual(baseline[i].bytes); expect(statSync(path).mtimeMs).toBe(baseline[i].stat.mtimeMs); }
	const parent = f.sm.getEntries()[0].id;
	f.append(); f.sm.branch(parent); f.append();
	expect(await cache.get(f.path)).toBe(1);
	const reads = vi.mocked(fs.readFile).mock.calls.length;
	expect(await cache.get(f.path)).toBe(1); expect(vi.mocked(fs.readFile).mock.calls.length).toBe(reads);
	f.append(); await cache.get(f.path); expect(vi.mocked(fs.readFile).mock.calls.length).toBe(reads + 1);
});
