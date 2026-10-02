import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectWatcher } from "../../server/project-watcher.js";
const waitFor = async (test: () => boolean) => {
	for (let i = 0; i < 100; i++) {
		if (test()) return;
		await new Promise((done) => setTimeout(done, 20));
	}
	expect(test()).toBe(true);
};
it("Linux watches a deleted and recreated directory with fresh handles", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-watch-test-"));
	await mkdir(join(root, "generated"));
	const watcher = new ProjectWatcher(root, "linux");
	const events: string[] = [];
	watcher.listeners.add((event) => events.push(event.path));
	try {
		await waitFor(() => watcher.watchers.size === 2);
		await rm(join(root, "generated"), { recursive: true });
		await waitFor(() => watcher.watchers.size === 1);
		await mkdir(join(root, "generated"));
		await waitFor(() => watcher.watchers.size === 2);
		await writeFile(join(root, "generated", "new.ts"), "export const value=1;");
		await waitFor(() => events.includes("generated/new.ts"));
	} finally {
		watcher.close();
		await rm(root, { recursive: true, force: true });
	}
});
