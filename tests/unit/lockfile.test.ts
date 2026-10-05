import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test.each([
	["https://registry.npmjs.org/uuid/-/uuid-14.0.2.tgz", true],
	["https://registry.npmmirror.com/uuid/-/uuid-14.0.2.tgz", false],
	["http://registry.npmjs.org/uuid/-/uuid-14.0.2.tgz", false],
	["https://registry.npmjs.org.example.com/uuid.tgz", false],
	["not a URL", false],
])("lockfile checker validates downloads: %s", (resolved, valid) => {
	const root = mkdtempSync(join(tmpdir(), "pi-lockfile-"));
	try {
		const path = join(root, "package-lock.json");
		writeFileSync(path, JSON.stringify({ packages: {
			"": { name: "fixture" },
			"node_modules/local": { link: true, resolved: "packages/local" },
			"node_modules/good": { resolved: "https://registry.npmjs.org/good/-/good-1.0.0.tgz" },
			"node_modules/uuid": { resolved },
		} }));
		const result = spawnSync(process.execPath, [resolve("scripts/check-lockfile.mjs"), path], { encoding: "utf8" });
		expect(result.status).toBe(valid ? 0 : 1);
		if (!valid) {
			expect(result.stderr).toContain("node_modules/uuid");
			expect(result.stderr).toContain(resolved);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});
