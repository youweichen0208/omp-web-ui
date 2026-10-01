import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderAuthState, ServerMessage } from "./protocol.js";

type Interaction = Parameters<ModelRuntime["login"]>[2];

/** Bridge official provider login; credentials remain entirely inside ModelRuntime. */
export class ProviderAuthService {
	private controller?: AbortController;
	private pending?: { id: string; resolve: (value: string) => void };
	private state: ProviderAuthState | null = null;
	constructor(private readonly runtime: () => ModelRuntime, private readonly emit: (message: ServerMessage) => void, private readonly changed: () => Promise<void>, private readonly getDeviceId: () => string) {}
	replay(): void { if (this.state) this.emit({ type: "provider_auth", state: this.state }); }
	respond(requestId: string, promptId: string, value: string): void {
		if (this.state?.requestId === requestId && this.pending?.id === promptId) this.pending.resolve(value);
	}
	cancel(requestId?: string): void {
		if (!requestId || this.state?.requestId === requestId) this.controller?.abort();
	}
	async logout(provider: string): Promise<void> {
		this.cancel();
		try { await this.runtime().logout(provider); await this.changed(); }
		catch (error) { this.emit({ type: "notice", level: "error", text: error instanceof Error ? error.message : "Sign-out failed" }); }
	}
	private publish(state: ProviderAuthState): void { this.state = state; this.emit({ type: "provider_auth", state }); }
	async login(provider: string): Promise<void> {
		this.cancel();
		const requestId = randomUUID(), controller = new AbortController();
		this.controller = controller;
		const signal = controller.signal;
		const current = () => this.state?.requestId === requestId;
		const update = (partial: Partial<ProviderAuthState>) => { if (current()) this.publish({ ...this.state!, ...partial }); };
		this.publish({ requestId, provider, phase: "pending" });
		const deadline = setTimeout(() => controller.abort(), 10 * 60_000); deadline.unref();
		const interaction: Interaction = {
			signal,
			notify: event => {
				if (event.type === "auth_url") update({ url: event.url, message: event.instructions });
				else if (event.type === "device_code") update({ url: event.verificationUri, code: event.userCode });
				else update({ message: event.message, ...(event.type === "info" && event.links?.length ? { url: event.links[0].url } : {}) });
			},
			prompt: prompt => new Promise((resolve, reject) => {
				const promptId = randomUUID();
				const combined = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
				const finish = (value?: string) => {
					combined.removeEventListener("abort", abort);
					if (this.pending?.id === promptId) this.pending = undefined;
					if (current() && this.state?.prompt?.id === promptId) update({ prompt: undefined });
					if (value === undefined) reject(new DOMException("Login cancelled", "AbortError")); else resolve(value);
				};
				const abort = () => finish();
				if (combined.aborted) { abort(); return; }
				this.pending = { id: promptId, resolve: value => finish(value) };
				combined.addEventListener("abort", abort, { once: true });
				update({ prompt: { id: promptId, kind: prompt.type, message: prompt.message, ...(prompt.type === "select" ? { options: prompt.options.map(({ id, label }) => ({ id, label })) } : { placeholder: prompt.placeholder }) } });
			}),
		};
		try {
			if (!this.runtime().getProvider(provider)?.auth.oauth) throw new Error("Provider does not support OAuth login");
			await this.runtime().login(provider, "oauth", interaction, { getDeviceId: this.getDeviceId });
			await this.changed();
			update({ phase: "success", url: undefined, code: undefined, prompt: undefined, message: undefined });
		} catch (error) {
			update({ phase: signal.aborted ? "cancelled" : "error", message: signal.aborted ? undefined : error instanceof Error ? error.message : "Login failed", url: undefined, code: undefined, prompt: undefined });
		} finally { clearTimeout(deadline); if (this.controller === controller) this.controller = undefined; }
	}
}
