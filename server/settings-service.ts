/** UI preferences and read-only views of the native pi resource loader. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "./protocol.js";
import { extensionKey, type ClientStateStore, type ClientSettings } from "./client-state.js";
import { extensionDisplay } from "./extension-display.js";

export interface SettingsHost {
	clientId: string;
	stateStore: ClientStateStore;
	emit: (message: ServerMessage) => void;
	flushSnapshot: () => void;
	isDisposed: () => boolean;
	getSession: () => AgentSession;
	cwd: () => string;
	agentDir: () => string;
	isStreaming: () => boolean;
	reloadSession: () => Promise<void>;

	effectiveSystemPrompt: () => string;
}

export class SettingsService {
	private settings: ClientSettings;
	private pendingReload = false;

	constructor(private readonly host: SettingsHost) {
		this.settings = host.stateStore.getSettings(host.clientId);
	}

	get current(): ClientSettings { return this.settings; }
	hasPendingReload(): boolean { return this.pendingReload; }
	consumePendingReload(): boolean { const pending = this.pendingReload; this.pendingReload = false; return pending; }

	push(): void {
		let skills: import("./protocol.js").UiSkillInfo[] = [];
		let extensions: import("./protocol.js").UiExtensionInfo[] = [];
		try {
			const loader = this.host.getSession().resourceLoader;
			skills = loader.getSkills().skills.map(skill => ({ name: skill.name, description: skill.description, enabled: true }));
			extensions = loader.getExtensions().extensions.filter(extension => !extension.hidden).map(extension => {
				const path = extension.sourceInfo?.path ?? extension.path;
				return { id: extensionKey(extension), ...extensionDisplay(path, extension.sourceInfo?.origin === "package" ? extension.sourceInfo.source : undefined), path, enabled: true };
			});
		} catch { /* The first session may still be attaching. */ }
		this.host.emit({ type: "settings_state", settings: {
			editResendNewSession: this.settings.editResendNewSession ?? false,
			thinkingWrap: this.settings.thinkingWrap,
			toolsWrap: this.settings.toolsWrap,
			disabledPlugins: this.settings.disabledPlugins ?? [],
			effectiveSystemPrompt: this.host.effectiveSystemPrompt(),
			skills,
			extensions,
		} });
	}

	async set(partial: Partial<ClientSettings>): Promise<void> {
		this.host.stateStore.saveSettings(this.host.clientId, partial);
		this.settings = this.host.stateStore.getSettings(this.host.clientId);
		this.push();
		this.host.flushSnapshot();
	}

	async applyRuntime(): Promise<void> {
		if (this.host.isStreaming()) { this.pendingReload = true; return; }
		await this.host.reloadSession();
		if (this.host.isDisposed()) return;
		this.push();
		this.host.flushSnapshot();
	}
}
