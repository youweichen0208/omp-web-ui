import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
	readFile,
	realpath,
	stat,
	mkdir,
	writeFile,
	rename,
} from "node:fs/promises";
import { join, resolve, relative, extname, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { totalmem } from "node:os";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
	CancellationTokenSource,
} from "vscode-jsonrpc/node";
import {
	ProjectTrustStore,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	prepareToolchain,
	leaseToolchain,
	cleanupUnusedToolchains,
} from "./code-toolchain.js";
import { subscribeProject } from "./project-watcher.js";
import { killPidTree } from "./process-utils.js";
import {
	codeLanguages,
	languageOf,
	documentLanguage,
	isNativeLanguage,
	nativeLanguages,
	serverSettings,
	rustAnalysisLimitation,
} from "./code-languages.js";
export { languageOf } from "./code-languages.js";
import {
	NativeCodeToolchains,
	MissingCodeTool,
} from "./code-native-toolchains.js";
import type {
	CodeLanguage,
	CodeDiagnostic,
	CodeSettings,
	CodeState,
	CodeServiceState,
	CodeQuery,
} from "./protocol.js";
import { discoverJavaProjects, defaultMavenSettings } from "./maven-project.js";
export const codeDefaults = (): CodeSettings => ({
	enabled: true,
	typescript: true,
	python: true,
	java: true,
	go: true,
	rust: true,
	cpp: true,
	nativePaths: {},
	...defaultMavenSettings(),
	javaHome: "",
	nativeMemoryMiB: 1024,
	feedback: false,
	pythonPath: "",
	tsMemoryMiB: 2048,
	pythonMemoryMiB: 768,
});
export const codeHash = (text: string) =>
	createHash("sha256").update(text).digest("hex");
