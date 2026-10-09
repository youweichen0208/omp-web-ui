import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesService } from "../../server/files-service.js";
import type { ServerMessage } from "../../server/protocol.js";

test("missing directories return a local error, never stack notices, and recover on refresh", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-file-listing-"));
	const messages: ServerMessage[] = [];
	const service = new FilesService({ getCwd: () => cwd, getActiveCwd: () => cwd, isDisposed: () => false, emit: message => messages.push(message) });
	try {
		for (let i = 0; i < 4; i++) await service.listFiles("removed");
		expect(messages).toHaveLength(4);
		for (const message of messages) expect(message).toMatchObject({ type: "files", cwd, path: "removed", entries: [], error: { code: "missing" } });
		mkdirSync(join(cwd, "removed"));
		writeFileSync(join(cwd, "removed/file.txt"), "restored");
		await service.listFiles("removed");
		expect(messages.at(-1)).toMatchObject({ type: "files", path: "removed", entries: [{ name: "file.txt" }] });
		expect(messages.at(-1)).not.toHaveProperty("error");
		await service.listFiles("removed/file.txt");
		expect(messages.at(-1)).toMatchObject({ type: "files", path: "removed/file.txt", error: { code: "not_directory" } });
	} finally { service.unwatchDir(); rmSync(cwd, { recursive: true, force: true }); }
});
