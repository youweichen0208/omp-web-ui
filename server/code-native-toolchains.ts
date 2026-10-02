/** Optional local language tools. Installation never runs in a project directory. */
import { Agent, EnvHttpProxyAgent } from "undici";
import { spawn } from "node:child_process";
import {
	access,
	chmod,
	cp,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { constants, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { open as openZip } from "yauzl";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { extract } from "tar";

import type { CodeSettings } from "./protocol.js";
import type { NativeCodeLanguage } from "./code-languages.js";
import {
	nativeToolchainPins,
	pinnedNativeAsset,
} from "./native-toolchain-pins.js";
import { stopCodeProcess } from "./code-process.js";
import { mavenSettingsNearExecutable } from "./maven-project.js";
const versions = nativeToolchainPins.versions;
const names = {
	java: "java",
	go: "gopls",
	rust: "rust-analyzer",
	cpp: "clangd",
};
export interface NativeLaunch {
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	initializationOptions?: Record<string, unknown>;
}
export class MissingCodeTool extends Error {}
export function safeArchivePath(root: string, path: string): boolean {
	if (
		isAbsolute(path) ||
		/^[A-Za-z]:/.test(path) ||
		path.includes("\\") ||
		path.includes("\0")
	)
		return false;
	const rel = relative(root, resolve(root, path));
	return !rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel);
}
export class NativeCodeToolchains {
	private controller = new AbortController();
	private dispatcher =
		process.env.HTTPS_PROXY ||
		process.env.https_proxy ||
		process.env.HTTP_PROXY ||
		process.env.http_proxy
			? new EnvHttpProxyAgent({ connect: { timeout: 30000 } })
			: new Agent({ connect: { timeout: 30000 } });
	private stopping?: Promise<void>;
	private jobs = new Map<NativeCodeLanguage, Promise<void>>();
	private children = new Set<number>();
	private javaLeases = new Map<string, import("node:fs/promises").FileHandle>();
	constructor(readonly dataDir: string) {}
	private root(language: NativeCodeLanguage) {
		return join(
			this.dataDir,
			"code-intelligence",
			"native-tools",
			`${language}-${versions[language]}-${process.platform}-${process.arch}${language === "go" ? "" : "-verified-1"}`,
		);
	}
	private async executable(path: string, cwd?: string) {
		if (!isAbsolute(path)) return undefined;
		try {
			const actual = await realpath(path);
			if (cwd) {
				const rel = relative(cwd, actual);
				if (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))
					return undefined;
			}
			if (!(await stat(actual)).isFile()) return undefined;
			await access(
				actual,
				process.platform === "win32" ? constants.F_OK : constants.X_OK,
			);
			return actual;
		} catch {
			return undefined;
		}
	}
	private async find(name: string, cwd?: string) {
		const paths = [
			...(process.env.PATH ?? "").split(delimiter),
			...(process.env.CARGO_HOME ? [join(process.env.CARGO_HOME, "bin")] : []),
			...(process.env.GOROOT ? [join(process.env.GOROOT, "bin")] : []),
			join(homedir(), "go", "bin"),
			join(homedir(), ".cargo", "bin"),
			"/opt/homebrew/bin",
			"/usr/local/bin",
			"/usr/local/go/bin",
			"/usr/bin",
		];
		for (const dir of paths) {
			if (!isAbsolute(dir)) continue;
			for (const extension of process.platform === "win32"
				? name === "mvn"
					? [".cmd", ".exe", ".bat"]
					: [".exe"]
				: [""]) {
				const found = await this.executable(join(dir, name + extension), cwd);
				if (found) return found;
			}
		}
	}
	async findMavenGlobalSettings(cwd: string) {
		const command = await this.find("mvn", cwd);
		return command ? mavenSettingsNearExecutable(command) : undefined;
	}
	private async installed(language: NativeCodeLanguage) {
		try {
			const manifest = JSON.parse(
				await readFile(join(this.root(language), "ready.json"), "utf8"),
			);
			return manifest as { command: string; jdk?: string };
		} catch {
			return undefined;
		}
	}
	private async run(
		command: string,
		args: string[],
		options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
	) {
		if (this.controller.signal.aborted) throw new Error("Service stopped");
		return new Promise<string>((done, reject) => {
			const child = spawn(command, args, {
				cwd: options.cwd,
				env: {
					...(options.env ?? process.env),
					ELECTRON_RUN_AS_NODE: undefined,
				},
				detached: process.platform !== "win32",
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (child.pid) this.children.add(child.pid);
			let out = "",
				err = "",
				reason = "",
				bytes = 0;
			const terminate = () => {
				if (child.pid) void stopCodeProcess(child.pid);
			};
			const abort = () => {
				reason = "Service stopped";
				terminate();
			};
			const timer = setTimeout(() => {
				reason = "Tool process timed out";
				terminate();
			}, options.timeout ?? 15000);
			const cleanup = () => {
				clearTimeout(timer);
				this.controller.signal.removeEventListener("abort", abort);
				if (child.pid) this.children.delete(child.pid);
			};
			this.controller.signal.addEventListener("abort", abort, { once: true });
			const collect = (chunk: Buffer, stderr: boolean) => {
				bytes += chunk.length;
				if (bytes > 1024 * 1024) {
					reason = "Tool output limit exceeded";
					terminate();
					return;
				}
				if (stderr) err += chunk.toString();
				else out += chunk.toString();
			};
			child.stdout.on("data", (chunk) => collect(chunk, false));
			child.stderr.on("data", (chunk) => collect(chunk, true));
			child.once("error", (error) => {
				cleanup();
				reject(error);
			});
			child.once("close", (code) => {
				cleanup();
				code === 0 && !reason
					? done(out || err)
					: reject(
							new Error(
								`${reason || command}: ${(err || `exit ${code}`).slice(-2000)}`,
							),
						);
			});
		});
	}

	private async java(home?: string, cwd?: string) {
		const command = home
			? await this.executable(
					join(home, "bin", process.platform === "win32" ? "java.exe" : "java"),
				)
			: await this.find("java", cwd);
		if (!command) return undefined;
		try {
			const version = await this.run(command, ["-version"]);
			const major = Number(/version\s+"?(\d+)/.exec(version)?.[1]);
			return major >= 21 ? command : undefined;
		} catch {
			return undefined;
		}
	}
	async launch(
		language: NativeCodeLanguage,
		cwd: string,
		settings: CodeSettings,
	): Promise<NativeLaunch> {
		const configured = settings.nativePaths?.[language],
			installed = await this.installed(language);
		if (language === "java") {
			const server =
				configured ||
				(installed?.command
					? join(this.root(language), installed.command)
					: undefined);
			const java =
				(await this.java(settings.javaHome || process.env.JAVA_HOME, cwd)) ||
				(await this.java(installed?.jdk, cwd));
			for (const version of ["8", "17"] as const) {
				const home = settings.javaProjectHomes?.[version];
				if (!home) continue;
				const executable = await this.executable(
					join(home, "bin", process.platform === "win32" ? "java.exe" : "java"),
				);
				if (
					!executable ||
					!(await this.executable(
						join(
							home,
							"bin",
							process.platform === "win32" ? "javac.exe" : "javac",
						),
					))
				)
					throw new MissingCodeTool(
						`Java ${version} project runtime requires a full JDK: ${home}`,
					);
				const output = await this.run(executable, ["-version"]);
				const match = /version\s+"?(\d+)(?:\.(\d+))?/.exec(output);
				const major =
					match?.[1] === "1" ? Number(match[2]) : Number(match?.[1]);
				if (major !== Number(version))
					throw new MissingCodeTool(
						`Java ${version} project JDK has version ${major}: ${home}`,
					);
			}
			if (!server || !java)
				throw new MissingCodeTool(
					"Java needs JDT LS and Java 21+. Install the local toolchain in Code Intelligence settings.",
				);
			if (!isAbsolute(server))
				throw new MissingCodeTool("JDT LS directory must be an absolute path");
			const plugins = await readdir(join(server, "plugins"));
			const launcher = plugins.find((name) =>
				/^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name),
			);
			if (!launcher) throw new MissingCodeTool("JDT LS launcher not found");
			const base =
				process.platform === "darwin"
					? "config_mac"
					: process.platform === "win32"
						? "config_win"
						: "config_linux";
			const configs = [
				`${base}_${process.arch === "arm64" ? "aarch64" : "x86_64"}`,
				base,
			];
			let configuration;
			for (const name of configs)
				try {
					await stat(join(server, name));
					configuration = join(server, name);
					break;
				} catch {}
			if (!configuration)
				throw new MissingCodeTool("JDT LS platform configuration not found");
			const project = createHash("sha256").update(cwd).digest("hex");
			const workspaceBase = join(
				this.dataDir,
				"code-intelligence",
				"java-workspaces",
			);
			await mkdir(workspaceBase, { recursive: true });
			let cache = join(workspaceBase, project);
			if (!this.javaLeases.has(cache)) {
				for (let attempt = 0; attempt < 3; attempt++) {
					await mkdir(cache, { recursive: true });
					try {
						const handle = await open(join(cache, "lease"), "wx");
						await handle.writeFile(String(process.pid));
						this.javaLeases.set(cache, handle);
						break;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						let alive = true;
						try {
							const pid = Number(await readFile(join(cache, "lease"), "utf8"));
							if (pid > 0)
								try {
									process.kill(pid, 0);
								} catch (e) {
									if ((e as NodeJS.ErrnoException).code === "ESRCH")
										alive = false;
								}
						} catch {}
						if (!alive) {
							await rm(join(cache, "lease"), { force: true });
							continue;
						}
						cache = join(workspaceBase, `${project}-${process.pid}`);
					}
				}
				if (!this.javaLeases.has(cache))
					throw new Error("Java workspace is busy");
			}

			const config = join(cache, `config-${versions.java}`);
			await cp(configuration, config, { recursive: true, force: false });
			return {
				command: java,
				args: [
					"-Declipse.application=org.eclipse.jdt.ls.core.id1",
					"-Dosgi.bundles.defaultStartLevel=4",
					"-Declipse.product=org.eclipse.jdt.ls.core.product",
					`-Xmx${settings.nativeMemoryMiB ?? 1024}m`,
					"--add-modules=ALL-SYSTEM",
					"--add-opens",
					"java.base/java.util=ALL-UNNAMED",
					"--add-opens",
					"java.base/java.lang=ALL-UNNAMED",
					"-jar",
					join(server, "plugins", launcher),
					"-configuration",
					config,
					"-data",
					join(cache, "workspace"),
				],
				env: {
					CLIENT_PORT: undefined,
					CLIENT_HOST: undefined,
					CLIENT_PIPE: undefined,
				},
			};
		}
		const command = configured
			? await this.executable(configured)
			: installed?.command
				? await this.executable(join(this.root(language), installed.command))
				: await this.find(names[language], cwd);
		if (!command)
			throw new MissingCodeTool(
				`${names[language]} is missing. Install it or set an absolute executable path in Code Intelligence settings.`,
			);
		const env: NodeJS.ProcessEnv = {};
		if (language === "rust") {
			const cargo = await this.find("cargo", cwd);
			if (!cargo)
				throw new MissingCodeTool(
					"Rust/Cargo SDK is required; install Rust before querying Rust projects",
				);
			env.PATH = join(cargo, "..") + delimiter + (process.env.PATH ?? "");
			env.RUSTUP_AUTO_INSTALL = "0";
		}
		if (language === "go") {
			const go = await this.find("go", cwd);
			if (!go)
				throw new MissingCodeTool(
					"Go SDK is required (install Go, then install gopls)",
				);
			env.PATH = join(go, "..") + delimiter + (process.env.PATH ?? "");
			env.GOMEMLIMIT = `${settings.nativeMemoryMiB ?? 1024}MiB`;
			env.GOTOOLCHAIN = "local";
		}
		return {
			command,
			args:
				language === "cpp"
					? [
							"--background-index=false",
							"--clang-tidy=false",
							"--enable-config=false",
							"-j=2",
						]
					: [],
			env,
		};
	}
	async install(language: NativeCodeLanguage, javaHome?: string) {
		if (this.controller.signal.aborted) throw new Error("Service stopped");
		let job = this.jobs.get(language);
		if (!job) {
			job = this.prepare(language, javaHome).finally(() =>
				this.jobs.delete(language),
			);
			this.jobs.set(language, job);
		}
		try {
			await job;
		} catch (error) {
			if (this.controller.signal.aborted) throw error;
			throw new Error(
				`${String(error)}\nInstallation failed. Configure HTTPS_PROXY${language === "go" ? " / GOPROXY" : ""}, retry, or set an existing local server path in Code Intelligence settings.`,
			);
		}
	}
	private async fetch(url: string) {
		const response = await (
			await import("undici")
		).fetch(url, {
			dispatcher: this.dispatcher,
			signal: AbortSignal.any([
				this.controller.signal,
				AbortSignal.timeout(900000),
			]),
			headers: {
				"user-agent": "pi-web-ui",
				...(url.includes("api.github.com/") && url.includes("/releases/assets/")
					? { accept: "application/octet-stream" }
					: {}),
			},
		});
		if (
			!response.ok &&
			new URL(url).host === "api.github.com" &&
			(response.status === 403 || response.status === 429)
		)
			throw new Error(
				"GitHub API access denied or rate limited. Retry later, use HTTPS_PROXY, or set an existing local server path in Code Intelligence settings.",
			);
		if (!response.ok)
			throw new Error(
				`Tool download failed: HTTP ${response.status} (${new URL(url).host})`,
			);
		return response;
	}
	private async download(url: string, sha: string, path: string) {
		if (!/^[a-f0-9]{64}$/i.test(sha))
			throw new Error("Missing upstream SHA256");
		if (url.startsWith("https://github.com/")) {
			const parsed = new URL(url),
				parts = parsed.pathname.split("/");
			if (parts[3] === "releases" && parts[4] === "download") {
				const release = (await (
					await this.fetch(
						`https://api.github.com/repos/${parts[1]}/${parts[2]}/releases/tags/${encodeURIComponent(decodeURIComponent(parts[5]))}`,
					)
				).json()) as { assets: { name: string; url: string }[] };
				const asset = release.assets.find(
					(a) => a.name === decodeURIComponent(parts.slice(6).join("/")),
				);
				if (!asset) throw new Error("GitHub release asset missing");
				url = asset.url;
			}
		}
		const response = await this.fetch(url);
		let size = 0;
		const hash = createHash("sha256"),
			file = await open(path, "wx");
		try {
			for await (const chunk of response.body!) {
				size += chunk.length;
				if (size > 512 * 1024 * 1024)
					throw new Error("Tool archive exceeds 512 MiB");
				hash.update(chunk);
				await file.writeFile(chunk);
			}
			if (hash.digest("hex") !== sha.toLowerCase())
				throw new Error("Tool archive SHA256 mismatch");
		} finally {
			await file.close();
		}
	}
	private async unpack(archive: string, directory: string) {
		await mkdir(directory, { recursive: true });
		if (archive.endsWith(".zip"))
			await new Promise<void>((done, reject) => {
				openZip(
					archive,
					{ lazyEntries: true, validateEntrySizes: true },
					(error, zip) => {
						if (error || !zip) {
							reject(error);
							return;
						}
						let bytes = 0,
							entries = 0;
						const fail = (error: unknown) => {
							zip.close();
							reject(error);
						};
						zip.on("error", fail);
						zip.on("end", done);
						zip.on("entry", (entry) => {
							void (async () => {
								bytes += entry.uncompressedSize;
								if (
									++entries > 50000 ||
									bytes > 1024 * 1024 * 1024 ||
									!safeArchivePath(directory, entry.fileName) ||
									((entry.externalFileAttributes >>> 16) & 0o170000) ===
										0o120000
								)
									throw new Error("Unsafe or oversized ZIP entry");
								const target = resolve(directory, entry.fileName);
								if (entry.fileName.endsWith("/")) {
									await mkdir(target, { recursive: true });
									zip.readEntry();
									return;
								}
								await mkdir(join(target, ".."), { recursive: true });
								const stream = await new Promise<
									import("node:stream").Readable
								>((done, reject) =>
									zip.openReadStream(entry, (error, stream) =>
										error || !stream ? reject(error) : done(stream),
									),
								);
								await pipeline(
									stream,
									createWriteStream(target, { flags: "wx", mode: 0o644 }),
								);
								zip.readEntry();
							})().catch(fail);
						});
						zip.readEntry();
					},
				);
			});
		else
			await extract({
				file: archive,
				cwd: directory,
				strict: true,
				filter: (path, entry) => {
					if (
						!safeArchivePath(directory, path) ||
						("type" in entry && entry.type === "Link")
					)
						throw new Error("Unsafe TAR entry");
					if (
						"type" in entry &&
						entry.type === "SymbolicLink" &&
						(!entry.linkpath ||
							isAbsolute(entry.linkpath) ||
							/^[A-Za-z]:/.test(entry.linkpath) ||
							entry.linkpath.includes("\\") ||
							!safeArchivePath(directory, join(path, "..", entry.linkpath)))
					)
						throw new Error("Unsafe TAR link");
					return true;
				},
			});
	}
	private async release(repo: string, tag: string, name: string) {
		const pin = pinnedNativeAsset(name);
		const release = (await (
			await this.fetch(
				`https://api.github.com/repos/${repo}/releases/tags/${tag}`,
			)
		).json()) as {
			assets: {
				name: string;
				browser_download_url: string;
				url: string;
				digest?: string;
			}[];
		};
		const asset = release.assets.find((asset) => asset.name === name);
		if (!asset)
			throw new Error(
				`Verified asset unavailable for ${process.platform}/${process.arch}: ${name}`,
			);
		if (
			!asset.url.startsWith(
				`https://api.github.com/repos/${repo}/releases/assets/`,
			) ||
			!/\/assets\/\d+$/.test(asset.url)
		)
			throw new Error("Unexpected native release asset URL");
		pinnedNativeAsset(
			name,
			asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : undefined,
		);
		return { url: asset.url, sha: pin.sha256 };
	}
	private async prepare(language: NativeCodeLanguage, javaHome?: string) {
		const root = this.root(language);
		await mkdir(join(root, ".."), { recursive: true });
		let lock;
		const deadline = Date.now() + 1800000;
		while (!lock) {
			try {
				lock = await open(root + ".lock", "wx");
				await lock.writeFile(String(process.pid));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					const pid = Number(await readFile(root + ".lock", "utf8"));
					if (pid > 0) {
						try {
							process.kill(pid, 0);
						} catch (e) {
							if ((e as NodeJS.ErrnoException).code === "ESRCH")
								await rm(root + ".lock", { force: true });
						}
					}
				} catch {}
				if (this.controller.signal.aborted || Date.now() > deadline)
					throw new Error("Tool installation wait interrupted");
				await new Promise((done) => setTimeout(done, 100));
			}
		}
		const staging = root + `.tmp-${process.pid}`;
		try {
			if (await this.installed(language)) return;
			await rm(staging, { recursive: true, force: true });
			await mkdir(staging, { recursive: true });
			let command: string, jdk: string | undefined;
			if (language === "go") {
				const go = await this.find("go");
				if (!go)
					throw new MissingCodeTool("Install Go SDK before installing gopls");
				await this.run(
					go,
					["install", `golang.org/x/tools/gopls@v${versions.go}`],
					{
						cwd: staging,
						timeout: 600000,
						env: {
							...process.env,
							GOBIN: staging,
							GOMAXPROCS: "2",
							GOWORK: "off",
							GOSUMDB: "sum.golang.org",
							GONOSUMDB: "none",
							GONOPROXY: "none",
							GOPRIVATE: "none",
							GOFLAGS: "",
							GOTOOLCHAIN: "auto",
							GOMODCACHE: join(
								this.dataDir,
								"code-intelligence",
								"go-modcache",
							),
							GOCACHE: join(this.dataDir, "code-intelligence", "go-buildcache"),
						},
					},
				);
				command = names.go + (process.platform === "win32" ? ".exe" : "");
			} else if (language === "rust") {
				const target =
					process.platform === "darwin"
						? "apple-darwin"
						: process.platform === "win32"
							? "pc-windows-msvc"
							: "unknown-linux-gnu";
				const arch =
					process.arch === "arm64"
						? "aarch64"
						: process.arch === "x64"
							? "x86_64"
							: undefined;
				if (!arch) throw new Error("Unsupported CPU architecture");
				const ext = process.platform === "win32" ? "zip" : "gz",
					asset = await this.release(
						"rust-lang/rust-analyzer",
						versions.rust,
						`rust-analyzer-${arch}-${target}.${ext}`,
					);
				const archive = join(staging, "download." + ext);
				await this.download(asset.url, asset.sha, archive);
				command =
					"rust-analyzer" + (process.platform === "win32" ? ".exe" : "");
				if (ext === "gz")
					await writeFile(
						join(staging, command),
						gunzipSync(await readFile(archive), {
							maxOutputLength: 256 * 1024 * 1024,
						}),
					);
				else await this.unpack(archive, staging);
				await chmod(join(staging, command), 0o755);
				await rm(archive);
			} else if (language === "cpp") {
				const os =
					process.platform === "darwin"
						? "mac"
						: process.platform === "win32"
							? "windows"
							: "linux";
				if (process.arch === "arm64" && process.platform !== "darwin")
					throw new MissingCodeTool(
						"Use a native clangd executable on this platform; upstream archive does not support ARM64",
					);
				const asset = await this.release(
						"clangd/clangd",
						versions.cpp,
						`clangd-${os}-${versions.cpp}.zip`,
					),
					archive = join(staging, "download.zip");
				await this.download(asset.url, asset.sha, archive);
				await this.unpack(archive, staging);
				command = join(
					`clangd_${versions.cpp}`,
					"bin",
					"clangd" + (process.platform === "win32" ? ".exe" : ""),
				);
				await chmod(join(staging, command), 0o755);
				await rm(archive);
			} else {
				const url = `https://download.eclipse.org/jdtls/milestones/${versions.java}/jdt-language-server-${versions.java}-202609031315.tar.gz`;
				const upstreamSha = (await (await this.fetch(url + ".sha256")).text())
					.trim()
					.split(/\s+/)[0];
				const sha = pinnedNativeAsset(
					"jdt-language-server-1.61.0-202609031315.tar.gz",
					upstreamSha,
				).sha256;
				const archive = join(staging, "jdt.tar.gz");
				await this.download(url, sha, archive);
				await this.unpack(archive, join(staging, "server"));
				await rm(archive);
				command = "server";
				if (!(await this.java(javaHome || process.env.JAVA_HOME))) {
					const os =
							process.platform === "darwin"
								? "mac"
								: process.platform === "win32"
									? "windows"
									: "linux",
						arch = process.arch === "arm64" ? "aarch64" : "x64";
					const name = `OpenJDK21U-jdk_${arch}_${os}_hotspot_21.0.12.1_1.${process.platform === "win32" ? "zip" : "tar.gz"}`;
					const pkg = await this.release(
						"adoptium/temurin21-binaries",
						versions.jdk,
						name,
					);
					const archive = join(
						staging,
						process.platform === "win32" ? "jdk.zip" : "jdk.tar.gz",
					);
					await this.download(pkg.url, pkg.sha, archive);
					await this.unpack(archive, join(staging, "jdk"));
					await rm(archive);
					const folder = (await readdir(join(staging, "jdk")))[0];
					jdk = join(
						root,
						"jdk",
						folder,
						...(process.platform === "darwin" ? ["Contents", "Home"] : []),
					);
				}
			}
			await writeFile(
				join(staging, "ready.json"),
				JSON.stringify({ command, jdk, version: versions[language] }),
			);
			await rename(staging, root);
		} finally {
			await lock.close();
			await rm(root + ".lock", { force: true });
			await rm(staging, { recursive: true, force: true });
		}
	}
	shutdown(): Promise<void> {
		return (this.stopping ??= this.finishShutdown());
	}
	private async finishShutdown() {
		this.controller.abort();
		await Promise.all([...this.children].map(stopCodeProcess));
		await Promise.allSettled([...this.jobs.values()]);
		await this.dispatcher.close();
		for (const [cache, lease] of this.javaLeases) {
			await lease.close();
			await rm(join(cache, "lease"), { force: true });
		}
		this.javaLeases.clear();
	}
}
