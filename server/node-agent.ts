/** Native Pi RPC over one SSH exec channel. No local model or terminal injection. */
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ClientChannel } from "ssh2";
import { serializeMessage, type AgentMessage } from "./serialize.js";
import type { NodeAgentState, UiMessage, UiContentBlock } from "./protocol.js";

const MAX_RECORD = 16 * 1024 * 1024;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
export function nodeAgentCommand(cwd: string): string {
	if (!cwd.startsWith("/") || /[\0\r\n]/.test(cwd) || cwd.length > 4096) throw new Error("Invalid remote working directory");
	return `sh -lc ${quote(`cd ${quote(cwd)} && exec pi --mode rpc`)}`;
}

type RecordValue = Record<string, any>;
export class NodeAgent {
	readonly id = randomUUID();
	private buffer = "";
	private decoder = new StringDecoder("utf8");
	private stderr = "";
	private seq = 0;
	private revision = 0;
	private dialogTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private timer?: ReturnType<typeof setTimeout>;
	private pending = new Map<string, { resolve: (data: RecordValue) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private state: NodeAgentState;
	constructor(private stream: ClientChannel, cwd: string, private changed: (state: NodeAgentState) => void) {
		this.state = { id: this.id, cwd, phase: "starting", running: false, messages: [], tools: [], models: [], dialogs: [] };
		stream.on("data", (data: Buffer | string) => this.receive(this.decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data))));
		stream.stderr.on("data", data => { this.stderr = (this.stderr + data.toString()).slice(-8000); });
		stream.on("error", (error: Error) => this.finish(error.message));
		stream.on("close", () => this.finish(this.stderr || "Remote Pi exited"));
	}
	get busy(): boolean { return this.state.phase !== "closed" && (this.state.phase === "starting" || this.state.running || this.pending.size > 0 || this.state.dialogs.length > 0); }
	snapshot(): NodeAgentState { return this.state; }
	private publish(immediate = false) {
		if (this.timer) { if (!immediate) return; clearTimeout(this.timer); this.timer = undefined; }
		if (immediate) this.changed(this.state);
		else this.timer = setTimeout(() => { this.timer = undefined; this.changed(this.state); }, 60);
	}
	private set(patch: Partial<NodeAgentState>, immediate = false) { this.state = { ...this.state, ...patch }; this.publish(immediate); }
	private finish(error?: string) {
		if (this.state.phase === "closed") return;
		for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error(error || "Remote Pi closed")); }
		this.pending.clear();
		for (const timer of this.dialogTimers.values()) clearTimeout(timer); this.dialogTimers.clear();
		this.set({ phase: "closed", running: false, dialogs: [], error }, true);
	}
	close() {
		this.finish();
		try { this.stream.signal("TERM"); } catch { /* SSH may already be gone. */ }
		this.stream.end(); this.stream.destroy();
	}
	private receive(chunk: string) {
		if (this.state.phase === "closed") return;
		this.buffer += chunk;
		let index: number;
		while ((index = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
			if (line.length > MAX_RECORD) { this.finish("Remote Pi response exceeds 16 MiB"); this.close(); return; }
			if (!line.trim()) continue;
			try { this.event(JSON.parse(line)); }
			catch (error) { this.finish(`Invalid remote Pi RPC response: ${(error as Error).message}`); this.close(); return; }
		}
		if (this.buffer.length > MAX_RECORD) { this.finish("Remote Pi response exceeds 16 MiB"); this.close(); }
	}
	private request(type: string, fields: RecordValue = {}): Promise<RecordValue> {
		if (this.state.phase === "closed") return Promise.reject(new Error("Remote Pi is not running"));
		if (this.pending.size >= 32) return Promise.reject(new Error("Too many pending remote commands"));
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Remote Pi ${type} timed out`)); }, 30000);
			this.pending.set(id, { resolve, reject, timer });
			try { this.stream.write(JSON.stringify({ ...fields, id, type }) + "\n"); }
			catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
		});
	}
	async start() {
		try {
			await this.refresh();
			const available = await this.request("get_available_models");
			this.set({ phase: "ready", models: (available.models ?? []).map((m: RecordValue) => ({ id: String(m.id), provider: String(m.provider), name: String(m.name ?? m.id) })) }, true);
		} catch (error) { this.finish(`${(error as Error).message}${this.stderr ? `\n${this.stderr}` : ""}`); this.close(); throw error; }
	}
	private retainMessages(messages: UiMessage[]): UiMessage[] {
		let bytes = 0, start = messages.length;
		while (start > 0 && messages.length - start < 200) {
			const size = Buffer.byteLength(JSON.stringify(messages[start - 1]));
			if (start < messages.length && bytes + size > 4 * 1024 * 1024) break;
			bytes += size; start--;
		}
		return messages.slice(start);
	}
	private async refresh() {
		const revision = this.revision;
		const state = await this.request("get_state");
		if (typeof state.sessionId !== "string" || typeof state.isStreaming !== "boolean") throw new Error("Remote Pi must support the native 1.0.4 RPC protocol");
		const history = await this.request("get_messages");
		const messages = (history.messages ?? []).slice(-200).map((m: AgentMessage, index: number) => serializeMessage(m, index)).filter((m: UiMessage | null): m is UiMessage => !!m);
		if (this.revision !== revision) return;
		this.seq = messages.length;
		this.set({ sessionId: state.sessionId, sessionFile: state.sessionFile, model: state.model ? { id: String(state.model.id), provider: String(state.model.provider), name: String(state.model.name ?? state.model.id) } : undefined, thinkingLevel: state.thinkingLevel, running: state.isStreaming || state.isCompacting, messages: this.retainMessages(messages) });
	}
	async prompt(text: string, queue?: "steer" | "followUp") {
		if (this.state.phase !== "ready") throw new Error("Remote Pi is not ready");
		if (!text.trim() || text.length > 200000) throw new Error("Invalid remote prompt");
		this.set({ error: undefined });
		await this.request("prompt", { message: text, ...(queue ? { streamingBehavior: queue } : {}) });
	}
	async abort() { await this.request("abort"); }
	async newSession() {
		if (this.state.running || this.state.dialogs.length) throw new Error("Stop the remote task first");
		const result = await this.request("new_session");
		if (result.cancelled) return;
		this.set({ tools: [], streamingMessage: undefined }); await this.refresh();
	}
	async model(provider: string, modelId: string) {
		if (this.state.running) throw new Error("Stop the remote task first");
		if (!this.state.models.some(m => m.id === modelId && m.provider === provider)) throw new Error("Unknown remote model");
		await this.request("set_model", { provider, modelId }); await this.refresh();
	}
	dialog(id: string, response: { cancelled?: boolean; value?: string; confirmed?: boolean }) {
		const dialog = this.state.dialogs.find(d => d.id === id);
		if (!dialog) throw new Error("Remote dialog expired");
		if (!response.cancelled && dialog.method === "select" && !dialog.options?.includes(response.value ?? "")) throw new Error("Invalid remote selection");
		if (response.value && response.value.length > 200000) throw new Error("Remote response too large");
		clearTimeout(this.dialogTimers.get(id)); this.dialogTimers.delete(id);
		this.stream.write(JSON.stringify({ type: "extension_ui_response", id, ...response }) + "\n");
		this.set({ dialogs: this.state.dialogs.filter(d => d.id !== id) });
	}
	private event(event: RecordValue) {
		if (!event || typeof event.type !== "string") throw new Error("Missing RPC record type");
		if (event.type === "response") {
			const task = this.pending.get(event.id); if (!task) return;
			clearTimeout(task.timer); this.pending.delete(event.id);
			if (event.success) task.resolve(event.data ?? {}); else task.reject(new Error(String(event.error ?? "Remote Pi command failed")));
			return;
		}
		if (["agent_start", "compaction_start", "auto_retry_start"].includes(event.type)) { this.revision++; this.set({ running: true, error: undefined, tools: [] }); }
		if (event.type === "agent_settled") {
			this.set({ running: false });
			void this.refresh().catch(error => this.set({ error: error.message }));
		}
		if (event.type === "message_start" && event.message?.role === "assistant") this.set({ streamingMessage: serializeMessage(event.message, this.seq) ?? undefined });
		if (event.type === "message_update") {
			const delta = event.assistantMessageEvent, current = this.state.streamingMessage;
			if (!current || !delta || !Number.isInteger(delta.contentIndex) || delta.contentIndex < 0 || delta.contentIndex > 4096) return;
			const content = [...current.content], index = delta.contentIndex, previous = content[index];
			if (delta.type === "text_delta") content[index] = { type: "text", text: (String(previous && "text" in previous ? previous.text ?? "" : "") + String(delta.delta ?? "")).slice(-200000) };
			else if (delta.type === "thinking_delta") content[index] = { type: "thinking", thinking: (String(previous && "thinking" in previous ? previous.thinking ?? "" : "") + String(delta.delta ?? "")).slice(-200000) };
			else if (delta.type === "toolcall_start") content[index] = { type: "toolCall", id: String(delta.id), name: String(delta.toolName), argumentsText: "" };
			else if (delta.type === "toolcall_delta" && previous?.type === "toolCall") content[index] = { ...previous, argumentsText: (String(previous.argumentsText ?? "") + String(delta.delta ?? "")).slice(0, 20000) };
			else return;
			this.set({ streamingMessage: { ...current, content: content.filter(Boolean) as UiContentBlock[] } });
		}
		if (event.type === "message_end") {
			this.revision++;
			const message = serializeMessage(event.message, this.seq++);
			if (message) this.set({ messages: this.retainMessages([...this.state.messages, message]), ...(event.message.role === "assistant" ? { streamingMessage: undefined } : {}) });
		}
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			const tools = this.state.tools.filter(t => t.id !== event.toolCallId);
			tools.push({ id: String(event.toolCallId), name: String(event.toolName), running: event.type === "tool_execution_start", isError: !!event.isError });
			this.set({ tools: tools.slice(-256) });
		}
		if (event.type === "extension_ui_request") {
			if (["select", "confirm", "input", "editor"].includes(event.method)) {
				if (this.state.dialogs.length >= 32) { this.stream.write(JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true }) + "\n"); return; }
				if (typeof event.timeout === "number" && event.timeout >= 0 && event.timeout <= 2147483647) this.dialogTimers.set(String(event.id), setTimeout(() => { this.dialogTimers.delete(String(event.id)); this.set({ dialogs: this.state.dialogs.filter(d => d.id !== event.id) }); }, event.timeout));
				this.set({ dialogs: [...this.state.dialogs, { id: String(event.id), method: event.method, title: String(event.title ?? ""), message: String(event.message ?? ""), options: Array.isArray(event.options) ? event.options.map(String) : undefined, prefill: typeof event.prefill === "string" ? event.prefill : undefined }] }, true);
			}
			if (event.method === "notify") this.set({ notice: String(event.message ?? "").slice(0, 8000) });
			if (event.method === "set_editor_text") this.set({ editorText: { id: String(event.id), text: String(event.text ?? "").slice(0, 200000) } });
		}
	}
}
