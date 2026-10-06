import { describe, it, expect } from "vitest";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { toolOutputUpdate } from "../../server/tool-output.js";
import { mergeLiveToolOutput } from "../../web/src/live-tool-output.js";

describe("SDK tool output → wire update → live output", () => {
	it("renders each line once when the real bash tool emits cumulative updates", async () => {
		const outputs = ["PID: 123\n", "mock started\n", "HTTP 200\n"];
		const tool = createBashTool(process.cwd(), { operations: { exec: async (_command, _cwd, { onData }) => {
			for (const output of outputs) { onData(Buffer.from(output)); await new Promise((r) => setTimeout(r, 120)); }
			return { exitCode: 0 };
		} } });
		let visible = "";
		await tool.execute("test-bash", { command: "fixture" }, undefined, (partial) => {
			const update = toolOutputUpdate(partial);
			if (update) visible = mergeLiveToolOutput(visible, update);
		});
		expect(visible).toBe(outputs.join(""));
	});
	it("replaces rolling snapshots and allows an empty snapshot to clear output", () => {
		const snapshot = (text: string) => toolOutputUpdate({ content: [{ type: "text", text }] })!;
		let visible = mergeLiveToolOutput("", snapshot("first\nsecond\n"));
		visible = mergeLiveToolOutput(visible, snapshot("second\nthird\n"));
		expect(visible).toBe("second\nthird\n");
		expect(mergeLiveToolOutput(visible, snapshot(""))).toBe("");
	});
	it("still appends the genuine user_bash deltas", () => {
		const first = mergeLiveToolOutput("", { delta: "one\n" });
		expect(mergeLiveToolOutput(first, { delta: "two\n" })).toBe("one\ntwo\n");
	});
	it("retains the newest output when a snapshot exceeds the cap", () => {
		const output = "x".repeat(210000) + "latest";
		const visible = mergeLiveToolOutput("old", { delta: output, replace: true });
		expect(visible.endsWith("latest")).toBe(true);
		expect(visible.length).toBeLessThan(200100);
	});
});

import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openToolOutput, toolOutputManifest } from "../../server/tool-output.js";
it("collects multiple native binary/image references from full output and preserves bytes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-download-unit-"));
	const paths: string[] = [];
	try {
		for (const [prefix, ext] of [["mcp", "bin"], ["codemode", "png"], ["codemode", "jpg"], ["codemode", "gif"], ["codemode", "webp"], ["powershell", "log"]]) {
			const path = join(tmpdir(), `pi-${prefix}-${randomBytes(8).toString("hex")}.${ext}`); paths.push(path);
			await writeFile(path, Buffer.from([0, 255, 128, 10]));
			const handle = await openToolOutput(cwd, path);
			try { expect(await handle.readFile()).toEqual(Buffer.from([0, 255, 128, 10])); } finally { await handle.close(); }
		}
		const full = join(tmpdir(), `pi-codemode-${randomBytes(8).toString("hex")}.txt`); paths.push(full);
		const text = `[Binary resource fixture://blob (application/octet-stream, 4 B) saved to ${paths[0]}]\n` + paths.slice(1, 5).map((path, i) => `[Image saved to ${path} (image/${["png", "jpeg", "gif", "webp"][i]}, 4 B)]`).join("\n");
		await writeFile(full, text);
		const manifest = await toolOutputManifest(cwd, "codemode", text, full);
		expect(manifest).toHaveLength(6); expect(new Set(manifest.map(o => o.id)).size).toBe(6);
		expect(manifest.filter(o => o.default).map(o => o.path)).toEqual([full]);
		expect((await toolOutputManifest(cwd, "codemode", text)).every(o => !o.default)).toBe(true);
		expect(await toolOutputManifest(cwd, "codemode", "truncated", full)).toEqual(manifest);
		await rm(paths[0]); await symlink(paths[1], paths[0]);
		await expect(openToolOutput(cwd, paths[0])).rejects.toMatchObject({ code: "EACCES" });
	} finally { for (const path of paths) await rm(path, { force: true }); await rm(cwd, { recursive: true, force: true }); }
});


it("never interprets marker-shaped Bash/PowerShell or arbitrary tool output", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-log-unit-"));
	try {
		const full = join(cwd, "large.log");
		const text = `[Image saved to ${join(cwd, "fake.png")} (image/png, 1 B)]`;
		await writeFile(full, text);
		for (const name of ["bash", "powershell", "custom-tool"]) {
			expect(await toolOutputManifest(cwd, name, text, full)).toHaveLength(1);
			expect(await toolOutputManifest(cwd, name, text)).toEqual([]);
		}
		for (const name of ["codemode", "mcp__fixture__tool", "read_mcp_resource"]) expect(await toolOutputManifest(cwd, name, text, full)).toHaveLength(2);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

it("bounds spill scanning and preserves split UTF-8 and markers across 64 KiB reads", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-scan-unit-"));
	try {
		const full = join(cwd, "full.txt");
		const marker = (name: string) => `[Image saved to ${join(cwd, name)} (image/png, 1 B)]`;
		const first = marker("你好.png"), last = marker("last.png"), outside = marker("outside.png");
		const prefix = "x".repeat(65536 - Buffer.byteLength(first.slice(0, first.indexOf("你"))) - 1) + first + "\n";
		const cap = 8 * 1024 * 1024;
		await writeFile(full, prefix + "x".repeat(cap - Buffer.byteLength(prefix) - Buffer.byteLength(last)) + last + outside);
		const manifest = await toolOutputManifest(cwd, "codemode", "", full);
		expect(manifest.map(f => f.name)).toEqual(["full.txt", "你好.png", "last.png"]);
		// A marker crossing the cap must not be emitted as a shortened path.
		await writeFile(full, "x".repeat(cap - 20) + outside);
		expect(await toolOutputManifest(cwd, "codemode", "", full)).toHaveLength(1);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});
