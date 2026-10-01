import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent as NativeEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import type { RpcSessionState, RpcAvailableSlashCommand, RpcExtensionUIRequest, RpcHostToolCallRequest, RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { OmpRpc, type Frame } from "./rpc.js";
import { getAgentDir, ompRuntimePaths, ompWorkerPath } from "./paths.js";
import { SessionManager, type HistorySnapshot } from "./history.js";
import { ModelRuntime } from "./models.js";
import type { ToolDefinition } from "./tools.js";
import { randomUUID } from "node:crypto";
import { projectPrompt, type PromptThumbnails } from "./prompt-content.js";

export type AgentSessionEvent = NativeEvent | RpcSubagentFrame | { type: "session_settled"; messages: AgentMessage[] } | { type: "runtime_error"; error: string } | { type: "command_output"; text: string };
type Metadata = HistorySnapshot & {
	messages: AgentMessage[]; messageRevision: number;
	stats: SessionStats; skills: Skill[]; prompts: PromptTemplate[];
	extensions: Array<{ path: string; resolvedPath: string; packageName?: string; sourceInfo?: { path: string; source: string; scope: string; origin?: string } }>;
	diagnostics: Array<{ path: string; message: string }>;
	tools: string[]; allTools: string[]; defaultSystemPrompt: string;
};
export type SessionOptions = {
	cwd: string; agentDir?: string; sessionManager?: SessionManager; modelRuntime?: ModelRuntime;
	model?: Model; thinkingLevel?: ThinkingLevel; customTools?: ToolDefinition[]; restricted?: boolean;
	systemPrompt?: string; appendSystemPrompt?: string; disabledSkills?: string[]; disabledExtensions?: string[];
};
export type RpcUIHandler = (request: RpcExtensionUIRequest, signal: AbortSignal) => Promise<string | boolean | undefined | null>;

/** Node-side projection of one OMP session. Only the Bun worker owns agent state. */
export class AgentSession {
	readonly sessionManager: SessionManager;
	readonly modelRuntime: ModelRuntime;
	private rpc: OmpRpc;
	private snapshot!: RpcSessionState;
	private metadata!: Metadata;
	private listeners = new Set<(event: AgentSessionEvent) => void>();
	private hostTools = new Map<string, ToolDefinition>();
	private toolGroups = new Map<string, Set<string>>();
	private toolCalls = new Map<string, AbortController>();
	private dialogs = new Map<string, AbortController>();
	private ui?: RpcUIHandler;
	private eventWork: Promise<void> = Promise.resolve();
	private mutations: Promise<void> = Promise.resolve();
	private exclusiveTools: Promise<void> = Promise.resolve();
	private endedMessages: AgentMessage[] = [];
	private promptWaiters = new Map<string, { resolve: (invoked: boolean) => void; reject: (error: Error) => void; invoked?: boolean }>();
	private messageRevision = -1;
	private thumbnails = new Map<string, ImageContent[]>();
	private disposed = false;
	private catalogGeneration: number;
	private levels: ThinkingLevel[] = [];
	commands: RpcAvailableSlashCommand[] = [];
	readonly subagents = new Map<string, { id: string; agent: string; description?: string; status: string }>();
	readonly state: { messages: AgentMessage[]; streamingMessage?: AgentMessage; model?: Model; thinkingLevel?: ThinkingLevel; systemPrompt: string; tools: { name: string; description: string; parameters: unknown }[]; error?: string } = { messages: [], systemPrompt: "", tools: [] };

	private constructor(private options: SessionOptions, modelRuntime: ModelRuntime) {
		this.modelRuntime = modelRuntime;
		this.catalogGeneration = modelRuntime.generation;
		this.sessionManager = options.sessionManager ?? SessionManager.create(options.cwd);
		for (const tool of options.customTools ?? []) this.hostTools.set(tool.name, tool);
		this.rpc = new OmpRpc({ cwd: options.cwd, agentDir: options.agentDir ?? getAgentDir(), executable: ompRuntimePaths().bun, entry: ompWorkerPath("bootstrap"), init: {
			...options, modelRuntime: undefined, customTools: undefined, sessionManager: undefined,
			agentDir: options.agentDir ?? getAgentDir(), sessionPath: this.sessionManager.path,
			sessionMode: this.sessionManager.mode, sessionDir: this.sessionManager.sessionDir, tools: this.toolDefinitions(),
		} });
		this.sessionManager.bind(async (type, fields) => { const result = await this.rpc.request(type, fields); await this.refresh(); return result; });
		this.rpc.subscribe(frame => this.receive(frame));
	}
	static async create(options: SessionOptions): Promise<AgentSession> {
		const session = new AgentSession(options, options.modelRuntime ?? await ModelRuntime.create({ agentDir: options.agentDir }));
		try {
			await session.rpc.start();
			if (!options.restricted) await session.rpc.request("set_host_tools", { tools: session.toolDefinitions() });
			await session.rpc.request("set_subagent_subscription", { level: "progress" });
			await session.refresh();
			return session;
		} catch (error) { await session.dispose(); throw error; }
	}
	get messages(): AgentMessage[] { return this.state.messages; }
	get model(): Model | undefined { return this.state.model; }
	get thinkingLevel(): ThinkingLevel | undefined { return this.state.thinkingLevel; }
	get systemPrompt(): string { return this.state.systemPrompt; }
	get sessionId(): string { return this.snapshot.sessionId; }
	get sessionFile(): string | undefined { return this.snapshot.sessionFile; }
	get isStreaming(): boolean { return !this.disposed && this.snapshot?.isSettled === false; }
	get skills(): Skill[] { return this.metadata.skills; }
	get extensions(): Metadata["extensions"] { return this.metadata.extensions; }
	get promptTemplates(): PromptTemplate[] { return this.metadata.prompts; }
	get defaultSystemPrompt(): string { return this.metadata.defaultSystemPrompt; }
	get diagnostics(): Metadata["diagnostics"] { return this.metadata.diagnostics; }
	getSessionStats(): SessionStats { return { ...this.metadata.stats, contextUsage: this.snapshot.contextUsage }; }
	getAvailableThinkingLevels(): ThinkingLevel[] { return this.levels; }
	getActiveToolNames(): string[] { return this.metadata.tools; }
	getAllToolNames(): string[] { return this.metadata.allTools; }
	getToolDefinition(name: string): ToolDefinition | undefined { return this.hostTools.get(name); }
	getLastAssistantText(): string | undefined {
		const message = this.messages.findLast(m => m.role === "assistant");
		return message?.role === "assistant" ? message.content.filter(p => p.type === "text").map(p => p.text).join("\n") : undefined;
	}
	subscribe(listener: (event: AgentSessionEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	bindUI(handler: RpcUIHandler): void { this.ui = handler; }
	private emit(event: AgentSessionEvent): void { for (const listener of this.listeners) listener(event); }
	private report(error: unknown): void { this.emit({ type: "runtime_error", error: error instanceof Error ? error.message : String(error) }); }
	private receive(frame: Frame): void {
		if (frame.type === "host_tool_call") { void this.executeHostTool(frame as unknown as RpcHostToolCallRequest); return; }
		if (frame.type === "host_tool_cancel" && typeof frame.targetId === "string") { this.toolCalls.get(frame.targetId)?.abort(); return; }
		if (frame.type === "extension_ui_request") { void this.handleUI(frame as unknown as RpcExtensionUIRequest); return; }
		if (frame.type === "runtime_error") {
			if (this.snapshot) this.snapshot.isSettled = true;
			this.state.streamingMessage = undefined;
			for (const call of this.toolCalls.values()) call.abort();
			for (const dialog of this.dialogs.values()) dialog.abort();
			for (const waiter of this.promptWaiters.values()) waiter.reject(new Error(String(frame.error)));
			for (const agent of this.subagents.values()) if (agent.status === "running") agent.status = "failed";
			this.promptWaiters.clear();
			this.report(frame.error); return;
		}
		if (frame.type === "ready" || frame.type === "response" || frame.type === "message_end") return;
		this.eventWork = this.eventWork.then(async () => {
			if (this.disposed) return;
			switch (frame.type) {
				case "available_commands_update": this.commands = frame.commands as RpcAvailableSlashCommand[]; return;
				case "subagent_lifecycle": {
					const { payload } = frame as unknown as Extract<RpcSubagentFrame, { type: "subagent_lifecycle" }>;
					this.subagents.set(payload.id, { id: payload.id, agent: payload.agent, description: payload.description, status: payload.status === "started" ? "running" : payload.status });
					while (this.subagents.size > 100) {
						const finished = [...this.subagents.values()].find(a => a.status !== "running");
						if (!finished) break;
						this.subagents.delete(finished.id);
					}
					break;
				}
				case "subagent_progress": {
					const { payload } = frame as unknown as Extract<RpcSubagentFrame, { type: "subagent_progress" }>;
					this.subagents.set(payload.progress.id, { id: payload.progress.id, agent: payload.agent, description: payload.progress.description ?? payload.task, status: payload.progress.status });
					break;
				}
				case "agent_start": this.snapshot.isSettled = false; break;
				case "message_start": case "message_update": this.state.streamingMessage = frame.message as AgentMessage; break;
				case "webui_message_end": {
					if (Number(frame.messageRevision) > this.messageRevision) {
						this.messageRevision = Number(frame.messageRevision);
						this.state.messages.push(...projectPrompt(frame.message as AgentMessage, this.thumbnails));
					}
					this.state.streamingMessage = undefined;
					this.emit({ ...frame, type: "message_end" } as unknown as AgentSessionEvent); return;
				}
				case "agent_end": this.endedMessages.push(...(frame.messages as AgentMessage[]).flatMap(message => projectPrompt(message, this.thumbnails))); break;
				case "session_settled": {
					await this.refresh();
					const messages = this.endedMessages; this.endedMessages = [];
					for (const [id, pending] of this.promptWaiters) {
						if (pending.invoked !== undefined) { pending.resolve(pending.invoked); this.promptWaiters.delete(id); }
					}
					this.emit({ type: "session_settled", messages }); return;
				}
				case "config_update": case "model_changed": case "thinking_level_changed": await this.refresh(); break;
				case "prompt_result": {
					const pending = frame.id ? this.promptWaiters.get(frame.id) : undefined;
					if (frame.status === "error") {
						const error = new Error((frame.error as { message?: string } | undefined)?.message ?? "OMP prompt failed");
						pending?.reject(error); this.report(error);
						if (frame.id) this.promptWaiters.delete(frame.id);
					} else if (pending) {
						pending.invoked = frame.agentInvoked === true;
						// Agent work completes only at session_settled, including async children.
						if (!pending.invoked || frame.sessionSettled === true) {
							await this.refresh(); pending.resolve(pending.invoked);
							this.promptWaiters.delete(frame.id!);
						}
					}
					return;
				}
			}
			this.emit(frame as unknown as AgentSessionEvent);
		}).catch(error => this.report(error));
	}
	async refresh(): Promise<void> {
		const [snapshot, metadata, levels, commands] = await Promise.all([
			this.rpc.request<RpcSessionState>("get_state"), this.rpc.request<Metadata>("webui_metadata"),
			this.rpc.request<{ levels: ThinkingLevel[] }>("get_available_thinking_levels"),
			this.rpc.request<{ commands: RpcAvailableSlashCommand[] }>("get_available_commands"),
		]);
		this.snapshot = snapshot; this.metadata = metadata; this.levels = levels.levels; this.commands = commands.commands;
		if (metadata.messageRevision >= this.messageRevision) {
			this.thumbnails.clear();
			for (const entry of metadata.entries) if (entry.type === "custom" && entry.customType === "omp-web-thumbnails") {
				const data = entry.data as PromptThumbnails;
				if (typeof data?.id === "string" && Array.isArray(data.images)) this.thumbnails.set(data.id, data.images);
			}
			this.state.messages = metadata.messages.flatMap(message => projectPrompt(message, this.thumbnails));
			this.messageRevision = metadata.messageRevision;
		}
		Object.assign(this.state, { model: snapshot.model, thinkingLevel: snapshot.thinkingLevel, systemPrompt: snapshot.systemPrompt?.join("\n\n") ?? "", tools: snapshot.dumpTools ?? [] });
		this.sessionManager.update({ ...metadata, cwd: this.options.cwd, sessionId: snapshot.sessionId, name: snapshot.sessionName }, snapshot.sessionFile);
	}
	async prompt(text: string, options: { images?: ImageContent[]; thumbnails?: PromptThumbnails; streamingBehavior?: "steer" | "followUp" } = {}): Promise<boolean> {
		await this.mutations;
		await this.refreshModels();
		const { thumbnails, ...nativeOptions } = options;
		if (thumbnails) await this.sessionManager.appendCustomEntry("omp-web-thumbnails", thumbnails);
		const result = await this.rpc.request<{ agentInvoked?: boolean } | undefined>("prompt", { message: text, ...nativeOptions });
		return result?.agentInvoked !== false;
	}
	/** Await the native result for isolated review/wizard jobs. Normal Web sends only await admission. */
	async promptAndWait(text: string): Promise<boolean> {
		await this.mutations;
		await this.refreshModels();
		const id = randomUUID();
		const finished = new Promise<boolean>((resolve, reject) => this.promptWaiters.set(id, { resolve, reject }));
		void finished.catch(() => {});
		try { await this.rpc.request("prompt", { message: text }, 60_000, id); return await finished; }
		finally { this.promptWaiters.delete(id); }
	}
	async sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void> { await this.prompt(text, { streamingBehavior: options?.deliverAs ?? "steer" }); }
	async sendCustomMessage(message: Pick<CustomMessage, "customType" | "content" | "display" | "details">, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		await this.rpc.request("webui_custom_message", { message, options }); await this.refresh();
	}
	async abort(): Promise<void> { await this.rpc.request("abort"); await this.refresh(); }
	async abortBash(): Promise<void> { await this.rpc.request("abort_bash"); }
	async compact(customInstructions?: string): Promise<unknown> { const result = await this.rpc.request("compact", { customInstructions }, 20 * 60_000); await this.refresh(); return result; }
	async reload(): Promise<void> { await this.rpc.request("webui_reload"); await this.refresh(); }
	async setModel(model: Model): Promise<void> { await this.refreshModels(); await this.rpc.request("set_model", { provider: model.provider, modelId: model.id }); await this.refresh(); }
	private async refreshModels(): Promise<void> {
		if (this.isStreaming || this.catalogGeneration === this.modelRuntime.generation) return;
		await this.rpc.request("webui_refresh_models");
		this.catalogGeneration = this.modelRuntime.generation;
	}
	async cycleModel(): Promise<void> { await this.rpc.request("cycle_model"); await this.refresh(); }
	async setThinkingLevel(level: ThinkingLevel | undefined): Promise<void> { await this.rpc.request("set_thinking_level", { level: level ?? "off" }); await this.refresh(); }
	async cycleThinkingLevel(): Promise<void> { await this.rpc.request("cycle_thinking_level"); await this.refresh(); }
	async newSession(): Promise<{ cancelled: boolean }> { const result = await this.rpc.request<{ cancelled: boolean }>("new_session"); if (!result.cancelled) this.subagents.clear(); await this.refresh(); return result; }
	async fork(entryId: string): Promise<{ cancelled: boolean; text: string }> { const result = await this.rpc.request<{ cancelled: boolean; text: string }>("branch", { entryId }); await this.refresh(); return result; }
	setActiveToolsByName(names: string[]): Promise<void> { return this.mutate(async () => { await this.rpc.request("webui_active_tools", { names }); await this.refresh(); }); }
	setToolsEnabled(names: readonly string[], enabled: boolean): Promise<void> { return this.mutate(async () => { await this.rpc.request("webui_toggle_tools", { names, enabled }); await this.refresh(); }); }
	updateHostTools(tools: ToolDefinition[]): Promise<void> {
		return this.mutate(() => this.applyHostTools(tools));
	}
	private async applyHostTools(tools: ToolDefinition[]): Promise<void> {
			if (this.options.restricted) throw new Error("Restricted OMP tools cannot be changed");
			if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("Duplicate OMP host tool name");
			const previous = this.hostTools;
			this.hostTools = new Map(tools.map(tool => [tool.name, tool]));
			try { await this.rpc.request("set_host_tools", { tools: this.toolDefinitions() }); await this.refresh(); }
			catch (error) { this.hostTools = previous; throw error; }
	}
	async replaceHostToolGroup(group: string, tools: ToolDefinition[]): Promise<void> {
		return this.mutate(async () => {
			const previous = this.toolGroups.get(group) ?? new Set<string>();
			const retained = [...this.hostTools.values()].filter(tool => !previous.has(tool.name));
			await this.applyHostTools([...retained, ...tools]);
			this.toolGroups.set(group, new Set(tools.map(tool => tool.name)));
		});
	}
	private mutate(operation: () => Promise<void>): Promise<void> { const work = this.mutations.then(operation); this.mutations = work.catch(error => this.report(error)); return work; }
	private toolDefinitions(): Record<string, unknown>[] { return [...this.hostTools.values()].map(({ name, label, description, parameters }) => ({ name, label, description, parameters, loadMode: "always" })); }
	private async executeHostTool(call: RpcHostToolCallRequest): Promise<void> {
		const controller = new AbortController(); this.toolCalls.set(call.id, controller);
		try {
			const tool = this.hostTools.get(call.toolName);
			if (!tool) throw new Error(`Unknown host tool: ${call.toolName}`);
			const execute = async () => {
				controller.signal.throwIfAborted();
				return tool.execute(call.toolCallId, call.arguments, controller.signal, partialResult => { void this.rpc.send({ type: "host_tool_update", id: call.id, partialResult }).catch(error => this.report(error)); });
			};
			const work = tool.concurrency === "exclusive" ? this.exclusiveTools.then(execute) : execute();
			if (tool.concurrency === "exclusive") this.exclusiveTools = work.then(() => {}, () => {});
			const result = await work;
			await this.rpc.send({ type: "host_tool_result", id: call.id, result });
		} catch (error) {
			await this.rpc.send({ type: "host_tool_result", id: call.id, isError: true, result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } }).catch(() => {});
		} finally { this.toolCalls.delete(call.id); }
	}
	private async handleUI(request: RpcExtensionUIRequest): Promise<void> {
		if (request.method === "cancel") { this.dialogs.get(request.targetId)?.abort(); return; }
		const controller = new AbortController(); this.dialogs.set(request.id, controller);
		try {
			const value = await this.ui?.(request, controller.signal);
			if (["select", "confirm", "input", "editor"].includes(request.method)) await this.rpc.send({ type: "extension_ui_response", id: request.id, ...(value == null ? { cancelled: true } : typeof value === "boolean" ? { confirmed: value } : { value }) });
		} catch { await this.rpc.send({ type: "extension_ui_response", id: request.id, cancelled: true }).catch(() => {}); }
		finally { this.dialogs.delete(request.id); }
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		for (const waiter of this.promptWaiters.values()) waiter.reject(new Error("OMP session closed"));
		this.promptWaiters.clear();
		for (const controller of [...this.toolCalls.values(), ...this.dialogs.values()]) controller.abort();
		await this.rpc.dispose(); this.listeners.clear();
	}
}
