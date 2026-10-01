import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../server/omp/paths.js", () => ({ ompRuntimePaths: () => ({ bun: "bun" }), ompWorkerPath: () => "admin.mjs", ompEnvironment: () => ({}), getAgentDir: () => "/isolated/agent" }));
import { spawn } from "node:child_process";
import { runOmpAdmin } from "../../server/omp/admin.js";

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("waits for the management worker to close before cancellation releases its caller", async () => {
	vi.useFakeTimers();
	const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
	vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
	const controller = new AbortController();
	let settled = false;
	const result = runOmpAdmin("catalog", {}, { signal: controller.signal }).catch(error => { settled = true; return error; });
	controller.abort();
	await Promise.resolve();
	expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	expect(settled).toBe(false);
	child.emit("close", null, "SIGTERM");
	expect(await result).toMatchObject({ message: "OMP management operation cancelled" });
	expect(vi.getTimerCount()).toBe(0);
});
