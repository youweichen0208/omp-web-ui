import type { Model, Context, SimpleStreamOptions, AssistantMessage } from "@oh-my-pi/pi-ai";
import { runOmpAdmin } from "./admin.js";
import { getAgentDir } from "./paths.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Provider = { id: string; name: string; baseUrl?: string; configured: boolean; source?: "stored" | "env" };
type Catalog = { models: Model[]; available: string[]; providers: Provider[] };

/** Cached, secret-free model directory. All credential resolution stays in Bun. */
export class ModelRuntime {
	private catalog: Catalog = { models: [], available: [], providers: [] };
	private loading?: Promise<void>;
	private revision = 0;
	private constructor(readonly agentDir: string) {}
	static async create(options: { agentDir?: string } = {}): Promise<ModelRuntime> {
		const runtime = new ModelRuntime(options.agentDir ?? getAgentDir());
		// Explicit profiles (including tests and remote sessions) must never read
		// credentials from the user's default Pi installation.
		if (!process.env.OMP_WEB_AGENT_DIR && resolve(runtime.agentDir) === join(homedir(), ".omp", "agent")) {
			try {
				await runOmpAdmin("import_pi_models", { sourceDir: join(homedir(), ".pi", "agent") }, { agentDir: runtime.agentDir });
			} catch {
				// Invalid legacy config must not prevent the normal setup UI opening.
				console.warn("[OMP] Pi model import failed; configure models in Settings. Existing files were preserved.");
			}
		}
		await runtime.refresh();
		return runtime;
	}
	get generation(): number { return this.revision; }
	async refresh(options: { allowNetwork?: boolean } = {}): Promise<void> {
		if (this.loading) await this.loading;
		const loading = runOmpAdmin<Catalog>("catalog", { online: options.allowNetwork === true }, { agentDir: this.agentDir }).then(catalog => { this.catalog = catalog; this.revision++; });
		this.loading = loading;
		try { await loading; } finally { if (this.loading === loading) this.loading = undefined; }
	}
	getAvailableSnapshot(): Model[] { const keys = new Set(this.catalog.available); return this.catalog.models.filter(m => keys.has(`${m.provider}/${m.id}`)); }
	async getAvailable(): Promise<Model[]> { if (this.loading) await this.loading; return this.getAvailableSnapshot(); }
	getModels(provider: string): Model[] { return this.catalog.models.filter(m => m.provider === provider); }
	getModel(provider: string, id: string): Model | undefined { return this.catalog.models.find(m => m.provider === provider && m.id === id); }
	getProviders(): Provider[] { return this.catalog.providers; }
	getProvider(id: string): Provider | undefined { return this.catalog.providers.find(p => p.id === id); }
	getRegisteredProviderIds(): string[] { return this.catalog.providers.map(p => p.id); }
	hasConfiguredAuth(id: string): boolean { return this.getProvider(id)?.configured ?? false; }
	getProviderAuthStatus(id: string): { configured: boolean; source?: "stored" | "env" } { const provider = this.getProvider(id); return { configured: provider?.configured ?? false, source: provider?.source }; }
	async setRuntimeApiKey(provider: string, key: string): Promise<void> { await runOmpAdmin("credential_set", { provider, key }, { agentDir: this.agentDir }); }
	async removeRuntimeApiKey(provider: string): Promise<boolean> { return runOmpAdmin("credential_clear", { provider }, { agentDir: this.agentDir }); }
	completeSimple(model: Model, context: Context, options: SimpleStreamOptions = {}): Promise<AssistantMessage> {
		const { signal, ...requestOptions } = options;
		return runOmpAdmin("complete", { provider: model.provider, modelId: model.id, context, options: requestOptions }, { agentDir: this.agentDir, signal });
	}
}
