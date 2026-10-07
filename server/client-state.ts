/** Per-client UI preferences and project/session navigation, persisted best-effort. */
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./private-file.js";
import { dirname } from "node:path";
import type { ProjectSummary } from "./protocol.js";

/** Display-only settings; native agent configuration is managed by Pi. */
export interface ClientSettings {
	editResendNewSession?: boolean;
	thinkingWrap: boolean;
	toolsWrap: boolean;
	disabledPlugins?: string[];
}

/** Stable identity of an extension for its read-only resource view: the npm
 *  spec for packages (survives version bumps), the resolved entry path
 *  otherwise. */
export function extensionKey(e: {
	sourceInfo?: { origin?: string; source?: string; path?: string };
	path: string;
}): string {
	const src = e.sourceInfo;
	if (src?.origin === "package" && src.source) return src.source;
	return src?.path ?? e.path;
}

/** Upper bound on persisted client entries (see ClientStateStore.prune). */
const MAX_CLIENT_ENTRIES = 200;

export interface ClientState {
	/** ms epoch of the last write for this client; drives pruning of stale entries. */
	seen?: number;
	/** Absolute path of the workspace this client last used. */
	lastCwd?: string;
	/** Workspaces this client opened before, most-recently-used first (capped
	 *  at 30). Opening/switching moves an entry to the front. */
	projects: { path: string; lastUsed: number; firstAdded?: number }[];


	settings?: ClientSettings;

	/** Conversations that were STILL STREAMING when the server last shut down
	 *  (SIGTERM / self-update restart). Consumed once on the next attach so
	 *  the user learns a run was lost instead of wondering where it went. */
	interrupted?: { title: string; cwd: string; at: number }[];
	/** Workspaces the user explicitly removed from the recent list. Kept as
	 *  tombstones so cwds re-discovered from session files stay hidden until
	 *  the workspace is opened again. */
	removedProjects?: string[];
}

/** Disk-side project facts discovered from session files (aggregated per cwd). */
export interface DiskProjectSummary {
	path: string;
	/** Newest session activity in this cwd (ms epoch) — informational. */
	lastUsed: number;
	/** Earliest session creation in this cwd (ms epoch) — the first-added
	 *  anchor for projects that have no persisted entry. */
	firstAdded: number;
	conversationCount: number;
}

/**
 * Merge persisted projects with disk-discovered ones into the project list:
 * ordered by latest use/activity, newest first. Persisted first-added values
 * remain as stable tie-breakers and for legacy data migration.
 * Tombstoned entries (explicitly removed by the user) stay hidden; the list is
 * capped at 20, dropping the least recently used first.
 */
export function mergeProjectSummaries(
	saved: { path: string; lastUsed: number; firstAdded?: number }[],
	disk: readonly DiskProjectSummary[],
	removed: ReadonlySet<string>,
): ProjectSummary[] {
	const firstAdded = new Map<string, number>();
	const lastUsed = new Map<string, number>();
	for (const p of saved) {
		firstAdded.set(p.path, p.firstAdded ?? p.lastUsed);
		lastUsed.set(p.path, p.lastUsed);
	}
	for (const p of disk) {
		if (!firstAdded.has(p.path)) firstAdded.set(p.path, p.firstAdded);
		lastUsed.set(p.path, Math.max(lastUsed.get(p.path) ?? 0, p.lastUsed));
	}
	const byPath = new Map(disk.map((p) => [p.path, p]));
	return [...firstAdded.entries()]
		.filter(([path]) => !removed.has(path))
		.map(([path, added]) => ({
			path,
			firstAdded: added,
			lastUsed: lastUsed.get(path) ?? 0,
			lastConversationAt: byPath.get(path)?.lastUsed,
			conversationCount: byPath.get(path)?.conversationCount ?? 0,
		}))
		.sort((a, b) => b.lastUsed - a.lastUsed || b.firstAdded - a.firstAdded)
		.slice(0, 20);
}

/**
 * Persists which workspace each browser client last used + which workspaces it
 * has opened, so a server restart / page reload restores the same project and
 * the UI can offer a one-click recent-project list. File I/O is best-effort:
 * persistence problems must never crash the server or block a session.
 */
export class ClientStateStore {
	private cache: Record<string, ClientState> | null = null;

	constructor(private filePath: string) {}

