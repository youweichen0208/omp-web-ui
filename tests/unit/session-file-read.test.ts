import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, renameSync, statSync, utimesSync } from "node:fs";
import * as fs from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionBranchCounts, SessionTailValidator } from "../../server/session-file-read.js";
vi.mock("node:fs/promises", { spy: true });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function fixture(count = 1) {
	const root = mkdtempSync(join(tmpdir(), "pi-tail-")); roots.push(root);
	const path = join(root, "session.jsonl"), sm = SessionManager.inMemory(root);
	for (let i = 0; i < count; i++) sm.appendMessage({ role: "user", content: "x".repeat(2300), timestamp: i });
	writeFileSync(path, [sm.getHeader(), ...sm.getEntries()].map(e => JSON.stringify(e)).join("\n") + "\n");
	const append = () => { const id = sm.appendMessage({ role: "user", content: "new result", timestamp: Date.now() }); const line = JSON.stringify(sm.getEntry(id)) + "\n"; appendFileSync(path, line); return line; };
	return { path, sm, append };
}
test("5000-entry file: own writes read only the new tail and never scan native history again", async () => {
	const f = fixture(5000); expect(statSync(f.path).size).toBeGreaterThan(11_000_000);
	const validator = new SessionTailValidator(f.path, f.sm);
	await validator.ready();
	const baselineBytes = validator.bytesRead;
	expect(baselineBytes).toBe(statSync(f.path).size);
	vi.spyOn(f.sm, "getEntries").mockImplementation(() => { throw Error("must not rescan history"); });
	const start = performance.now(); let bytes = 0;
	for (let i = 0; i < 30; i++) { bytes += Buffer.byteLength(f.append()); expect(await validator.verify(f.sm)).toBe(true); }
	expect(validator.bytesRead - baselineBytes).toBe(bytes); expect(performance.now() - start).toBeLessThan(200);
});
for (const kind of ["append", "partial", "truncate", "replace", "same-size", "duplicate"] as const) test(`detects external ${kind}`, async () => {
	const f = fixture(), guard = new SessionTailValidator(f.path, f.sm);
	await guard.ready();
	if (kind === "append") appendFileSync(f.path, JSON.stringify({ id: "external", type: "custom" }) + "\n");
	if (kind === "partial") appendFileSync(f.path, '{"id":');
	if (kind === "truncate") writeFileSync(f.path, "");
	if (kind === "replace") { renameSync(f.path, f.path + ".old"); writeFileSync(f.path, readFileSync(f.path + ".old")); }
	if (kind === "same-size") { const text = readFileSync(f.path, "utf8"); writeFileSync(f.path, text.replace("xxx", "yyy")); utimesSync(f.path, new Date(), new Date(Date.now() + 1000)); }
	if (kind === "duplicate") appendFileSync(f.path, JSON.stringify(f.sm.getEntries()[0]) + "\n");
	expect(await guard.verify(f.sm)).toBe(false);
});
test("handles native delayed first flush without falsely reporting an external write", async () => {
	const f = fixture(); rmSync(f.path);
	const guard = new SessionTailValidator(f.path, f.sm);
	expect(await guard.verify(f.sm)).toBe(true);
	writeFileSync(f.path, [f.sm.getHeader(), ...f.sm.getEntries()].map(e => JSON.stringify(e)).join("\n") + "\n");
	expect(await guard.verify(f.sm)).toBe(true); f.append(); expect(await guard.verify(f.sm)).toBe(true);
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

test("metadata-only changes preserve a verified session", async () => {
	const f = fixture(3), guard = new SessionTailValidator(f.path, f.sm);
	await guard.ready();
	utimesSync(f.path, new Date(), new Date(Date.now() + 10000));
	expect(await guard.verify(f.sm)).toBe(true);
	f.append(); expect(await guard.verify(f.sm)).toBe(true);
});
for (const kind of ["append", "same-size"] as const) test(`rejects external ${kind} before binding, permanently`, async () => {
	const f = fixture(3), original = readFileSync(f.path);
	if (kind === "append") appendFileSync(f.path, JSON.stringify({ id: "external", type: "custom" }) + "\n");
	else writeFileSync(f.path, original.toString().replace("xxx", "yyy"));
	const guard = new SessionTailValidator(f.path, f.sm);
	expect(await guard.verify(f.sm)).toBe(false);
	writeFileSync(f.path, original);
	expect(await guard.verify(f.sm)).toBe(false);
});
test("equal-size edits to an earlier record are detected even if the last record matches", async () => {
	const f = fixture(3), guard = new SessionTailValidator(f.path, f.sm);
	await guard.ready();
	writeFileSync(f.path, readFileSync(f.path, "utf8").replace("xxx", "yyy"));
	utimesSync(f.path, new Date(), new Date(Date.now() + 10000));
	expect(await guard.verify(f.sm)).toBe(false);
});
test("binding accepts JSON whitespace, CRLF, Unicode across chunks and header-only files", async () => {
	for (const count of [0, 40]) {
		const f = fixture(count);
		if (count) f.sm.appendMessage({ role: "user", content: "中文".repeat(40000), timestamp: 1 });
		writeFileSync(f.path, [f.sm.getHeader(), ...f.sm.getEntries()].map(e => "  " + JSON.stringify(e) + "  ").join("\r\n") + "\r\n");
		const guard = new SessionTailValidator(f.path, f.sm);
		expect(await guard.verify(f.sm)).toBe(true);
		utimesSync(f.path, new Date(), new Date(Date.now() + 10000));
		expect(await guard.verify(f.sm)).toBe(true);
		f.append(); expect(await guard.verify(f.sm)).toBe(true);
	}
});
test("batch branch reads use eight workers and retain order despite reversed completion", async () => {
	const cache = new SessionBranchCounts();
	const pending = new Map<string, (value: number | undefined) => void>();
	let active = 0, peak = 0;
	vi.spyOn(cache, "get").mockImplementation(path => {
		active++; peak = Math.max(peak, active);
		return new Promise(resolve => pending.set(path, value => { active--; resolve(value); }));
	});
	const result = cache.getMany(Array.from({ length: 20 }, (_, i) => String(i)));
	while (pending.size) {
		const batch = [...pending.entries()].reverse(); pending.clear();
		for (const [path, finish] of batch) finish(path === "3" ? undefined : Number(path));
		await Promise.resolve(); await Promise.resolve();
	}
	expect(await result).toEqual(Array.from({ length: 20 }, (_, i) => i === 3 ? undefined : i));
	expect(peak).toBe(8);
	expect(await cache.getMany([])).toEqual([]);
});

test("rejects unknown records appended while baseline reading yields", async () => {
	const f = fixture(5000), guard = new SessionTailValidator(f.path, f.sm);
	await new Promise(resolve => setImmediate(resolve));
	appendFileSync(f.path, JSON.stringify({ id: "outside" }) + "\n");
	expect(await guard.ready()).toBe(false);
});
test("50 MB baseline yields to other conversations and can be cancelled", async () => {
	const f = fixture(22000);
	let heartbeats = 0;
	const timer = setInterval(() => heartbeats++, 1);
	const guard = new SessionTailValidator(f.path, f.sm);
	expect(guard.check(f.sm)).toBeUndefined();
	expect(await guard.ready()).toBe(true);
	clearInterval(timer);
	expect(heartbeats).toBeGreaterThan(10);
	const changed = vi.fn(), abandoned = new SessionTailValidator(f.path, f.sm, changed);
	abandoned.dispose(); expect(await abandoned.ready()).toBe(false); expect(changed).not.toHaveBeenCalled();
});
test("native appends during metadata verification are accepted", async () => {
	const f = fixture(5000), guard = new SessionTailValidator(f.path, f.sm);
	await guard.ready(); utimesSync(f.path, new Date(), new Date(Date.now() + 10000));
	expect(guard.check(f.sm)).toBeUndefined();
	await new Promise(resolve => setImmediate(resolve)); f.append();
	expect(await guard.ready()).toBe(true);
});
test("batch failures affect only the missing file and cache valid reads", async () => {
	const f = fixture(), cache = new SessionBranchCounts();
	expect(await cache.getMany([f.path, f.path + ".missing"])).toEqual([0, undefined]);
	const reads = vi.mocked(fs.readFile).mock.calls.length;
	expect(await cache.getMany([f.path])).toEqual([0]);
	expect(vi.mocked(fs.readFile).mock.calls.length).toBe(reads);
});

test("large single-record parsing runs in a worker without monopolizing the main loop", async () => {
	const f = fixture(0);
	f.sm.appendMessage({ role: "user", content: "large record ".repeat(700000), timestamp: 1 });
	writeFileSync(f.path, [f.sm.getHeader(), ...f.sm.getEntries()].map(e => JSON.stringify(e)).join("\n") + "\n");
	let ticks = 0;
	const timer = setInterval(() => ticks++, 1);
	try {
		const guard = new SessionTailValidator(f.path, f.sm);
		expect(await guard.ready()).toBe(true);
		expect(ticks).toBeGreaterThan(10);
	} finally { clearInterval(timer); }
});
