// Read-only candidate generator: build server first, review the output manually.
import fs from "node:fs/promises";
import { NativeCodeToolchains } from "../dist/server/code-native-toolchains.js";
const tools = new NativeCodeToolchains("/tmp/pi-native-pin-review");
try {
	const table = {
		schema: 1,
		versions: {
			java: "1.61.0",
			go: "0.21.1",
			rust: "2026-09-28",
			cpp: "23.1.0",
			jdk: "jdk-21.0.12.1+1",
		},
		assets: {},
	};
	const repos = [
		[
			"rust-lang/rust-analyzer",
			"2026-09-28",
			(a) =>
				/^rust-analyzer-(aarch64|x86_64)-(apple-darwin|pc-windows-msvc|unknown-linux-gnu)\.(gz|zip)$/.test(
					a.name,
				),
		],
		[
			"clangd/clangd",
			"23.1.0",
			(a) => /^clangd-(mac|windows|linux)-23\.1\.0.zip$/.test(a.name),
		],
		[
			"adoptium/temurin21-binaries",
			"jdk-21.0.12.1+1",
			(a) =>
				/^OpenJDK21U-jdk_(aarch64|x64)_(mac|windows|linux)_hotspot_21\.0\.12\.1_1\.(tar\.gz|zip)$/.test(
					a.name,
				),
		],
	];
	for (const [repo, tag, select] of repos) {
		const url = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
		const release = await (await tools.fetch(url)).json();
		for (const asset of release.assets.filter(select)) {
			if (!asset.digest?.startsWith("sha256:")) throw Error(asset.name);
			table.assets[asset.name] = {
				url: asset.browser_download_url,
				sha256: asset.digest.slice(7),
			};
		}
	}
	const url =
		"https://download.eclipse.org/jdtls/milestones/1.61.0/jdt-language-server-1.61.0-202609031315.tar.gz";
	table.assets["jdt-language-server-1.61.0-202609031315.tar.gz"] = {
		url,
		sha256: (await (await tools.fetch(url + ".sha256")).text())
			.trim()
			.split(/\s+/)[0],
	};
	console.log(JSON.stringify(table, null, 2));
} finally {
	await tools.shutdown();
}
