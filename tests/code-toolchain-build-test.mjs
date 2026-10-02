/** Build in a path with spaces; repeat to check deterministic archive ordering. */
import {
	mkdtemp,
	mkdir,
	cp,
	symlink,
	writeFile,
	readFile,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "pi toolchain spaces "));
try {
	await mkdir(join(root, "scripts"));
	await writeFile(join(root, "package.json"), '{"type":"module"}');
	await cp(
		resolve("scripts/build-code-toolchain.mjs"),
		join(root, "scripts/build-code-toolchain.mjs"),
	);
	await symlink(
		resolve("node_modules"),
		join(root, "node_modules"),
		process.platform === "win32" ? "junction" : "dir",
	);
	const build = () =>
		run(process.execPath, [join(root, "scripts/build-code-toolchain.mjs")], {
			timeout: 60000,
		});
	await build();
	const first = JSON.parse(
		await readFile(
			join(root, "resources/code-toolchain/manifest.json"),
			"utf8",
		),
	);
	await build();
	const second = JSON.parse(
		await readFile(
			join(root, "resources/code-toolchain/manifest.json"),
			"utf8",
		),
	);
	assert.equal(first.sha256, second.sha256);
	assert(
		first.compressedBytes <= 12 * 1024 * 1024 &&
			first.unpackedBytes <= 45 * 1024 * 1024,
	);
	console.log("PASS toolchain build with spaces and repeated archive hash");
} finally {
	await rm(root, { recursive: true, force: true });
}
