/** Local native Pi session whose only tools operate on one captured SSH connection. */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SettingsManager, SessionManager, type AgentSession, type AgentSessionEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { serializeMessage } from "./serialize.js";
import type { NodeAgentState, UiMessage } from "./protocol.js";

export interface NodeAgentOperations {
	command(command: string, timeout: number, signal?: AbortSignal): Promise<string>;
	read(path: string, signal?: AbortSignal): Promise<string>;
	write(path: string, text: string, signal?: AbortSignal): Promise<void>;
}

export class NodeAgent {
	readonly id = randomUUID();
	private state: NodeAgentState;
	private session?: AgentSession;
	private unsubscribe?: () => void;
	private timer?: ReturnType<typeof setTimeout>;
	private generation = 0;
	private changing = false;
	private promptCancellation?: AbortController;
	private readonly lifetime = new AbortController();
	constructor(private readonly sessionDir: string, cwd: string, private readonly operations: NodeAgentOperations, private readonly changed: (state: NodeAgentState) => void) {
		this.state = { id: this.id, cwd, phase: "starting", running: false, messages: [], tools: [], models: [], dialogs: [] };
	}
	get busy(): boolean { return this.state.phase !== "closed" && (this.state.phase === "starting" || this.state.running || this.changing); }
	snapshot(): NodeAgentState { return this.state; }
	private set(patch: Partial<NodeAgentState>, immediate = false) {
		this.state = { ...this.state, ...patch };
		if (this.timer) { if (!immediate) return; clearTimeout(this.timer); this.timer = undefined; }
		if (immediate) this.changed(this.state);
		else this.timer = setTimeout(() => { this.timer = undefined; this.changed(this.state); }, 60);
	}
	private tools(): ToolDefinition[] {
		const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
		const commandParams = Type.Object({ command: Type.String({ minLength: 1, maxLength: 100000 }), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600, description: "Timeout in seconds (default 120)" })) });
		const readParams = Type.Object({ path: Type.String() });
		const writeParams = Type.Object({ path: Type.String(), text: Type.String() });
		const command: ToolDefinition<typeof commandParams> = {
			name: "remote_command", label: "SSH command",
			description: `Execute a shell command on this SSH node. Each command starts in ${JSON.stringify(this.state.cwd)}; use cd explicitly within a command to change directories. This is an independent exec channel, not the user's interactive terminal. Output is limited to 64 KiB.`,
			parameters: commandParams,
			execute: async (_id, p, signal) => ({ content: [{ type: "text", text: await this.operations.command(p.command, p.timeout ?? 120, signalFor(signal)) }], details: undefined }),
		};
		const read: ToolDefinition<typeof readParams> = {
			name: "remote_read", label: "SSH read", description: "Read a UTF-8 file on this SSH node via SFTP (up to 512 KiB). Path must be absolute.", parameters: readParams,
			execute: async (_id, p, signal) => ({ content: [{ type: "text", text: await this.operations.read(p.path, signalFor(signal)) }], details: undefined }),
		};
		const write: ToolDefinition<typeof writeParams> = {
			name: "remote_write", label: "SSH write", description: "Write a UTF-8 file on this SSH node via SFTP (up to 512 KiB). Path must be absolute. Existing content is replaced.", parameters: writeParams,
			execute: async (_id, p, signal) => { await this.operations.write(p.path, p.text, signalFor(signal)); return { content: [{ type: "text", text: "文件已写入节点" }], details: undefined }; },
		};
		return [command, read, write];
	}
	private async create(fresh: boolean) {
		const generation = ++this.generation;
		mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
		const agentDir = getAgentDir();
		const settings = SettingsManager.create(this.sessionDir, agentDir);
		const loader = new DefaultResourceLoader({ cwd: this.sessionDir, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
			systemPrompt: `You are the assistant for one connected SSH node. All provided tools operate only on that node. Remote working directory: ${JSON.stringify(this.state.cwd)}. Use remote_command, remote_read and remote_write for node tasks. Commands run with the SSH user's permissions. You have no local filesystem or local shell tools. Ask before destructive operations when the user has not authorized them. Never assume a previous command's cd persists.`, appendSystemPrompt: [] });
		await loader.reload();
		const { session } = await createAgentSession({ cwd: this.sessionDir, agentDir, resourceLoader: loader, settingsManager: settings,
			sessionManager: fresh ? SessionManager.create(this.sessionDir, this.sessionDir) : SessionManager.continueRecent(this.sessionDir, this.sessionDir),
			model: this.session?.model, noTools: "all", tools: ["remote_command", "remote_read", "remote_write"], excludeTools: ["mcp__*"], customTools: this.tools() });
		if (this.state.phase === "closed" || generation !== this.generation) { session.dispose(); throw new Error("节点 Agent 已关闭"); }
		this.unsubscribe?.(); this.session?.dispose();
		this.session = session;
		this.unsubscribe = session.subscribe(event => { if (this.session === session && this.state.phase !== "closed") this.event(event); });
		this.refresh();
		this.set({ phase: "ready", running: false, error: undefined, tools: [], streamingMessage: undefined }, true);
	}
	async start() {
		try { await this.create(false); }
		catch (error) { if (this.state.phase !== "closed") { this.set({ error: (error as Error).message }); this.close(); } throw error; }
	}
	close() {
		if (this.state.phase === "closed") return;
		this.generation++; this.lifetime.abort();
		this.unsubscribe?.(); this.unsubscribe = undefined;
		const session = this.session; this.session = undefined;
		if (session) void session.abort().catch(() => {}).finally(() => session.dispose());
		this.set({ phase: "closed", running: false, streamingMessage: undefined, dialogs: [], tools: this.state.tools.map(tool => ({ ...tool, running: false })) }, true);
	}
	private ready(): AgentSession {
		if (this.state.phase !== "ready" || !this.session || this.changing) throw new Error("节点 Agent 尚未就绪");
		return this.session;
	}
	private retain(messages: UiMessage[]): UiMessage[] {
		let bytes = 0, start = messages.length;
		while (start > 0 && messages.length - start < 200) {
			const size = Buffer.byteLength(JSON.stringify(messages[start - 1]));
			if (start < messages.length && bytes + size > 4 * 1024 * 1024) break;
			bytes += size; start--;
		}
		return messages.slice(start);
	}
	private refresh() {
		const session = this.session;
		if (!session) return;
		this.set({ messages: this.retain(session.messages.slice(-200).map((message, index) => serializeMessage(message, Math.max(0, session.messages.length - 200) + index)).filter((message): message is UiMessage => !!message)),
			model: session.model ? { id: session.model.id, provider: session.model.provider, name: session.model.name } : undefined,
			models: session.modelRuntime.getAvailableSnapshot().map(model => ({ id: model.id, provider: model.provider, name: model.name })) });
	}
	async prompt(text: string, queue?: "steer" | "followUp") {
		const session = this.ready();
		if (!text.trim() || text.length > 200000) throw new Error("消息无效");
		if (!session.model) throw new Error("请先在本机设置中配置模型，再重新打开节点 Agent");
		if (this.state.running) {
			if (!queue || !session.isStreaming) throw new Error("节点 Agent 正在处理请求，请稍后或排队发送");
			await session.prompt(text, { streamingBehavior: queue, expandPromptTemplates: false }); return;
		}
		this.set({ running: true, error: undefined, tools: [] }, true);
		const cancellation = new AbortController();
		this.promptCancellation = cancellation;
		const signal = AbortSignal.any([cancellation.signal, this.lifetime.signal]);
		await new Promise<void>((resolve, reject) => {
			void session.prompt(text, { expandPromptTemplates: false, preflightResult: disposition => {
				// Abort during asynchronous auth/compaction must prevent a later model call.
				signal.throwIfAborted();
				if (disposition !== "started" && !session.isStreaming) this.set({ running: false });
				resolve();
			} }).catch(error => {
				reject(error);
				if (this.session === session && this.state.phase !== "closed" && this.promptCancellation === cancellation) {
					this.refresh(); this.set({ running: false, error: signal.aborted ? undefined : (error as Error).message }, true);
				}
			});
		});
	}
	async abort() {
		const session = this.ready();
		this.promptCancellation?.abort();
		await session.abort();
		if (this.session === session && this.state.phase === "ready") this.set({ running: false }, true);
	}
	async newSession() {
		this.ready(); if (this.busy) throw new Error("请先停止当前任务");
		this.changing = true;
		try { await this.create(true); } finally { this.changing = false; }
	}
	async model(provider: string, modelId: string) {
		const session = this.ready(); if (this.busy) throw new Error("请先停止当前任务");
		const model = session.modelRuntime.getAvailableSnapshot().find(model => model.provider === provider && model.id === modelId);
		if (!model) throw new Error("本机模型不可用");
		this.changing = true;
		try { await session.setModel(model, { persist: false }); if (this.session === session) this.refresh(); } finally { this.changing = false; }
	}
	dialog(_id: string, _response: { cancelled?: boolean; value?: string; confirmed?: boolean }) { throw new Error("节点对话框已过期"); }
	private event(event: AgentSessionEvent) {
		if (["agent_start", "compaction_start", "auto_retry_start"].includes(event.type)) this.set({ running: true });
		if (event.type === "message_start" && event.message.role === "assistant") this.set({ streamingMessage: serializeMessage(event.message, this.session!.messages.length) ?? undefined });
		if (event.type === "message_update") this.set({ streamingMessage: serializeMessage(event.message, this.session!.messages.length) ?? undefined });
		if (event.type === "message_end") { this.refresh(); if (event.message.role === "assistant") this.set({ streamingMessage: undefined }); }
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") this.set({ tools: [...this.state.tools.filter(tool => tool.id !== event.toolCallId), { id: event.toolCallId, name: event.toolName, running: event.type === "tool_execution_start", isError: event.type === "tool_execution_end" && event.isError }].slice(-256) });
		if (event.type === "agent_settled") { this.refresh(); this.set({ running: false, streamingMessage: undefined }, true); }
	}
}
