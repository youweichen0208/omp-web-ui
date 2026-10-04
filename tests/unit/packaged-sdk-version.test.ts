import { expect, test } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const afterPack = createRequire(import.meta.url)("../../build/afterPack.cjs");

test("desktop packaging follows the exact SDK pin and rejects mismatches or ranges", async () => {
	const out = mkdtempSync(join(tmpdir(), "pi-packaged-pin-"));
	try {
		const app = join(out, "resources/app"), sdk = join(app, "node_modules/@earendil-works/pi-coding-agent");
		mkdirSync(join(sdk, "docs"), { recursive: true });
		writeFileSync(join(sdk, "docs/codemode.md"), "models.generateImages");
		const context = { appOutDir: out, electronPlatformName: "linux", packager: { appInfo: { productFilename: "pi" } } };
		for (const version of ["1.0.1", "2.0.0"]) {
			writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { "@earendil-works/pi-coding-agent": version } }));
			writeFileSync(join(sdk, "package.json"), JSON.stringify({ version }));
			await expect(afterPack(context)).resolves.toBeUndefined();
		}
		writeFileSync(join(sdk, "package.json"), JSON.stringify({ version: "1.0.0" }));
		await expect(afterPack(context)).rejects.toThrow("expected 2.0.0, got 1.0.0");
		writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { "@earendil-works/pi-coding-agent": "^1.0.0" } }));
		await expect(afterPack(context)).rejects.toThrow("Unexpected packaged Pi SDK version");
	} finally { rmSync(out, { recursive: true, force: true }); }
});