export function boundedCodeResult(value: unknown): unknown {
	const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
	if (size(value) <= 32768) return value;
	const shrink = (v: unknown): unknown => {
		if (typeof v === "string")
			return v.length > 4000 ? v.slice(0, 4000) + "…" : v;
		if (Array.isArray(v)) return v.slice(0, 50).map(shrink);
		if (v && typeof v === "object")
			return Object.fromEntries(
				Object.entries(v).map(([k, x]) => [k, shrink(x)]),
			);
		return v;
	};
	const result = {
		...(shrink(value) as Record<string, unknown>),
		partial: true,
		message: "Result exceeds 32 KiB; narrow query",
	};
	while (size(result) > 32768) {
		let reduced = false;
		for (const [key, item] of Object.entries(result)) {
			if (Array.isArray(item) && item.length) {
				result[key as keyof typeof result] = item.slice(
					0,
					Math.floor(item.length / 2),
				) as never;
				reduced = true;
			} else if (typeof item === "string" && item.length > 1000) {
				result[key as keyof typeof result] = item.slice(0, 1000) as never;
				reduced = true;
			}
		}
		if (!reduced)
			return { partial: true, message: "Result exceeds 32 KiB; narrow query" };
	}
	return result;
}
/** Convert LSP UTF-16 positions to the public one-based line/column convention. */
export function publicCodeLocations(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(publicCodeLocations);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (typeof record.line === "number" && typeof record.character === "number")
		return { line: record.line + 1, column: record.character + 1 };
	return Object.fromEntries(
		Object.entries(record).map(([key, item]) => [
			key,
			publicCodeLocations(item),
		]),
	);
}
interface Document {
	text: string;
	hash: string;
	version: number;
	used: number;
	fresh: boolean;
	confirmed: boolean;
	diagnostics: CodeDiagnostic[];
	quietTimer?: NodeJS.Timeout;
	publication?: number;
}
interface Service {
	state: CodeServiceState;
	process?: ChildProcess;
	connection?: MessageConnection;
	starting?: Promise<void>;
	docs: Map<string, Document>;
	generation: number;
	used?: number;
	retries: number;
	stderr: string;
	tsPid?: number;
	restartTimer?: NodeJS.Timeout;
	lastFailure?: string;
	stableSince?: number;
	retired?: Map<string, CodeDiagnostic[]>;
}
interface Project {
	cwd: string;
	settings: CodeSettings;
	services: Map<string, Service>;
	owners: Set<string>;
	busy: Set<string>;
	used: number;
	unwatch?: () => void;
	watcherPartial: boolean;
	timers: Map<string, NodeJS.Timeout>;
	waits: number[];
	metadata?: Promise<{ projectTsVersion?: string; trusted: boolean }>;
	metadataAt?: number;
	languageUsers?: Map<CodeLanguage, number>;
}
type Location = {
	uri: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
};
type SymbolInfo = {
	name: string;
	kind: number;
	range?: Location["range"];
	selectionRange?: Location["range"];
	location?: Location;
	children?: SymbolInfo[];
};
/** Shared project state; adapters own request/conversation attribution. */
export class CodeIntelligenceManager {
	private projects = new Map<string, Project>();
	private aliases = new Map<string, string>();
	settingsFor(cwd: string) {
		return (
			this.projects.get(this.aliases.get(cwd) ?? cwd)?.settings ??
			codeDefaults()
		);
	}
	private listeners = new Set<(state: CodeState) => void>();
	private ownerRoots = new Map<string, string>();
	private ownerEpochs = new Map<string, number>();
	private overBudgetSince = 0;
	private warmTimers = new Map<string, NodeJS.Timeout>();
	private root?: string;
	private lease?: () => void;
	private closed = false;
	private timer?: NodeJS.Timeout;
	private maintenanceRunning = false;
	private terminations = new Set<Promise<void>>();
	private lastStates = new Map<string, string>();
	canonicalCwd(cwd: string) {
		return this.aliases.get(cwd) ?? cwd;
	}
	private nativeTools: NativeCodeToolchains;
	private startTail: Promise<void> = Promise.resolve();
	constructor(
		readonly dataDir: string,
		private trust: (cwd: string) => boolean = (cwd) =>
			new ProjectTrustStore(getAgentDir()).get(cwd) === true,
	) {
		this.nativeTools = new NativeCodeToolchains(dataDir);
	}
	subscribe(listener: (state: CodeState) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	async project(cwd: string): Promise<Project> {
		const existing = this.projects.get(this.aliases.get(cwd) ?? cwd);
		if (existing) return existing;
		const root = await realpath(cwd);
		this.aliases.set(cwd, root);
		let p = this.projects.get(root);
		if (p) return p;
		let settings = codeDefaults();
		try {
			settings = this.validate(
				JSON.parse(
					await readFile(
						join(this.dataDir, "code-intelligence", `${codeHash(root)}.json`),
						"utf8",
					),
				),
			);
		} catch {}
		if (!settings.mavenGlobalSettings)
			settings.mavenGlobalSettings =
				(await this.nativeTools.findMavenGlobalSettings(root)) || "";
		// Recheck after async I/O: concurrent sessions must get the same instance.
		p = this.projects.get(root);
		if (p) return p;
		p = {
			cwd: root,
			settings,
			services: new Map(),
			owners: new Set(),
			busy: new Set(),
			used: Date.now(),
			watcherPartial: false,
			timers: new Map(),
			waits: [],
		};
		this.projects.set(root, p);
		if (!this.timer) {
			this.timer = setInterval(() => void this.maintenance(), 15000);
			this.timer.unref();
		}
		return p;
	}
	private validate(value: CodeSettings): CodeSettings {
		value = {
			...codeDefaults(),
			...value,
			nativePaths: { ...value.nativePaths },
			javaProjectHomes: { ...value.javaProjectHomes },
		};
		for (const language of nativeLanguages) {
			if (typeof value[language] !== "boolean")
				throw new Error("Invalid native language setting");
			const path = value.nativePaths?.[language];
			if (
				path !== undefined &&
				(typeof path !== "string" ||
					path.includes("\0") ||
					(path && !isAbsolute(path)))
			)
				throw new Error("Native server path must be absolute");
		}
		if (
			typeof value.javaHome !== "string" ||
			value.javaHome.includes("\0") ||
			(value.javaHome && !isAbsolute(value.javaHome))
		)
			throw new Error("Java home must be absolute");
		for (const key of ["mavenUserSettings", "mavenGlobalSettings"] as const) {
			const path = value[key];
			if (
				path !== undefined &&
				(typeof path !== "string" ||
					path.includes("\0") ||
					(path && !isAbsolute(path)))
			)
				throw new Error("Maven settings path must be absolute");
		}
		for (const version of ["8", "17"] as const) {
			const home = value.javaProjectHomes?.[version];
			if (
				home !== undefined &&
				(typeof home !== "string" ||
					home.includes("\0") ||
					(home && !isAbsolute(home)))
			)
				throw new Error(`Java ${version} project JDK home must be absolute`);
		}
		if (
			!Number.isInteger(value.nativeMemoryMiB) ||
			value.nativeMemoryMiB! < 512 ||
			value.nativeMemoryMiB! > 8192
		)
			throw new Error("Memory target must be 512-8192 MiB");
		for (const key of ["enabled", "typescript", "python", "feedback"] as const)
			if (typeof value[key] !== "boolean")
				throw new Error("Invalid code setting");
		for (const key of ["tsMemoryMiB", "pythonMemoryMiB"] as const)
			if (
				!Number.isInteger(value[key]) ||
				value[key] < 512 ||
				value[key] > 8192
			)
				throw new Error("Heap limit must be 512–8192 MiB");
		if (typeof value.pythonPath !== "string" || value.pythonPath.includes("\0"))
			throw new Error("Invalid Python path");
		return { ...value };
	}
	async configure(cwd: string, value: CodeSettings) {
		const p = await this.project(cwd);
		p.settings = this.validate(value);
		const dir = join(this.dataDir, "code-intelligence");
		await mkdir(dir, { recursive: true });
		const file = join(dir, `${codeHash(p.cwd)}.json`);
		await writeFile(file + ".tmp", JSON.stringify(p.settings));
		await rename(file + ".tmp", file);
		await this.restart(p.cwd);
		return this.state(p.cwd);
	}
	async foreground(owner: string, cwd: string) {
		const epoch = (this.ownerEpochs.get(owner) ?? 0) + 1;
		this.ownerEpochs.set(owner, epoch);
		const p = await this.project(cwd);
		if (this.ownerEpochs.get(owner) !== epoch) return;
		const old = this.ownerRoots.get(owner);
		if (old !== p.cwd && old) this.projects.get(old)?.owners.delete(owner);
		this.ownerRoots.set(owner, p.cwd);
		p.owners.add(owner);
		p.used = Date.now();
		if (old === p.cwd) return;
		const existing = this.warmTimers.get(owner);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.warmTimers.delete(owner);
			void this.warm(p).catch(() => {});
		}, 2000);
		timer.unref();
		this.warmTimers.set(owner, timer);
		this.changed(p);
	}
	release(owner: string) {
		this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
		const root = this.ownerRoots.get(owner);
		if (root) this.projects.get(root)?.owners.delete(owner);
		this.ownerRoots.delete(owner);
		const timer = this.warmTimers.get(owner);
		if (timer) clearTimeout(timer);
		this.warmTimers.delete(owner);
	}
	async busy(cwd: string, owner: string, running: boolean) {
		const p = await this.project(cwd);
		if (running) p.busy.add(owner);
		else p.busy.delete(owner);
		p.used = Date.now();
	}
	private async warm(p: Project) {
		if (!p.settings.enabled || this.closed) return;
		const has = async (names: string[]) => {
			for (const name of names)
				try {
					await stat(join(p.cwd, name));
					return true;
				} catch {}
			return false;
		};
		const languages: CodeLanguage[] = [];
		if (await has(["tsconfig.json", "jsconfig.json", "package.json"]))
			languages.push("typescript");
		if (
			await has([
				"pyproject.toml",
				"pyrightconfig.json",
				".venv",
				"requirements.txt",
			])
		)
			languages.push("python");
		const javaProjects = await discoverJavaProjects(p.cwd);
		if (javaProjects.maven || javaProjects.gradle) languages.push("java");
		for (const [language, markers] of [
			["go", ["go.mod", "go.work"]],
			["rust", ["Cargo.toml"]],
			["cpp", ["CMakeLists.txt", "compile_commands.json", "compile_flags.txt"]],
		] as const)
			if (await has([...markers])) languages.push(language);
		for (const language of languages)
			try {
				await this.service(p, language);
			} catch {}
		this.changed(p);
	}
	async state(cwd: string): Promise<CodeState> {
		const p = await this.project(cwd);
		if (!p.metadata || Date.now() - (p.metadataAt ?? 0) > 15000) {
			p.metadataAt = Date.now();
			p.metadata = (async () => {
				let projectTsVersion: string | undefined;
				try {
					const pkg = JSON.parse(
						await readFile(join(p.cwd, "package.json"), "utf8"),
					);
					projectTsVersion =
						pkg.dependencies?.typescript ?? pkg.devDependencies?.typescript;
				} catch {}
				return { projectTsVersion, trusted: this.trust(p.cwd) };
			})();
		}
		const { projectTsVersion, trusted } = await p.metadata;

		return {
			cwd: p.cwd,
			settings: { ...p.settings },
			trusted,
			services: [...p.services.values()].map((s) => ({
				...s.state,
				checkedFiles: [...s.docs.values()].filter((d) => d.fresh).length,
				pendingFiles: [...s.docs.values()].filter((d) => !d.fresh).length,
				unconfirmedFiles: [...s.docs.values()].filter(
					(d) => d.fresh && !d.confirmed,
				).length,
			})),
			diagnostics: [...p.services.values()]
				.flatMap((s) => [
					...[...(s.retired?.entries() ?? [])]
						.filter(([path]) => !s.docs.has(path))
						.flatMap(([, diags]) => diags),
					...[...s.docs.values()].flatMap((d) =>
						d.diagnostics.map((diag) => ({
							...diag,
							freshness: d.fresh
								? d.confirmed
									? ("fresh" as const)
									: ("partial" as const)
								: ("stale" as const),
						})),
					),
				])
				.slice(0, 500),
			watcherPartial: p.watcherPartial,
			toolchainVersion: "TS 5.9.3 / Pyright 1.1.414",
			projectTsVersion,
			feedbackWaits: p.waits.slice(-100),
		};
	}
	private changed(p: Project) {
		if (this.closed) return;
		void this.state(p.cwd)
			.then((state) => {
				const serialized = JSON.stringify(state);
				if (this.lastStates.get(p.cwd) === serialized) return;
				this.lastStates.set(p.cwd, serialized);
				for (const listener of this.listeners) listener(state);
			})
			.catch(() => {});
	}
	private async service(p: Project, language: CodeLanguage): Promise<Service> {
		if (this.closed || !p.settings.enabled || !p.settings[language])
			throw new Error("Code intelligence disabled");
		let s = p.services.get(language);
		if (!s) {
			s = {
				state: {
					language,
					status: "idle",
					rssMiB: 0,
					restarts: 0,
					heapMiB:
						language === "typescript"
							? p.settings.tsMemoryMiB
							: language === "python"
								? p.settings.pythonMemoryMiB
								: language === "java" || language === "go"
									? (p.settings.nativeMemoryMiB ?? 1024)
									: 0,
					checkedFiles: 0,
					pendingFiles: 0,
					unconfirmedFiles: 0,
				},
				docs: new Map(),
				generation: 0,
				retries: 0,
				stderr: "",
			};
			p.services.set(language, s);
		}
		if (language !== "typescript" && !this.trust(p.cwd)) {
			s.state.status = "untrusted";
			s.state.error = `${language} requires project trust`;
			this.changed(p);
			throw new Error(s.state.error);
		}
		if (s.connection && s.state.status === "ready") {
			s.used = Date.now();
			return s;
		}
		if (language === "java") {
			const layout = await discoverJavaProjects(p.cwd);
			if (!layout.maven) {
				this.stop(s);
				s.state.status = layout.gradle
					? "unsupported_gradle"
					: "unsupported_java";
				s.state.error = layout.partial
					? "Maven discovery reached its depth/directory limit; open the Maven subproject directly"
					: layout.gradle
						? "Gradle projects are not supported; Java code intelligence currently supports Maven only"
						: "Java code intelligence requires a Maven project (pom.xml within three directory levels)";
				s.retired?.clear();
				this.changed(p);
				throw new Error(s.state.error);
			}
		}

		if (s.state.status === "installing")
			throw new Error("Language tool installation is in progress");
		if (s.starting) {
			await s.starting;
			return s;
		}
		if (s.state.status === "failed" || s.state.status === "oom")
			throw new Error(s.state.error);
		const current = s;
		s.starting = this.startTail.then(() => this.start(p, current));
		this.startTail = s.starting.catch(() => {});
		try {
			await s.starting;
		} finally {
			s.starting = undefined;
		}
		return s;
	}
	private async start(p: Project, s: Service) {
		const active = [...this.projects.values()]
			.flatMap((p) => [...p.services.values()])
			.filter((s) => s.process);
		if (active.length >= 4) {
			const candidate = [...this.projects.values()]
				.flatMap((project) =>
					[...project.services.values()].map((service) => ({
						project,
						service,
					})),
				)
				.filter(
					({ project, service }) =>
						service.process &&
						service.state.status === "ready" &&
						!project.languageUsers?.get(service.state.language) &&
						!service.starting,
				)
				.sort(
					(a, b) =>
						Number(!!a.project.owners.size) - Number(!!b.project.owners.size) ||
						(a.service.used ?? 0) - (b.service.used ?? 0),
				)[0];
			if (candidate) {
				this.stop(candidate.service);
				this.changed(candidate.project);
			} else {
				s.state.status = "queued";
				throw new Error("Language service capacity busy");
			}
		}
		s.state.status = "preparing";
		this.changed(p);
		try {
			if (!isNativeLanguage(s.state.language) && !this.root) {
				this.root = await prepareToolchain(this.dataDir);
				this.lease = await leaseToolchain(this.root);
			}
		} catch (error) {
			s.state.status = "failed";
			s.state.error = String(error);
			this.changed(p);
			throw error;
		}
		if (this.closed || !p.settings.enabled) throw new Error("Service stopped");
		const language = s.state.language;
		if (language !== "typescript" && !this.trust(p.cwd))
			throw new Error(`${language} requires project trust`);
		let command = process.execPath,
			args: string[],
			launchEnv: NodeJS.ProcessEnv = {},
			nativeOptions: Record<string, unknown> = {};
		if (isNativeLanguage(language)) {
			try {
				const launch = await this.nativeTools.launch(
					language,
					p.cwd,
					p.settings,
				);
				command = launch.command;
				args = launch.args;
				launchEnv = launch.env ?? {};
				nativeOptions = launch.initializationOptions ?? {};
			} catch (error) {
				s.state.status =
					error instanceof MissingCodeTool ? "missing" : "failed";
				s.state.error = String(error);
				this.changed(p);
				throw error;
			}
		} else {
			const entry =
				language === "typescript"
					? join(
							this.root!,
							"node_modules/typescript-language-server/lib/cli.mjs",
						)
					: join(this.root!, "node_modules/pyright/dist/pyright-langserver.js");
			args = [
				`--max-old-space-size=${language === "typescript" ? 256 : p.settings.pythonMemoryMiB}`,
				entry,
				"--stdio",
			];
		}

		const generation = ++s.generation;
		s.state.status = "initializing";
		s.state.error = undefined;
		s.stderr = "";
		const child = spawn(command, args, {
			cwd: p.cwd,
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: isNativeLanguage(language) ? undefined : "1",
				...launchEnv,
			},
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		s.process = child;
		const connection = createMessageConnection(
			new StreamMessageReader(child.stdout!),
			new StreamMessageWriter(child.stdin!),
		);
		s.connection = connection;
		const failed = (reason: string, oom = false) => {
			if (s.generation !== generation || this.closed) return;
			s.lastFailure = reason;
			this.stop(s);
			s.state.error = oom
				? `OOM: project too large for ${s.state.heapMiB} MiB heap`
				: reason;
			s.state.status = oom ? "oom" : "failed";
			if (!oom && s.retries < 2) {
				s.retries++;
				s.state.restarts = s.retries;
				s.state.status = "retrying";
				s.restartTimer = setTimeout(() => {
					s.restartTimer = undefined;
					if (!this.closed) {
						s.state.status = "idle";
						void this.service(p, language).catch(() => {});
					}
				}, 500);
			}
			this.changed(p);
		};
		child.stderr?.on("data", (data) => {
			s.stderr = (s.stderr + String(data)).slice(-16000);
			if (
				/heap out of memory|OutOfMemoryError|reached heap limit|allocation failed.*heap/i.test(
					s.stderr,
				)
			)
				failed("Heap exhausted", true);
		});
		child.once("error", (error) => failed(error.message));
		child.once("exit", (code, signal) =>
			failed(
				`Language service exited (${code ?? signal}): ${s.stderr.slice(-1000)}`,
				/heap out of memory|OutOfMemoryError|reached heap limit/i.test(
					s.stderr,
				),
			),
		);
		connection.onNotification(
			"window/logMessage",
			(message: { message?: string }) => {
				const text = message.message ?? "";
				if (
					/heap out of memory|OutOfMemoryError|reached heap limit|allocation failed.*heap/i.test(
						text,
					)
				)
					failed(text, true);
				else if (
					/\[tsserver\].*(?:Exited|exited with error)|tsserver process has exited/.test(
						text,
					)
				)
					failed(text);
			},
		);
		connection.onNotification(
			"textDocument/publishDiagnostics",
			(params: {
				uri: string;
				version?: number;
				diagnostics: {
					range: Location["range"];
					severity?: number;
					message: string;
					code?: string | number;
				}[];
			}) => {
				if (s.generation !== generation || s.state.language === "rust") return;
				let path: string;
				try {
					path = this.inside(p.cwd, fileURLToPath(params.uri));
				} catch {
					return;
				}
				const doc = s.docs.get(path);
				const version = doc?.version,
					hash = doc?.hash;
				if (
					!doc ||
					(params.version !== undefined && params.version !== doc.version)
				)
					return;
				doc.fresh = false;
				doc.confirmed = false;
				clearTimeout(doc.quietTimer);
				const publication = (doc.publication = (doc.publication ?? 0) + 1);
				doc.quietTimer = setTimeout(() => {
					doc.quietTimer = undefined;
					void readFile(join(p.cwd, path), "utf8")
						.then((text) => {
							if (
								s.generation !== generation ||
								s.docs.get(path) !== doc ||
								doc.publication !== publication ||
								doc.version !== version ||
								codeHash(text) !== hash
							)
								return;
							doc.fresh = true;
							doc.confirmed = true;
							doc.diagnostics = params.diagnostics.map((d) => ({
								path,
								line: d.range.start.line + 1,
								column: d.range.start.character + 1,
								endLine: d.range.end.line + 1,
								severity: d.severity ?? 1,
								message: d.message,
								code: d.code === undefined ? undefined : String(d.code),
								freshness: "fresh",
							}));
							this.changed(p);
						})
						.catch(() => {});
				}, 400);
				this.changed(p);
			},
		);
		const settings = serverSettings(language, p.settings);
		connection.onRequest(
			"workspace/configuration",
			(params: { items: { section?: string }[] }) =>
				params.items.map((item) => {
					if (!item.section) return settings;
					return (
						item.section
							.split(".")
							.reduce<unknown>(
								(value, key) =>
									value && typeof value === "object"
										? (value as Record<string, unknown>)[key]
										: undefined,
								settings,
							) ?? {}
					);
				}),
		);
		connection.onRequest("workspace/workspaceFolders", () => [
			{ uri: pathToFileURL(p.cwd).href, name: p.cwd },
		]);

		connection.onRequest("workspace/diagnostic/refresh", () => {
			for (const doc of s.docs.values()) {
				doc.fresh = false;
				doc.confirmed = false;
			}
			this.changed(p);
			return null;
		});
		connection.onRequest("client/registerCapability", () => null);
		connection.onRequest("client/unregisterCapability", () => null);
		connection.onRequest("workspace/applyEdit", () => ({
			applied: false,
			failureReason: "Read-only code intelligence",
		}));
		connection.onRequest("window/workDoneProgress/create", () => null);
		connection.listen();
		try {
			await this.request(
				s,
				"initialize",
				{
					processId: process.pid,
					rootUri: pathToFileURL(p.cwd).href,
					workspaceFolders: [{ uri: pathToFileURL(p.cwd).href, name: p.cwd }],
					capabilities: {
						workspace: {
							configuration: true,
							didChangeWatchedFiles: {
								dynamicRegistration: false,
								relativePatternSupport: true,
							},
						},
						textDocument: {
							publishDiagnostics: { versionSupport: true },
							...(language === "rust"
								? {
										diagnostic: {
											dynamicRegistration: false,
											relatedDocumentSupport: false,
										},
									}
								: {}),
						},
					},
					initializationOptions:
						language === "typescript"
							? {
									disableAutomaticTypingAcquisition: true,
									plugins: [],
									maxTsServerMemory: p.settings.tsMemoryMiB,
									tsserver: {
										path: join(
											this.root!,
											"node_modules/typescript/lib/tsserver.js",
										),
										useSyntaxServer: "never",
										useClientFileWatcher: false,
										logVerbosity: "off",
										logDirectory: join(
											this.dataDir,
											"code-intelligence",
											"logs",
										),
									},
								}
							: {
									...nativeOptions,
									...(language === "java"
										? { settings, bundles: [] }
										: language === "go"
											? (settings.gopls as Record<string, unknown>)
											: language === "rust"
												? (settings["rust-analyzer"] as Record<string, unknown>)
												: {}),
								},
				},
				language === "java" ? 90000 : 20_000,
			);
			if (s.generation !== generation)
				throw new Error(s.state.error ?? "Service replaced");
			await connection.sendNotification("initialized", {});
			await connection.sendNotification("workspace/didChangeConfiguration", {
				settings,
			});
			s.state.status = "ready";
			s.used = Date.now();
			s.stableSince = Date.now();
			if (!p.unwatch)
				p.unwatch = await subscribeProject(p.cwd, (event) => {
					p.watcherPartial = event.partial;
					this.filesChanged(p, event.path);
				});
			this.changed(p);
		} catch (error) {
			if (s.generation === generation) failed(String(error));
			throw error;
		}
	}
	private inside(root: string, path: string) {
		const absolute = resolve(root, path),
			rel = relative(root, absolute);
		if (
			!rel ||
			rel === ".." ||
			rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) ||
			isAbsolute(rel)
		)
			throw new Error("Path outside project");
		return rel.replaceAll("\\", "/");
	}
	async file(cwd: string, path: string) {
		const p = await this.project(cwd);
		const rel = this.inside(p.cwd, path);
		const absolute = await realpath(join(p.cwd, rel));
		this.inside(p.cwd, absolute);
		if ((await stat(absolute)).size > 512 * 1024)
			throw new Error("File exceeds 512 KiB");
		const text = await readFile(absolute, "utf8");
		return { path: rel, text, hash: codeHash(text) };
	}
	private async document(
		p: Project,
		s: Service,
		path: string,
		pullDiagnostics = true,
	) {
		const file = await this.file(p.cwd, path);
		let doc = s.docs.get(file.path);
		const uri = pathToFileURL(join(p.cwd, file.path)).href;
		if (!doc) {
			doc = {
				text: file.text,
				hash: file.hash,
				version: 1,
				used: Date.now(),
				fresh: false,
				confirmed: false,
				diagnostics: [],
			};
			s.docs.set(file.path, doc);
			await s.connection!.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: documentLanguage(file.path),
					version: doc.version,
					text: doc.text,
				},
			});
		} else if (doc.hash !== file.hash) {
			doc.text = file.text;
			doc.hash = file.hash;
			doc.version++;
			clearTimeout(doc.quietTimer);
			doc.quietTimer = undefined;
			doc.confirmed = false;
			doc.fresh = false;
			await s.connection!.sendNotification("textDocument/didChange", {
				textDocument: { uri, version: doc.version },
				contentChanges: [{ text: doc.text }],
			});
		}
		doc.used = Date.now();
		await this.trim(p, s);
		if (s.state.language === "rust" && pullDiagnostics) {
			const version = doc.version,
				hash = doc.hash,
				generation = s.generation,
				publication = (doc.publication = (doc.publication ?? 0) + 1);
			doc.fresh = false;
			doc.confirmed = false;
			const report = (await this.request(
				s,
				"textDocument/diagnostic",
				{ textDocument: { uri } },
				10000,
			).catch((error: unknown) => {
				const code = (error as { code?: number })?.code;
				if (code === -32802 || code === -32801) return { kind: "pending" };
				throw error;
			})) as {
				kind: string;
				items?: {
					range: Location["range"];
					severity?: number;
					message: string;
					code?: string | number;
				}[];
			};
			const current = await this.file(p.cwd, file.path);
			if (
				s.generation === generation &&
				doc.version === version &&
				doc.publication === publication &&
				current.hash === hash &&
				report.kind === "full"
			) {
				doc.diagnostics = (report.items ?? []).map((diagnostic) => ({
					path: file.path,
					line: diagnostic.range.start.line + 1,
					column: diagnostic.range.start.character + 1,
					endLine: diagnostic.range.end.line + 1,
					severity: rustAnalysisLimitation(diagnostic.code, diagnostic.message)
						? 3
						: (diagnostic.severity ?? 1),
					analysisLimitation: rustAnalysisLimitation(
						diagnostic.code,
						diagnostic.message,
					),
					message: diagnostic.message,
					code:
						diagnostic.code === undefined ? undefined : String(diagnostic.code),
					freshness: "fresh",
				}));
				doc.fresh = true;
				doc.confirmed = true;
				this.changed(p);
			}
		}
		return doc;
	}
	private async trim(p: Project, s: Service) {
		let bytes = [...s.docs.values()].reduce(
			(sum, d) => sum + Buffer.byteLength(d.text),
			0,
		);
		for (const [path, doc] of [...s.docs.entries()].sort(
			(a, b) => a[1].used - b[1].used,
		)) {
			if (
				s.docs.size <= 128 &&
				bytes <= 16 * 1024 * 1024 &&
				Date.now() - doc.used < 300000
			)
				break;
			bytes -= Buffer.byteLength(doc.text);
			clearTimeout(doc.quietTimer);
			s.retired ??= new Map();
			s.retired.set(
				path,
				doc.diagnostics
					.slice(0, 100)
					.map((d) => ({ ...d, freshness: "stale" })),
			);
			if (s.retired.size > 128)
				s.retired.delete(s.retired.keys().next().value!);
			s.docs.delete(path);
			await s.connection?.sendNotification("textDocument/didClose", {
				textDocument: { uri: pathToFileURL(join(p.cwd, path)).href },
			});
		}
	}
	private filesChanged(p: Project, path: string) {
		if (path === "package.json") p.metadata = undefined;
		for (const s of p.services.values())
			for (const [file, doc] of s.docs)
				if (!path || path === file) {
					const wasFresh = doc.fresh,
						version = doc.version,
						hash = doc.hash,
						generation = s.generation;
					doc.fresh = false;
					void this.file(p.cwd, file)
						.then((current) => {
							if (
								s.generation === generation &&
								s.docs.get(file) === doc &&
								doc.version === version &&
								doc.hash === hash &&
								current.hash === hash &&
								!doc.quietTimer
							) {
								doc.fresh = doc.fresh || wasFresh;
								this.changed(p);
							}
						})
						.catch(() => {});
					const key = s.state.language + file;
					const old = p.timers.get(key);
					if (old) clearTimeout(old);
					p.timers.set(
						key,
						setTimeout(() => {
							p.timers.delete(key);
							void this.document(p, s, file, false).catch(() => {
								s.docs.delete(file);
								void s.connection?.sendNotification("textDocument/didClose", {
									textDocument: { uri: pathToFileURL(join(p.cwd, file)).href },
								});
							});
						}, 300),
					);
				}

		this.changed(p);
	}
	async baseline(cwd: string, path: string) {
		const p = await this.project(cwd),
			file = await this.file(cwd, path),
			s = p.services.get(languageOf(path) ?? ""),
			doc = s?.docs.get(file.path);
		return doc?.fresh && doc.confirmed && doc.hash === file.hash
			? [...doc.diagnostics]
			: undefined;
	}
	async touch(cwd: string, path: string) {
		const p = await this.project(cwd),
			language = languageOf(path);
		if (!language) return;
		const s = await this.service(p, language);
		await this.document(p, s, path);
		this.changed(p);
	}
	private async request(
		s: Service,
		method: string,
		params: unknown,
		timeout = 5000,
		signal?: AbortSignal,
	): Promise<any> {
		if (!s.connection) throw new Error("Service unavailable");
		const cancellation = new CancellationTokenSource();
		const timer = setTimeout(() => cancellation.cancel(), timeout);
		const abort = () => cancellation.cancel();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			if (signal?.aborted) throw new Error("Cancelled");
			return await Promise.race([
				s.connection.sendRequest(method, params, cancellation.token),
				new Promise((_, reject) => {
					const listener = () =>
						reject(
							new Error(
								signal?.aborted ? "Cancelled" : "Language query timed out",
							),
						);
					cancellation.token.onCancellationRequested(listener);
				}),
			]);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			cancellation.dispose();
		}
	}
	async query(
		cwd: string,
		q: CodeQuery,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (
			!q ||
			!["symbols", "navigate", "read_symbol", "diagnostics"].includes(
				q.action,
			) ||
			(q.operation &&
				!["definition", "references", "hover"].includes(q.operation))
		)
			throw new Error("Invalid code query");
		const p = await this.project(cwd);
		p.used = Date.now();
		if (!p.settings.enabled) throw new Error("Code intelligence disabled");
		const owner = `query-${Date.now()}-${Math.random()}`;
		p.busy.add(owner);
		const protectedLanguages = q.path
			? languageOf(q.path)
				? [languageOf(q.path)!]
				: []
			: [...p.services.values()]
					.filter((s) => s.state.status === "ready")
					.map((s) => s.state.language);
		p.languageUsers ??= new Map();
		for (const language of protectedLanguages)
			p.languageUsers.set(language, (p.languageUsers.get(language) ?? 0) + 1);
		try {
			if (q.action === "diagnostics") {
				if (q.path) {
					if (!languageOf(q.path))
						return {
							freshness: "unavailable",
							checkedFiles: 0,
							diagnostics: [],
							message: "Unsupported file type",
						};
					await this.touch(cwd, q.path);
					const end = Date.now() + 3000;
					const service = p.services.get(languageOf(q.path)!);
					while (
						!service?.docs.get(this.inside(p.cwd, q.path))?.fresh &&
						Date.now() < end &&
						!signal?.aborted
					)
						await new Promise((r) => setTimeout(r, 30));
				}
				if (q.path) {
					const path = this.inside(p.cwd, q.path),
						service = p.services.get(languageOf(path)!),
						doc = service?.docs.get(path);
					return boundedCodeResult({
						freshness:
							!service || service.state.status !== "ready"
								? "unavailable"
								: !doc?.fresh
									? "pending"
									: doc.confirmed
										? "fresh"
										: "partial",
						checkedFiles: doc?.fresh ? 1 : 0,
						coverage:
							service?.state.language === "rust"
								? "Rust native analysis only: no Cargo check, borrow checking, build scripts or proc-macro expansion; macro limitations are informational, not confirmed errors."
								: "Requested opened file only",
						partial: service?.state.language === "rust",
						diagnostics:
							doc?.diagnostics.map((d) => ({
								...d,
								freshness: doc.fresh ? "fresh" : "stale",
							})) ?? [],
					});
				}
				const state = await this.state(cwd);
				return boundedCodeResult({
					freshness: state.services.some((s) => s.pendingFiles)
						? "pending"
						: !state.services.length ||
							  !state.services.some((s) => s.status === "ready")
							? "unavailable"
							: state.watcherPartial ||
								  state.services.some(
										(s) => s.unconfirmedFiles || s.status !== "ready",
								  ) ||
								  state.diagnostics.some((d) => d.freshness === "stale")
								? "partial"
								: "fresh",
					checkedFiles: state.services.reduce((n, s) => n + s.checkedFiles, 0),
					coverage: "Opened and checked files only; not a full project check",
					diagnostics: state.diagnostics.filter(
						(d) => !q.path || d.path === this.inside(p.cwd, q.path),
					),
				});
			}
			const languages = q.path
				? [languageOf(q.path)]
				: p.services.size
					? ([...p.services.keys()] as CodeLanguage[])
					: (["typescript", "python"] as CodeLanguage[]);
			const results: unknown[] = [];
			let incomplete = false;
			for (const language of languages) {
				if (!language) continue;
				let s: Service;
				try {
					s = await this.service(p, language);
				} catch (error) {
					if (q.path) throw error;
					incomplete = true;
					continue;
				}
				if (!q.path) {
					if (q.action !== "symbols") throw new Error("File required");
					const found = (await this.request(
						s,
						"workspace/symbol",
						{ query: q.query ?? "" },
						5000,
						signal,
					)) as SymbolInfo[] | null;
					for (const sym of found ?? [])
						if (sym.location)
							try {
								results.push({
									...sym,
									path: this.inside(p.cwd, fileURLToPath(sym.location.uri)),
									line: sym.location.range.start.line + 1,
								});
							} catch {}
					continue;
				}
				const doc = await this.document(p, s, q.path),
					path = this.inside(p.cwd, q.path),
					uri = pathToFileURL(join(p.cwd, path)).href;
				const requestVersion = doc.hash;
				const ensureCurrent = async () => {
					if ((await this.file(cwd, path)).hash !== requestVersion)
						throw new Error("File version changed during query");
				};
				if (q.expectedVersion && q.expectedVersion !== doc.hash)
					throw new Error("File version changed; query symbols again");
				if (q.action === "symbols") {
					const symbols = await this.request(
						s,
						"textDocument/documentSymbol",
						{ textDocument: { uri } },
						5000,
						signal,
					);
					await ensureCurrent();
					results.push({
						path,
						version: requestVersion,
						symbols: publicCodeLocations(symbols),
					});
					continue;
				}
				const line = (q.line ?? 1) - 1,
					lines = doc.text.split("\n");
				if (!Number.isInteger(line) || line < 0 || line >= lines.length)
					throw new Error("Invalid line");
				let character = (q.column ?? 1) - 1;
				if (q.symbol) {
					const indices = [
						...lines[line].matchAll(
							new RegExp(
								"(?<![\\w$])" +
									q.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
									"(?![\\w$])",
								"g",
							),
						),
					].map((m) => m.index!);
					if (indices.length !== 1)
						return {
							status: indices.length ? "ambiguous" : "not_found",
							path,
							line: line + 1,
							candidates: indices.map((i) => i + 1),
						};
					character = indices[0];
				}
				if (
					!Number.isInteger(character) ||
					character < 0 ||
					character > lines[line].length
				)
					throw new Error("Invalid column");
				if (q.action === "read_symbol") {
					const symbols = (await this.request(
						s,
						"textDocument/documentSymbol",
						{ textDocument: { uri } },
						5000,
						signal,
					)) as SymbolInfo[];
					await ensureCurrent();
					const enclosing: SymbolInfo[] = [];
					const visit = (items: SymbolInfo[]) => {
						for (const item of items ?? []) {
							const range = item.range ?? item.location?.range;
							if (
								range &&
								range.start.line <= line &&
								range.end.line >= line &&
								(!(q.column || q.symbol) ||
									((range.start.line < line ||
										range.start.character <= character) &&
										(range.end.line > line || range.end.character > character)))
							)
								enclosing.push(item);
							if (item.children) visit(item.children);
						}
					};
					visit(symbols ?? []);
					const sym = enclosing.sort(
						(a, b) =>
							(a.range ?? a.location!.range).end.line -
							(a.range ?? a.location!.range).start.line -
							((b.range ?? b.location!.range).end.line -
								(b.range ?? b.location!.range).start.line),
					)[0];
					if (!sym) return { status: "not_found", path };
					const range = sym.range ?? sym.location!.range;
					const text = lines
						.slice(range.start.line, range.end.line + 1)
						.map((text, i) => {
							const index = range.start.line + i;
							const end =
								index === range.end.line ? range.end.character : text.length;
							const start =
								index === range.start.line ? range.start.character : 0;
							return `${index + 1}: ${text.slice(start, end)}`;
						})
						.join("\n");
					results.push({
						path,
						name: sym.name,
						startLine: range.start.line + 1,
						endLine: range.end.line + 1,
						version: requestVersion,
						text,
					});
				} else {
					const method = q.operation ?? "definition";
					const result = await this.request(
						s,
						`textDocument/${method}`,
						{
							textDocument: { uri },
							position: { line, character },
							...(method === "references"
								? { context: { includeDeclaration: true } }
								: {}),
						},
						5000,
						signal,
					);
					await ensureCurrent();
					results.push({
						path,
						version: requestVersion,
						result: publicCodeLocations(result),
					});
				}
			}
			return boundedCodeResult({
				results: results.slice(0, 100),
				partial: incomplete || results.length > 100,
			});
		} finally {
			p.busy.delete(owner);
			for (const language of protectedLanguages) {
				const count = (p.languageUsers?.get(language) ?? 1) - 1;
				if (count) p.languageUsers!.set(language, count);
				else p.languageUsers!.delete(language);
			}
		}
	}
	private stop(s: Service) {
		s.generation++;
		if (s.restartTimer) clearTimeout(s.restartTimer);
		s.restartTimer = undefined;
		s.connection?.dispose();
		s.connection = undefined;
		const child = s.process;
		s.process = undefined;
		if (child?.pid) {
			const pid = child.pid;
			if (process.platform === "win32") {
				const done = new Promise<void>((resolveDone) =>
					execFile(
						"taskkill",
						["/pid", String(pid), "/T", "/F"],
						{ timeout: 10000, windowsHide: true },
						() => resolveDone(),
					),
				);
				this.terminations.add(done);
				void done.finally(() => this.terminations.delete(done));
			} else killPidTree(pid);
		}
		for (const [path, doc] of s.docs) {
			clearTimeout(doc.quietTimer);
			s.retired ??= new Map();
			s.retired.set(
				path,
				doc.diagnostics
					.slice(0, 100)
					.map((d) => ({ ...d, freshness: "stale" })),
			);
		}
		while ((s.retired?.size ?? 0) > 128)
			s.retired!.delete(s.retired!.keys().next().value!);
		s.docs.clear();
		s.tsPid = undefined;
		s.state.rssMiB = 0;
		if (s.state.status !== "failed" && s.state.status !== "oom")
			s.state.status = "idle";
	}
	async restart(cwd: string) {
		const p = await this.project(cwd);
		p.metadata = undefined;
		for (const s of p.services.values()) {
			this.stop(s);
			s.state.heapMiB =
				s.state.language === "typescript"
					? p.settings.tsMemoryMiB
					: s.state.language === "python"
						? p.settings.pythonMemoryMiB
						: s.state.language === "java" || s.state.language === "go"
							? (p.settings.nativeMemoryMiB ?? 1024)
							: 0;
			s.retries = 0;
			s.state.restarts = 0;
			s.state.status = "idle";
			s.state.error = undefined;
		}
		await this.warm(p);
	}
	private async maintenance() {
		if (this.closed || this.maintenanceRunning) return;
		this.maintenanceRunning = true;
		try {
			for (const p of this.projects.values()) {
				for (const s of p.services.values())
					if (s.connection) await this.trim(p, s).catch(() => {});
				for (const s of p.services.values())
					if (s.state.status === "queued" && (p.owners.size || p.busy.size))
						void this.service(p, s.state.language).catch(() => {});
				if (!p.owners.size && !p.busy.size && Date.now() - p.used > 300000)
					for (const s of p.services.values()) this.stop(s);
			}
			// Probe only own service descendants; never terminate an unrelated process.
			const roots = [...this.projects.values()].flatMap((p) =>
				[...p.services.values()]
					.filter((s) => s.process?.pid)
					.map((s) => ({ p, s, pid: s.process!.pid! })),
			);
			if (!roots.length) return;
			const rows = await new Promise<
				{ pid: number; ppid: number; rss: number; command: string }[]
			>((resolveRows) => {
				if (process.platform === "win32")
					execFile(
						"powershell.exe",
						[
							"-NoProfile",
							"-NonInteractive",
							"-Command",
							"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress",
						],
						{ timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
						(error, out) => {
							try {
								const raw = JSON.parse(out);
								resolveRows(
									(Array.isArray(raw) ? raw : [raw]).map((r) => ({
										pid: r.ProcessId,
										ppid: r.ParentProcessId,
										rss: Number(r.WorkingSetSize) / 1024,
										command: r.CommandLine ?? "",
									})),
								);
							} catch {
								resolveRows([]);
							}
						},
					);
				else
					execFile(
						"ps",
						["-axo", "pid=,ppid=,rss=,command="],
						{ timeout: 2000, maxBuffer: 4 * 1024 * 1024 },
						(error, out) =>
							resolveRows(
								error
									? []
									: out.split("\n").flatMap((line) => {
											const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
											return m
												? [
														{
															pid: +m[1],
															ppid: +m[2],
															rss: +m[3],
															command: m[4],
														},
													]
												: [];
										}),
							),
					);
			});
			if (!rows.length) {
				for (const { p, s } of roots) {
					if (s.state.status === "ready" && !s.state.error) {
						s.state.error =
							"Memory probe unavailable; resource sampling will retry";
						this.changed(p);
					}
				}
				return;
			}
			for (const { p, s, pid } of roots) {
				if (s.process?.pid !== pid) continue;
				if (s.state.error?.startsWith("Memory probe unavailable"))
					s.state.error = undefined;
				if (s.stableSince && Date.now() - s.stableSince > 300000) {
					s.retries = 0;
					s.state.restarts = 0;
					s.stableSince = Date.now();
				}
				const ids = new Set([pid]);
				let changed = true;
				while (changed) {
					changed = false;
					for (const r of rows)
						if (ids.has(r.ppid) && !ids.has(r.pid)) {
							ids.add(r.pid);
							changed = true;
						}
				}
				s.state.rssMiB = Math.round(
					rows
						.filter((r) => ids.has(r.pid))
						.reduce((sum, r) => sum + r.rss, 0) / 1024,
				);
				const ts = rows.find(
					(r) => ids.has(r.pid) && r.command.includes("tsserver.js"),
				);
				if (ts) {
					if (s.tsPid && s.tsPid !== ts.pid) {
						s.stableSince = Date.now();
						s.retries++;
						s.state.restarts = s.retries;
						if (s.retries > 2) {
							this.stop(s);
							s.state.status = "failed";
							s.state.error = "tsserver internal recovery budget exceeded";
						}
					}
					s.tsPid = ts.pid;
				}
				this.changed(p);
			}
			let background = roots
				.filter((r) => !r.p.owners.size && !r.p.busy.size)
				.reduce((n, r) => n + r.s.state.rssMiB, 0);
			const budget = Math.min(2048, (totalmem() / 1024 / 1024) * 0.2);
			if (background <= budget) {
				this.overBudgetSince = 0;
				return;
			}
			if (!this.overBudgetSince) {
				this.overBudgetSince = Date.now();
				return;
			}
			if (Date.now() - this.overBudgetSince < 5000) return;
			for (const r of roots
				.filter((r) => !r.p.owners.size && !r.p.busy.size)
				.sort((a, b) => a.p.used - b.p.used)) {
				if (background <= budget) break;
				background -= r.s.state.rssMiB;
				this.stop(r.s);
				this.changed(r.p);
			}
		} finally {
			this.maintenanceRunning = false;
		}
	}
	async install(cwd: string, language: CodeLanguage) {
		if (!isNativeLanguage(language))
			throw new Error("Only native language tools require installation");
		const p = await this.project(cwd),
			owner = `install-${language}`;
		p.busy.add(owner);
		let s = p.services.get(language);
		if (!s) {
			s = {
				state: {
					language,
					status: "idle",
					rssMiB: 0,
					restarts: 0,
					heapMiB:
						language === "java" || language === "go"
							? (p.settings.nativeMemoryMiB ?? 1024)
							: 0,
					checkedFiles: 0,
					pendingFiles: 0,
					unconfirmedFiles: 0,
				},
				docs: new Map(),
				generation: 0,
				retries: 0,
				stderr: "",
			};
			p.services.set(language, s);
		}
		const active = s.state.status === "ready";
		if (!active) {
			s.state.status = "installing";
			s.state.error = undefined;
			this.changed(p);
		}
		try {
			await this.nativeTools.install(language, p.settings.javaHome);
			if (!active) {
				s.state.status = this.trust(p.cwd) ? "idle" : "untrusted";
				s.state.error = undefined;
				s.retries = 0;
				if (this.trust(p.cwd) && p.settings.enabled && p.settings[language])
					await this.service(p, language);
			}
			this.changed(p);
		} catch (error) {
			if (!active) {
				s.state.status = "missing";
				s.state.error = String(error);
				this.changed(p);
			}
			throw error;
		} finally {
			p.busy.delete(owner);
		}
	}

	async shutdown() {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		for (const timer of this.warmTimers.values()) clearTimeout(timer);
		for (const p of this.projects.values()) {
			p.unwatch?.();
			for (const timer of p.timers.values()) clearTimeout(timer);
			for (const s of p.services.values()) this.stop(s);
		}
		await Promise.all([...this.terminations]);
		await this.nativeTools.shutdown();
		this.lease?.();
	}
	async recordWait(cwd: string, elapsed: number) {
		const p = await this.project(cwd);
		p.waits.push(Math.round(elapsed));
		if (p.waits.length > 100) p.waits.shift();
	}
}
let manager: CodeIntelligenceManager | undefined;
export function initializeCode(dataDir: string) {
	if (!manager) {
		manager = new CodeIntelligenceManager(dataDir);
		void cleanupUnusedToolchains(dataDir).catch(() => {});
	}
	return manager;
}
export function codeManager() {
	if (!manager) throw new Error("Code manager not initialized");
	return manager;
}
export const upstreamLens = (path: string) =>
	/(?:^|[/\\])pi-lens(?:[/\\]|$)/.test(path);
