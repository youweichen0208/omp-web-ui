import { it, expect, vi } from "vitest";
const pending = vi.hoisted(() => ({ callbacks: [] as (() => void)[] }));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	execFile: vi.fn((_command, _args, _options, callback) =>
		pending.callbacks.push(callback),
	),
}));
import { CodeIntelligenceManager } from "../../server/code-intelligence.js";
it("waits for Windows taskkill callbacks before shutdown resolves", async () => {
	const platform = vi
		.spyOn(process, "platform", "get")
		.mockReturnValue("win32");
	try {
		const manager = new CodeIntelligenceManager("unused");
		const service = {
			generation: 0,
			process: { pid: 12345 },
			docs: new Map(),
			state: { status: "ready" },
		};
		(manager as any).projects.set("root", {
			services: new Map([["typescript", service]]),
			timers: new Map(),
		});
		let ended = false;
		const done = manager.shutdown().then(() => {
			ended = true;
		});
		await Promise.resolve();
		expect(ended).toBe(false);
		expect(pending.callbacks).toHaveLength(1);
		pending.callbacks.shift()!();
		await done;
		expect(ended).toBe(true);
	} finally {
		platform.mockRestore();
	}
});
