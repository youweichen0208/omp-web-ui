import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PlanSettingsState } from "../protocol.js";

/** One service instance preference. Sessions only hold their effective loadout. */
export class PlanSettings {
	readonly path: string;
	enabled = true;
	constructor(dataDir = resolve(process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"))) {
		this.path = join(dataDir, "plan-settings.json");
		try {
			const saved = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof saved.enabled === "boolean") this.enabled = saved.enabled;
		} catch { /* Missing or invalid preference: default on. */ }
	}
	set(enabled: boolean) {
		mkdirSync(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify({ enabled }) + "\n", { mode: 0o600 });
		renameSync(temporary, this.path);
		this.enabled = enabled;
	}
	state(session: AgentSession): PlanSettingsState {
		const tool = session.getAllTools().find(tool => tool.name === "plan");
		const available = !!tool && ["builtin:pi-harness-plan", "<inline:pi-harness-plan>"].includes(tool.sourceInfo.path);
		const effective = available && session.getActiveToolNames().includes("plan");
		return { enabled: this.enabled, available, effective, pending: available && effective !== this.enabled, ...(!available ? { reason: tool ? "conflict" as const : "missing" as const } : {}) };
	}
	coordinate(session: AgentSession, writable: boolean): void {
		const state = this.state(session);
		if (!state.available || !state.pending || !session.isIdle || !writable) return;
		const active = session.getActiveToolNames().filter(name => name !== "plan");
		if (this.enabled) active.push("plan");
		session.setActiveToolsByName(active);
	}
}
let shared: PlanSettings | undefined;
export const planSettings = () => shared ??= new PlanSettings();