	private load(): Record<string, ClientState> {
		if (this.cache) return this.cache;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<
				string,
				ClientState
			>;
			this.cache = parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	/** Get or create a client's entry and stamp it as recently used. */
	private entry(clientId: string): ClientState {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.seen = Date.now();
		return state;
	}

	/** Browser tabs are a new clientId each; keep the file bounded by dropping the
	 *  least recently used entries (the desktop app's stable id stays near the top). */
	private prune(): void {
		const all = this.cache;
		if (!all) return;
		const ids = Object.keys(all);
		if (ids.length <= MAX_CLIENT_ENTRIES) return;
		const lastSeen = (state: ClientState) => state.seen ?? Math.max(0, ...(state.projects ?? []).map((p) => p.lastUsed));
		ids.sort((a, b) => lastSeen(all[b]) - lastSeen(all[a]));
		for (const id of ids.slice(MAX_CLIENT_ENTRIES)) delete all[id];
	}

	private save(): void {
		this.prune();
		try {
			// Atomic write (tmp + rename): a crash mid-write must never leave a
			// half-written JSON — that would wipe ALL persisted state (recent
			// projects and display settings) on next load. 0600: it lists the
			// user's project paths.
			writeFileAtomic(this.filePath, JSON.stringify(this.cache, null, 2) + "\n");
		} catch {
			// best effort
		}
	}

	get(clientId: string): ClientState {
		return this.load()[clientId] ?? { projects: [] };
	}

	/** Freeze the order anchors of projects discovered from old session files as
	 *  soon as they are shown. Selecting one later must not make it "new". */
	rememberDisplayedProjects(clientId: string, projects: readonly ProjectSummary[]): void {
		const state = this.entry(clientId);
		const known = new Set(state.projects.map((p) => p.path));
		let changed = false;
		for (const project of projects) {
			if (known.has(project.path)) continue;
			state.projects.push({ path: project.path, lastUsed: project.lastUsed, firstAdded: project.firstAdded });
			known.add(project.path);
			changed = true;
		}
		if (changed) {
			state.projects.sort((a, b) => b.lastUsed - a.lastUsed || (b.firstAdded ?? 0) - (a.firstAdded ?? 0));
			state.projects = state.projects.slice(0, 30);
			this.save();
		}
	}

	/** Remember which workspace a client last used and move it to the front. */
	remember(clientId: string, cwd: string): void {
		const state = this.entry(clientId);
		state.lastCwd = cwd;
		// Distinct clicks can share one millisecond; keep ordering deterministic.
		const now = Math.max(Date.now(), ...state.projects.map((project) => project.lastUsed + 1));
		const existing = state.projects.find((p) => p.path === cwd);
		if (existing) {
			// Keep the historical first-added value as a deterministic tie-breaker.
			existing.firstAdded ??= existing.lastUsed;
			existing.lastUsed = now;
		} else {
			state.projects.push({ path: cwd, lastUsed: now, firstAdded: now });
		}
		state.projects.sort((a, b) => b.lastUsed - a.lastUsed || (b.firstAdded ?? 0) - (a.firstAdded ?? 0));
		state.projects = state.projects.slice(0, 30);
		// Opening the workspace again clears its removal tombstone.
		if (state.removedProjects?.length) {
			state.removedProjects = state.removedProjects.filter((p) => p !== cwd);
		}
		this.save();
	}

	/** Drop one workspace from the recent-project list (user-requested removal).
	 *  Records a tombstone too: pushProjects() re-discovers cwds from session
	 *  files on every listing, so without it the entry would instantly reappear. */
	removeProject(clientId: string, cwd: string): void {
		const state = this.entry(clientId);
		state.projects = state.projects.filter((p) => p.path !== cwd);
		if (state.lastCwd === cwd) delete state.lastCwd;
		const removed = new Set(state.removedProjects ?? []);
		removed.add(cwd);
		state.removedProjects = [...removed];
		this.save();
	}

	/** Tombstoned projects (explicitly removed by the user) for filtering the
	 *  merged recent-project list. */
	getRemovedProjects(clientId: string): string[] {
		return this.load()[clientId]?.removedProjects ?? [];
	}

	/** Remember conversations that were still streaming at shutdown (best-
	 *  effort; called during the graceful-shutdown path). */
	saveInterrupted(
		clientId: string,
		list: { title: string; cwd: string; at: number }[],
	): void {
		if (list.length === 0) return;
		const state = this.entry(clientId);
		state.interrupted = list.slice(0, 8);
		this.save();
	}

	/** Consume the interrupted-conversation record (returns and clears it) —
	 *  called once on the client's first attach after a restart. */
	takeInterrupted(clientId: string): ClientState["interrupted"] {
		const all = this.load();
		const state = all[clientId];
		const list = state?.interrupted;
		if (list?.length && state) {
			delete state.interrupted;
			this.save();
		}
		return list;
	}

	/** Last-used settings-panel state for a client, or defaults. */
	getSettings(clientId: string): ClientSettings {
		const settings = this.load()[clientId]?.settings;
		return { editResendNewSession: settings?.editResendNewSession ?? false, thinkingWrap: settings?.thinkingWrap ?? false, toolsWrap: settings?.toolsWrap ?? true, disabledPlugins: settings?.disabledPlugins ?? [] };
	}

	/** Persist the client's settings-panel state (partial merge). */
	saveSettings(clientId: string, partial: Partial<ClientSettings>): void {
		const state = this.entry(clientId);
		const current = this.getSettings(clientId);
		state.settings = { editResendNewSession: partial.editResendNewSession ?? current.editResendNewSession ?? false, thinkingWrap: partial.thinkingWrap ?? current.thinkingWrap, toolsWrap: partial.toolsWrap ?? current.toolsWrap, disabledPlugins: partial.disabledPlugins ?? current.disabledPlugins };
		this.save();
	}

}
