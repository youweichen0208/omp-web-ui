import { expect, test } from "vitest";
import { checkComponent, hasNewerStableVersion, type UpdateTarget } from "../../server/component-updates.js";
const target: UpdateTarget = { id: "user:npm:sample", name: "sample", kind: "npm", current: "1.2.3", packageName: "sample", source: "npm:sample" };
test.each([
	["1.2.3", "1.2.4", true], ["1.9.0", "1.10.0", true], ["2.0.0", "1.99.0", false],
	["1.2.3-beta.1", "1.2.3", true], ["1.2.3", "1.3.0-beta.1", false], ["1.2.3+build", "1.2.3", false],
])("compares stable release %s → %s", (current, latest, expected) => expect(hasNewerStableVersion(current, latest)).toBe(expected));
test("npm updates are actionable only for unpinned, unambiguous user packages", async () => {
	const latest = async () => "1.3.0";
	expect(await checkComponent(target, latest)).toMatchObject({ status: "available", canUpdate: true, latest: "1.3.0" });
	expect(await checkComponent({ ...target, kind: "bundled" }, latest)).toMatchObject({ status: "available", canUpdate: false });
	expect(await checkComponent({ ...target, pinned: true }, latest)).toMatchObject({ status: "pinned", canUpdate: false });
	expect(await checkComponent({ ...target, ambiguous: true }, latest)).toMatchObject({ status: "manual", canUpdate: false });
	expect(await checkComponent({ ...target, kind: "local" }, latest)).toMatchObject({ status: "manual", canUpdate: false });
});
test("a failed check does not pretend the package is current", async () => {
	expect(await checkComponent(target, async () => { throw Error("offline"); })).toMatchObject({ status: "error", canUpdate: false, latest: null, error: "offline" });
	expect(await checkComponent({ ...target, current: "dev" }, async () => "1.3.0")).toMatchObject({ status: "unknown", canUpdate: false });
	expect(await checkComponent(target, async () => "1.3.0-beta.1")).toMatchObject({ status: "unknown", canUpdate: false });
});
test("git compares the tracked branch, preserves pinned refs and reports failures", async () => {
	const calls: string[][] = [];
	const git = async (_cwd: string, args: string[]) => { calls.push(args); return args.includes("HEAD") ? "a".repeat(40) : args.includes("--abbrev-ref") ? "origin/develop" : `${"b".repeat(40)}\trefs/heads/develop`; };
	const repo: UpdateTarget = { id: "git", name: "repo", current: null, kind: "git", directory: "/fixture" };
	expect(await checkComponent(repo, undefined, git)).toMatchObject({ status: "available", current: "a".repeat(12), latest: "b".repeat(12), canUpdate: true });
	expect(calls.at(-1)).toEqual(["ls-remote", "origin", "refs/heads/develop"]);
	expect(await checkComponent({ ...repo, pinned: true }, undefined, git)).toMatchObject({ status: "pinned", canUpdate: false });
	expect(await checkComponent(repo, undefined, async () => { throw Error("offline"); })).toMatchObject({ status: "error", canUpdate: false });
});

test("update accepts only a catalog target and refuses bundled, pinned or dirty packages", async () => {
	const { updateComponentPackage } = await import("../../server/component-updates.js");
	const updated: string[] = [];
	const update = async (source: string) => { updated.push(source); };
	const check = async (entry: UpdateTarget) => checkComponent(entry, async () => "1.3.0");
	await expect(updateComponentPackage([target], "npm:injected", update, check)).rejects.toThrow();
	for (const entry of [{ ...target, kind: "bundled" as const }, { ...target, pinned: true }, { ...target, ambiguous: true }]) {
		await expect(updateComponentPackage([entry], entry.id, update, check)).rejects.toThrow();
	}
	const gitTarget: UpdateTarget = { ...target, kind: "git", directory: "/fixture" };
	await expect(updateComponentPackage([gitTarget], gitTarget.id, update, async () => ({ id: "git", name: "repo", current: "a", latest: "b", kind: "git", status: "available", canUpdate: true }), async () => " M index.ts")).rejects.toThrow("本地改动");
	expect(updated).toEqual([]);
	await updateComponentPackage([target], target.id, update, check);
	expect(updated).toEqual(["npm:sample"]);
});
