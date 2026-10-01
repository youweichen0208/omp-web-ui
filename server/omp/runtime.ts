import { AgentSession, type SessionOptions } from "./session.js";
import type { ModelRuntime } from "./models.js";
import type { SessionManager } from "./history.js";

export type RuntimeFactory = (options: { cwd: string; agentDir: string; sessionManager: SessionManager }) => Promise<AgentSession>;

/** Owns one subprocess; changing a Web conversation never interrupts another. */
export class OmpRuntime {
	readonly services: { modelRuntime: ModelRuntime };
	constructor(readonly session: AgentSession, readonly cwd: string) { this.services = { modelRuntime: session.modelRuntime }; }
	newSession(): Promise<{ cancelled: boolean }> { return this.session.newSession(); }
	fork(entryId: string): Promise<{ cancelled: boolean; text: string }> { return this.session.fork(entryId); }
	dispose(): Promise<void> { return this.session.dispose(); }
}
export async function createRuntime(factory: RuntimeFactory, options: { cwd: string; agentDir: string; sessionManager: SessionManager }): Promise<OmpRuntime> {
	return new OmpRuntime(await factory(options), options.cwd);
}
export async function createSession(options: SessionOptions): Promise<{ session: AgentSession }> { return { session: await AgentSession.create(options) }; }
