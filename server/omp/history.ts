import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { runOmpAdmin } from "./admin.js";

export type HistorySnapshot = { cwd: string; name?: string; sessionId: string; entries: SessionEntry[]; branch: SessionEntry[]; contextEntries?: SessionEntry[]; leafId: string | null };
/** A read-only projection; the OMP worker is the sole transcript writer. */
export class SessionManager {
	private snapshot: HistorySnapshot;
	private manage?: (operation: string, fields: Record<string, unknown>) => Promise<unknown>;
	constructor(readonly mode: "new" | "recent" | "open" | "memory", cwd: string, public path?: string, readonly sessionDir?: string, readonly agentDir?: string) {
		this.snapshot = { cwd, sessionId: "", entries: [], branch: [], leafId: null };
	}
	static create(cwd: string, sessionDir?: string): SessionManager { return new SessionManager("new", cwd, undefined, sessionDir); }
	static continueRecent(cwd: string, sessionDir?: string): SessionManager { return new SessionManager("recent", cwd, undefined, sessionDir); }
	static inMemory(cwd: string): SessionManager { return new SessionManager("memory", cwd); }
	static async open(path: string, options: { agentDir?: string } = {}): Promise<SessionManager> {
		const snapshot = await runOmpAdmin<HistorySnapshot>("session", { path }, options);
		const manager = new SessionManager("open", snapshot.cwd, path, undefined, options.agentDir);
		manager.snapshot = snapshot;
		return manager;
	}
	static async list(cwd: string, options: { agentDir?: string } = {}): Promise<SessionInfo[]> { return hydrateDates(await runOmpAdmin<SessionInfo[]>("sessions", { cwd }, options)); }
	static async listAll(options: { agentDir?: string } = {}): Promise<SessionInfo[]> { return hydrateDates(await runOmpAdmin<SessionInfo[]>("sessions", { all: true }, options)); }
	bind(manage: (operation: string, fields: Record<string, unknown>) => Promise<unknown>): void { this.manage = manage; }
	update(snapshot: Partial<HistorySnapshot>, path?: string): void { this.snapshot = { ...this.snapshot, ...snapshot }; this.path = path; }
	getCwd(): string { return this.snapshot.cwd; }
	getSessionName(): string | undefined { return this.snapshot.name; }
	getSessionId(): string { return this.snapshot.sessionId; }
	getSessionFile(): string | undefined { return this.path; }
	getEntries(): SessionEntry[] { return this.snapshot.entries; }
	getBranch(): SessionEntry[] { return this.snapshot.branch; }
	getLeafId(): string | null { return this.snapshot.leafId; }
	buildContextEntries(): SessionEntry[] { return this.snapshot.contextEntries ?? this.snapshot.branch; }
	async appendSessionInfo(name: string): Promise<void> {
		if (this.manage) await this.manage("set_session_name", { name });
		else if (this.path) await runOmpAdmin("session", { path: this.path, name }, { agentDir: this.agentDir });
		else throw new Error("OMP session is not attached");
		this.snapshot.name = name;
	}
	async appendCustomEntry(customType: string, data: unknown): Promise<void> {
		if (!this.manage) throw new Error("OMP session is not attached");
		await this.manage("webui_append_entry", { customType, data });
	}
}
function hydrateDates(infos: SessionInfo[]): SessionInfo[] { return infos.map(info => ({ ...info, created: new Date(info.created), modified: new Date(info.modified) })); }
