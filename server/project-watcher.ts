import { watch, type FSWatcher } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
const ignored = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".nuxt",
	".cache",
	".venv",
	"venv",
	"__pycache__",
]);
const excluded = (path: string) =>
	path
		.replaceAll("\\", "/")
		.split("/")
		.some((segment) => ignored.has(segment));
export interface ProjectWatchEvent {
	path: string;
	partial: boolean;
}
export class ProjectWatcher {
	listeners = new Set<(event: ProjectWatchEvent) => void>();
	watchers = new Map<string, FSWatcher>();
	partial = false;
	closed = false;
	private scanning?: Promise<void>;
	private pending = new Set<string>();
	private identities = new Map<string, string>();
	constructor(
		readonly root: string,
		readonly platform = process.platform,
	) {
		void this.start();
	}
	private emit(path: string) {
		if (!excluded(path))
			for (const listener of this.listeners)
				listener({ path, partial: this.partial });
	}
	private async start() {
		if (this.platform === "darwin" || this.platform === "win32") {
			try {
				const watcher = watch(
					this.root,
					{ recursive: true, persistent: false },
					(_event, name) => this.emit(String(name ?? "")),
				);
				watcher.on("error", () => {
					this.partial = true;
					this.emit("");
				});
				this.watchers.set(this.root, watcher);
				return;
			} catch {
				this.partial = true;
			}
		}
		await this.scan();
	}
	private scan(target = this.root): Promise<void> {
		this.pending.add(target);
		if (this.scanning) return this.scanning;
		this.scanning = (async () => {
			let visited = 0;
			while (this.pending.size && !this.closed) {
				const path = this.pending.values().next().value!;
				this.pending.delete(path);
				if (excluded(relative(this.root, path))) continue;
				let info;
				try {
					info = await stat(path);
				} catch {}
				const identity = info?.isDirectory()
					? `${info.dev}:${info.ino}`
					: undefined;
				if (
					!identity ||
					(this.identities.has(path) && this.identities.get(path) !== identity)
				) {
					for (const [watched, watcher] of this.watchers) {
						if (watched === path || watched.startsWith(path + "/")) {
							watcher.close();
							this.watchers.delete(watched);
							this.identities.delete(watched);
						}
					}
				}
				if (!identity) continue;
				if (!this.watchers.has(path)) {
					if (this.watchers.size >= 1024) {
						this.partial = true;
						this.emit("");
						continue;
					}
					try {
						const watcher = watch(
							path,
							{ persistent: false },
							(event, name) => {
								const target = join(path, String(name ?? ""));
								const changed = relative(this.root, target).replaceAll(
									"\\",
									"/",
								);
								this.emit(changed);
								if (event === "rename" || !name) void this.scan(target);
							},
						);
						watcher.on("error", () => {
							watcher.close();
							this.watchers.delete(path);
							this.identities.delete(path);
							this.partial = true;
							this.emit("");
						});
						this.watchers.set(path, watcher);
						this.identities.set(path, identity);
					} catch {
						this.partial = true;
						this.emit("");
						continue;
					}
				}
				try {
					for (const entry of await readdir(path, { withFileTypes: true }))
						if (entry.isDirectory() && !ignored.has(entry.name))
							this.pending.add(join(path, entry.name));
				} catch {}
				if (++visited % 32 === 0)
					await new Promise<void>((done) => setImmediate(done));
			}
		})().finally(() => {
			this.scanning = undefined;
			if (this.pending.size && !this.closed)
				void this.scan(this.pending.values().next().value!);
		});
		return this.scanning;
	}

	close() {
		this.closed = true;
		for (const watcher of this.watchers.values()) watcher.close();
		this.watchers.clear();
	}
}
const projects = new Map<string, ProjectWatcher>();
/** One host watcher per real project, independent of client/session count. */
export async function subscribeProject(
	cwd: string,
	listener: (event: ProjectWatchEvent) => void,
): Promise<() => void> {
	const root = await realpath(cwd);
	let watcher = projects.get(root);
	if (!watcher) {
		watcher = new ProjectWatcher(root);
		projects.set(root, watcher);
	}
	watcher.listeners.add(listener);
	return () => {
		watcher!.listeners.delete(listener);
		if (!watcher!.listeners.size) {
			watcher!.close();
			projects.delete(root);
		}
	};
}
export const projectWatchStats = () =>
	[...projects.values()].map((w) => ({
		cwd: w.root,
		handles: w.watchers.size,
		partial: w.partial,
	}));
