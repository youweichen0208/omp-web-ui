import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
	mkdtemp,
	mkdir,
	cp,
	readdir,
	rm,
	readFile,
	writeFile,
	stat,
} from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { create } from "tar";
const require = createRequire(import.meta.url);
const output = new URL("../resources/code-toolchain/", import.meta.url);
const staging = await mkdtemp(join(tmpdir(), "pi-code-build-"));
try {
	for (const name of ["typescript", "typescript-language-server", "pyright"]) {
		const root = dirname(require.resolve(`${name}/package.json`));
		await cp(root, join(staging, "node_modules", name), {
			recursive: true,
			filter: (source) =>
				!source.endsWith(".map") &&
				!(
					name === "typescript" &&
					/[/\\]lib[/\\](?:cs|de|es|fr|it|ja|ko|pl|pt-br|ru|tr|zh-cn|zh-tw)(?:[/\\]|$)/.test(
						source,
					)
				),
		});
	}
	const entries = [];
	let bytes = 0,
		files = 0;
	async function walk(dir) {
		for (const item of (await readdir(dir, { withFileTypes: true })).sort(
			(a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
		)) {
			const path = join(dir, item.name);
			entries.push(relative(staging, path).split("\\").join("/"));
			if (item.isDirectory()) await walk(path);
			else {
				bytes += (await stat(path)).size;
				files++;
			}
		}
	}
	await walk(staging);
	await mkdir(output, { recursive: true });
	const archive = new URL("toolchain.tar.gz", output);
	await create(
		{
			gzip: true,
			portable: true,
			filter: (_path, info) => {
				info.mode = (info.mode & ~0o777) | (info.isDirectory() ? 0o755 : 0o644);
				return true;
			},
			noDirRecurse: true,
			cwd: staging,
			file: fileURLToPath(archive),
			mtime: new Date(0),
		},
		entries,
	);
	const data = await readFile(archive);
	if (bytes > 45 * 1024 * 1024 || data.length > 12 * 1024 * 1024)
		throw new Error(`Toolchain budget exceeded: ${bytes}/${data.length}`);
	const manifest = {
		sha256: createHash("sha256").update(data).digest("hex"),
		unpackedBytes: bytes,
		compressedBytes: data.length,
		files,
		versions: {
			typescript: "5.9.3",
			"typescript-language-server": "5.3.0",
			pyright: "1.1.414",
		},
	};
	await writeFile(
		new URL("manifest.json", output),
		JSON.stringify(manifest, null, 2) + "\n",
	);
	console.log("Code toolchain:", manifest);
} finally {
	await rm(staging, { recursive: true, force: true });
}
