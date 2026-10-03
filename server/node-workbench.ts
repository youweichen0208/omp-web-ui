/** Built-in SSH node workbench. All remote operations are scoped by node and client. */
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";

import { PluginSecrets } from "./plugin-facilities.js";
import { scanSource, detectSources, sourcePath,  } from "./node-sources.js";
import type { NodeSource, NodeProfile,   ClientMessage, ServerMessage } from "./protocol.js";

type Request = Extract<ClientMessage, { type: "node_request" }>;
type Sink = (msg: ServerMessage) => void;
type Node = NodeProfile;
function unsupportedOptions(node: Node): string[] {
	return (node.unsupported ?? []).filter((reason) => reason !== "key" || ((node.localAuth ?? node.auth) === "key" && !node.localKeyPath));
}
type Terminal = { id: string; conversationId: string; stream: ClientChannel; busy: boolean; buffer: string; pending?: { marker: string; output: string; resolve: (value: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } };
type Connection = { client: Client; nodeId: string; clientId: string; terminals: Map<string, Terminal>; sftp?: SFTPWrapper; ready: boolean; startedAt: number; connectedAt?: number };

const MAX_OUTPUT = 64 * 1024;
const MAX_FILE = 512 * 1024;
const identity = (clientId: string, nodeId: string) => JSON.stringify([clientId, nodeId]);
const fail = (message: string): never => { throw new Error(message); };
const field = (value: unknown, name: string, max = 256): string => {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} 无效`);
	return value.trim();
};
const safePath = (value: unknown): string => {
	const path = field(value, "路径", 4096);
	if (!path.startsWith("/") || path.includes("\0")) throw new Error("需要远端绝对路径");
	return path;
};
const tail = (value: string) => value.length > MAX_OUTPUT ? `[输出已截断]\n${value.slice(-MAX_OUTPUT)}` : value;

export class NodeWorkbench {
	private readonly file: string;
	private readonly secrets: PluginSecrets;
	private nodes: Node[] = [];
	private sources: NodeSource[] = [];
	private syncing = new Set<string>();
	private timer: ReturnType<typeof setInterval>;
	private disposed = false;
	private transientSecrets = new Map<string, string>();
	private observedKeys = new Map<string, string>();

	private readonly sinks = new Map<string, Set<Sink>>();
	private readonly connections = new Map<string, Connection>();

	constructor(private readonly dataDir: string) {
		this.file = join(dataDir, "nodes.json");
		this.secrets = new PluginSecrets(dataDir, join(dataDir, "node-workbench"));
		try { const saved = JSON.parse(readFileSync(this.file, "utf8")); this.nodes = saved.nodes ?? []; this.sources = saved.sources ?? []; } catch { this.nodes = []; }
		this.nodes = this.nodes.filter((node) => node && /^[0-9a-f-]{36}$/i.test(node.id) && typeof node.host === "string");
		this.timer = setInterval(() => { for (const source of this.sources) if (source.enabled) void this.syncSource(source); }, 5000);
		this.timer.unref();
	}
	private save(): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ nodes: this.nodes, sources: this.sources }, null, 2), { mode: 0o600 });
		renameSync(tmp, this.file);
	}
	private emit(clientId: string, event: string, data: Record<string, unknown> = {}, ids: Partial<Request> = {}): void {
		const msg: ServerMessage = { type: "node_event", event, data, nodeId: ids.nodeId, terminalId: ids.terminalId, conversationId: ids.conversationId, requestId: ids.requestId };
		for (const sink of this.sinks.get(clientId) ?? []) sink(msg);
	}
	private state(clientId: string): Record<string, unknown> {
		return { sources: this.sources,   nodes: this.nodes.map((node) => ({ ...node, auth: node.localAuth ?? node.auth, unsupported: unsupportedOptions(node), hasSecret: this.secrets.has(`node:${node.id}:secret`) || this.transientSecrets.has(identity(clientId, node.id)), fingerprint: node.fingerprint })), connections: [...this.connections.values()].filter((c) => c.clientId === clientId).map((c) => ({ nodeId: c.nodeId, connectedAt: c.connectedAt, latencyMs: c.connectedAt ? c.connectedAt - c.startedAt : undefined, status: c.ready ? "connected" : "connecting", terminals: [...c.terminals.values()].map((t) => ({ id: t.id, conversationId: t.conversationId, busy: t.busy, output: t.buffer })) })) };
	}
	attach(clientId: string, sink: Sink): () => void {
		let set = this.sinks.get(clientId);
		if (!set) this.sinks.set(clientId, set = new Set());
		set.add(sink);
		this.emit(clientId, "state", this.state(clientId));
		return () => { set?.delete(sink); if (!set?.size) this.sinks.delete(clientId); };
	}
	private node(id: string | undefined): Node { return this.nodes.find((n) => n.id === id) ?? fail("节点不存在"); }
	private connection(clientId: string, nodeId: string | undefined): Connection {
		const c = this.connections.get(identity(clientId, nodeId ?? ""));
		if (!c?.ready) throw new Error("节点未连接");
		return c;
	}
	private terminal(clientId: string, req: Request): Terminal {
		const t = this.connection(clientId, req.nodeId).terminals.get(req.terminalId ?? "");
		if (!t || t.conversationId !== req.conversationId) throw new Error("终端身份已过期");
		return t;
	}
	async handle(clientId: string, req: Request): Promise<void> {
		try {
			const p = req.payload ?? {};
			let result: Record<string, unknown> = {};
			switch (req.action) {
				case "state": this.emit(clientId, "state", this.state(clientId)); break;
				case "source_detect": result = { sources: await detectSources() }; break;
				case "source_add": {
					const path = sourcePath(field(p.path, "路径", 4096)), kind = p.kind === "xshell" ? "xshell" : "ssh";
					let source = this.sources.find((s) => s.path === path && s.kind === kind);
					if (!source) { if (this.sources.length >= 10) throw new Error("最多 10 个配置来源"); source = { id: randomUUID(), kind, path, enabled: p.enabled !== false, count: 0, groups: 0 }; this.sources.push(source); }
					else source.enabled = p.enabled !== false;
					await this.syncSource(source); if (source.error) throw new Error(source.error); result = { sourceId: source.id }; break;
				}
				case "source_reveal": {
					const source = this.sources.find((s) => s.id === p.id);
					if (!source) throw new Error("来源不存在");
					const program = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
					const args = process.platform === "darwin" ? ["-R", source.path] : [source.kind === "ssh" ? dirname(source.path) : source.path];
					await new Promise<void>((ok, reject) => execFile(program, args, { timeout: 10000 }, (error) => error ? reject(error) : ok())); break;
				}
				case "source_sync": case "source_toggle": {
					const source = this.sources.find((s) => s.id === p.id);
					if (!source) throw new Error("来源不存在");
					if (req.action === "source_toggle") { source.enabled = Boolean(p.enabled); this.save(); this.broadcastState(); }
					else await this.syncSource(source);
					break;
				}

				case "credential_test": {
					const node = this.node(req.nodeId);
					if (p.auth !== undefined && p.auth !== "password" && p.auth !== "key") throw new Error("认证方式无效");
					const auth = (p.auth ?? node.localAuth ?? node.auth) as Node["auth"];
					if (typeof p.secret !== "string" || (auth === "password" && !p.secret) || p.secret.length > 10000) throw new Error("凭据无效");
					const secret = p.secret;
					const originalAuth = node.localAuth;
					const candidate = { ...node, localAuth: auth };
					if (auth === "key" && typeof p.keyPath === "string") candidate.localKeyPath = field(p.keyPath, "私钥路径", 4096);
					if (p.fingerprint) {
						if (p.fingerprint !== this.observedKeys.get(identity(clientId, node.id))) throw new Error("主机指纹已过期");
						node.fingerprint = String(p.fingerprint);
					}
					candidate.fingerprint = node.fingerprint;
					await this.connect(clientId, candidate, secret, req);
					if (this.node(node.id) !== node || node.host !== candidate.host || node.port !== candidate.port || node.username !== candidate.username || node.keyPath !== candidate.keyPath || node.auth !== candidate.auth || node.localAuth !== originalAuth || node.sourceMissing) { this.disconnect(clientId, node.id); throw new Error("节点配置已变化，请重试"); }
					if (auth !== (node.localAuth ?? node.auth)) {

						for (const c of [...this.connections.values()]) if (c.nodeId === node.id && c.clientId !== clientId) this.drop(c);
						this.secrets.delete(`node:${node.id}:secret`);
						for (const key of this.transientSecrets.keys()) if (JSON.parse(key)[1] === node.id) this.transientSecrets.delete(key);
					}
					node.localAuth = auth;
					if (auth === "key" && candidate.localKeyPath) node.localKeyPath = candidate.localKeyPath;
					else if (auth !== "key") delete node.localKeyPath;
					node.lastConnected = candidate.lastConnected;
					const targets = p.sameGroup && auth === "password" ? this.nodes.filter((n) => n.group === node.group && (n.localAuth ?? n.auth) === auth && !n.sourceMissing && !unsupportedOptions(n).length) : [node];
					for (const target of targets) {
						if (p.persist !== false) { this.secrets.set(`node:${target.id}:secret`, secret); this.transientSecrets.delete(identity(clientId, target.id)); }
						else this.transientSecrets.set(identity(clientId, target.id), secret);
					}
					this.save(); this.broadcastState(); result = { count: targets.length }; break;
				}
				case "save": {
					const id = typeof p.id === "string" && p.id ? p.id : randomUUID();
					const old = this.nodes.find((n) => n.id === id);
					if (p.id && !old) throw new Error("节点不存在");
					if (old?.sourceId) throw new Error("来源节点请在原工具中编辑");
					const node: Node = {
						id, group: typeof p.group === "string" ? p.group.slice(0, 80) : "默认", name: field(p.name, "名称"),
						host: field(p.host, "地址"), port: Number(p.port ?? 22), username: field(p.username, "用户名"),
						auth: p.auth === "key" || p.auth === "agent" ? p.auth : "password",
						keyPath: typeof p.keyPath === "string" ? p.keyPath.slice(0, 4096) : undefined,
						defaultDir: typeof p.defaultDir === "string" && p.defaultDir.startsWith("/") && !/[\r\n\0]/.test(p.defaultDir) ? p.defaultDir : "/",
						fingerprint: old?.host === p.host && old?.port === Number(p.port ?? 22) ? old?.fingerprint : undefined,
						 lastConnected: old?.lastConnected,
					};
					if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) throw new Error("端口无效");
					const priorSecret = old?.auth === node.auth ? this.secrets.get(`node:${id}:secret`) : undefined;
					const usableSecret = p.secret === null ? undefined : typeof p.secret === "string" && p.secret ? p.secret : priorSecret;
					if (node.auth === "password" && !usableSecret) throw new Error("请填写 SSH 密码");
					if (node.auth === "key" && !node.keyPath) throw new Error("请填写本机私钥路径");
					if (p.secret === null || (old && old.auth !== node.auth) || node.auth === "agent") this.secrets.delete(`node:${id}:secret`);
					if (node.auth !== "agent" && typeof p.secret === "string" && p.secret) this.secrets.set(`node:${id}:secret`, p.secret);
					if (p.secret !== undefined || old?.auth !== node.auth) for (const key of this.transientSecrets.keys()) if (JSON.parse(key)[1] === id) this.transientSecrets.delete(key);
					if (old && (old.host !== node.host || old.port !== node.port || old.username !== node.username || old.auth !== node.auth || old.keyPath !== node.keyPath || p.secret)) {
						for (const c of [...this.connections.values()]) if (c.nodeId === id) this.drop(c);
					}
					this.nodes = old ? this.nodes.map((n) => n.id === id ? node : n) : [...this.nodes, node];
					this.save(); result = { id }; this.broadcastState(); break;
				}
				case "delete": {
					const node = this.node(req.nodeId);

					for (const c of [...this.connections.values()]) if (c.nodeId === node.id) this.drop(c);

					this.nodes = this.nodes.filter((n) => n.id !== node.id);
					this.secrets.delete(`node:${node.id}:secret`);
					for (const key of this.transientSecrets.keys()) if (JSON.parse(key)[1] === node.id) this.transientSecrets.delete(key);
					this.save(); this.broadcastState(); break;
				}
				case "forget_host_key": {
					const node = this.node(req.nodeId);
					for (const c of [...this.connections.values()]) if (c.nodeId === node.id) this.drop(c);
					delete node.fingerprint;
					this.save(); this.broadcastState(); break;
				}
				case "import_legacy": result = this.importLegacy(); this.broadcastState(); break;
				case "import": {
					const input = p.nodes;
					if (!Array.isArray(input) || input.length > 200) throw new Error("节点文件无效或超过 200 台");
					let count = 0;
					for (const item of input) {
						if (!item || typeof item !== "object") continue;
						const h = item as Record<string, unknown>;
						const host = field(h.host, "地址"), username = field(h.username, "用户名"), port = Number(h.port);
						if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
						if (this.nodes.some((n) => n.host === host && n.port === port && n.username === username)) continue;
						this.nodes.push({ id: randomUUID(), group: typeof h.group === "string" ? h.group.slice(0, 80) : "导入", name: field(h.name, "名称"), host, port, username, auth: h.auth === "key" || h.auth === "agent" ? h.auth : "password", keyPath: typeof h.keyPath === "string" ? h.keyPath.slice(0, 4096) : undefined, defaultDir: typeof h.defaultDir === "string" && h.defaultDir.startsWith("/") && !/[\r\n\0]/.test(h.defaultDir) ? h.defaultDir : "/" });
						count++;
					}
					this.save(); this.broadcastState(); result = { count }; break;
				}
				case "export": result = { nodes: this.nodes.map(({ fingerprint, ...n }) => n) }; break;
				case "connect": await this.connect(clientId, this.node(req.nodeId), undefined, req); break;
				case "trust": {
					const node = this.node(req.nodeId);
					const fp = field(p.fingerprint, "指纹");
					if (node.fingerprint && node.fingerprint !== fp) throw new Error("主机密钥已变化；请重新核实节点身份");
					node.fingerprint = fp; this.save(); await this.connect(clientId, node, undefined, req); break;
				}
				case "disconnect": this.disconnect(clientId, req.nodeId); break;
				case "terminal_open": result = await this.openTerminal(clientId, req); break;

				case "terminal_input": {
					const t = this.terminal(clientId, req);
					if (t.busy) throw new Error("Agent 正在使用该终端");
					t.stream.write(String(p.data ?? "").slice(0, 8192)); break;
				}
				case "terminal_resize": this.terminal(clientId, req).stream.setWindow(Math.max(1, Number(p.rows) || 24), Math.max(1, Number(p.cols) || 80), 0, 0); break;
				case "terminal_close": this.terminal(clientId, req).stream.end(); break;
				case "interrupt": {
					const t = this.terminal(clientId, req);
					t.stream.write("\x03");
					if (t.pending) { const pending = t.pending; t.pending = undefined; pending.reject(new Error("命令已中断")); }
					break;
				}
				case "list": {
					const c = this.fileScope(clientId, req), path = safePath(p.path);
					const entries = await this.list(c, path);
					this.ensureCurrent(c); result = { path, entries }; break;
				}
				case "read": {
					const c = this.fileScope(clientId, req), path = safePath(p.path);
					const text = await this.read(c, path);
					this.ensureCurrent(c); result = { path, text }; break;
				}
				case "write": {
					const c = this.fileScope(clientId, req), path = safePath(p.path);
					await this.write(c, path, String(p.text ?? ""));
					this.ensureCurrent(c); result = { path }; break;
				}

				default: throw new Error("未知节点操作");
			}
			this.emit(clientId, "result", { action: req.action, ...result }, req);
		} catch (error) { this.emit(clientId, "failure", { action: req.action, message: (error as Error).message }, req); }
	}
	/** In-flight scans are serialized per source. Failures leave the previous snapshot intact. */
	private async syncSource(source: NodeSource): Promise<void> {
		if (this.disposed || this.syncing.has(source.id)) return;
		this.syncing.add(source.id);
		try {
			const scanned = await scanSource(source);
			if (this.disposed) return;
			const changes: string[] = [];
			for (const incoming of scanned) {
				const old = this.nodes.find((n) => n.sourceId === source.id && n.sourceKey === incoming.sourceKey);
				if (!old) { this.nodes.push({ ...incoming, id: randomUUID(), sourceId: source.id,  }); changes.push(`+ ${incoming.name}`); continue; }
				const changed = Object.keys(incoming).some((k) => JSON.stringify(old[k as keyof Node]) !== JSON.stringify(incoming[k as keyof typeof incoming])) || old.sourceMissing;
				if (!changed) continue;
				const endpoint = old.host !== incoming.host || old.port !== incoming.port;
				const credentials = old.username !== incoming.username || old.auth !== incoming.auth || old.keyPath !== incoming.keyPath;

				for (const c of [...this.connections.values()]) if (c.nodeId === old.id) this.drop(c);
				if (endpoint) delete old.fingerprint;
				if (old.host !== incoming.host || credentials) {
					delete old.localKeyPath;
					delete old.localAuth;
					this.secrets.delete(`node:${old.id}:secret`);
					for (const key of this.transientSecrets.keys()) if (JSON.parse(key)[1] === old.id) this.transientSecrets.delete(key);
				}
				changes.push(`${old.name}: ${old.host}:${old.port} → ${incoming.host}:${incoming.port}`);
				Object.assign(old, incoming, { sourceMissing: false });
			}
			for (const old of this.nodes.filter((n) => n.sourceId === source.id)) if (!scanned.some((n) => n.sourceKey === old.sourceKey) && !old.sourceMissing) {
				old.sourceMissing = true; changes.push(`− ${old.name}`);
				for (const c of [...this.connections.values()]) if (c.nodeId === old.id) this.drop(c);
			}
			source.count = scanned.length; source.groups = new Set(scanned.map((n) => n.group)).size;
			source.lastSync = Date.now(); source.error = undefined;
			if (changes.length) source.changes = changes.slice(-20);
		} catch (e) { source.error = (e as Error).message; }
		finally { this.syncing.delete(source.id); if (!this.disposed) { this.save(); this.broadcastState(); } }
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);

		for (const c of [...this.connections.values()]) this.drop(c);

		this.transientSecrets.clear();
	}

	private broadcastState(): void { for (const id of this.sinks.keys()) this.emit(id, "state", this.state(id)); }
	private fileScope(clientId: string, req: Request): Connection {
		const c = this.connection(clientId, req.nodeId);
		if (req.conversationId && req.conversationId !== `node:${c.nodeId}`) throw new Error("对话身份已过期");
		if (req.terminalId) this.terminal(clientId, req);
		return c;
	}
	private ensureCurrent(c: Connection): void {
		if (this.connections.get(identity(c.clientId, c.nodeId)) !== c || !c.ready) throw new Error("连接已变化");
	}
	private importLegacy(): Record<string, unknown> {
		let count = 0;
		for (const path of [join(this.dataDir, "plugins", "vscode-editor", "ssh-hosts.json"), join(this.dataDir, "plugins", "ssh", "ssh-hosts.json")]) {
			try {
				const hosts = JSON.parse(readFileSync(path, "utf8")).hosts;
				if (!Array.isArray(hosts)) continue;
				for (const h of hosts) {
					if (!h.host || this.nodes.some((n) => n.host === h.host && n.port === (Number(h.port) || 22) && n.username === h.username)) continue;
					this.nodes.push({ id: randomUUID(), group: "导入", name: String(h.name || h.host), host: String(h.host), port: Number(h.port) || 22, username: String(h.username || "root"), auth: h.privateKey ? "key" : "password", defaultDir: "/" });
					count++;
				}
			} catch { /* missing legacy config */ }
		}
		if (count) this.save();
		return { count };
	}
	private async connect(clientId: string, node: Node, overrideSecret?: string, req?: Request): Promise<void> {
		const auth = node.localAuth ?? node.auth;
		if (node.sourceMissing || unsupportedOptions(node).length) throw new Error("来源已移除或配置包含暂不支持的选项，请检查节点详情");
		const secret = overrideSecret ?? this.transientSecrets.get(identity(clientId, node.id)) ?? this.secrets.get(`node:${node.id}:secret`);
		let keyChanged = false;
		const opts: Parameters<Client["connect"]>[0] = { host: node.host, port: node.port, username: node.username, readyTimeout: 15000, keepaliveInterval: 10000,
			hostHash: "sha256", hostVerifier: (hash: string) => {
				const fp = `SHA256:${hash}`;
				this.observedKeys.set(identity(clientId, node.id), fp);
				if (!node.fingerprint) { this.emit(clientId, "trust_required", { fingerprint: fp, name: node.name, host: node.host }, { ...req, nodeId: node.id }); return false; }
				if (node.fingerprint !== fp) keyChanged = true;
				return node.fingerprint === fp;
			} };
		if (auth === "password") opts.password = secret ?? "";
		else if (auth === "agent") {
			if (!process.env.SSH_AUTH_SOCK) throw new Error("本机 SSH Agent 未就绪");
			opts.agent = process.env.SSH_AUTH_SOCK;
		}
		else { const keyPath = node.localKeyPath || node.keyPath; const path = keyPath?.startsWith("~/") ? join(homedir(), keyPath.slice(2)) : keyPath; if (!path) throw new Error("需要私钥路径"); opts.privateKey = readFileSync(resolve(path)); if (secret) opts.passphrase = secret; }
		this.disconnect(clientId, node.id);
		const client = new Client();
		const c: Connection = { client, clientId, nodeId: node.id, terminals: new Map(), ready: false, startedAt: Date.now() };
		const key = identity(clientId, node.id);
		this.connections.set(key, c);
		this.broadcastState();
		try {
			await new Promise<void>((ok, reject) => {
				let settled = false;
				client.once("ready", () => { settled = true; ok(); });
				client.on("error", (e) => { if (!settled) { settled = true; reject(e); } else this.drop(c); });
				client.on("close", () => { if (!settled) { settled = true; reject(new Error("SSH 连接已关闭")); } this.drop(c); });
				client.connect(opts);
			});
			if (this.connections.get(key) !== c) throw new Error("连接已被新的请求替代");
			c.ready = true; c.connectedAt = Date.now(); node.lastConnected = c.connectedAt; this.save(); this.broadcastState();
		} catch (e) { this.drop(c); client.end(); if (keyChanged) throw new Error("主机密钥已变化，连接已阻止；请核实节点身份"); throw e; }
	}
	private drop(c: Connection): void {
		if (this.connections.get(identity(c.clientId, c.nodeId)) !== c) return;

		this.connections.delete(identity(c.clientId, c.nodeId));
		for (const t of c.terminals.values()) { t.pending?.reject(new Error("SSH 已断开")); this.emit(c.clientId, "terminal_exit", {}, { nodeId: c.nodeId, terminalId: t.id, conversationId: t.conversationId }); }
		c.terminals.clear(); c.client.end(); this.broadcastState();
	}
	private disconnect(clientId: string, nodeId: string | undefined): void { const c = this.connections.get(identity(clientId, nodeId ?? "")); if (c) this.drop(c); }
	private async openTerminal(clientId: string, req: Request): Promise<Record<string, unknown>> {
		const c = this.connection(clientId, req.nodeId);
		const id = req.terminalId || randomUUID(), conversationId = `node:${c.nodeId}`;
		if (c.terminals.has(id)) throw new Error("终端 ID 已存在");
		const p = req.payload ?? {};
		const stream = await new Promise<ClientChannel>((ok, reject) => c.client.shell({ cols: Number(p.cols) || 80, rows: Number(p.rows) || 24, term: "xterm-256color" }, (e, s) => e ? reject(e) : ok(s)));
		try { this.ensureCurrent(c); } catch (error) { stream.end(); throw error; }
		const t: Terminal = { id, conversationId, stream, busy: false, buffer: "" };
		c.terminals.set(id, t);
		stream.on("data", (chunk: Buffer) => {
			const data = chunk.toString("utf8");
			t.buffer = (t.buffer + data).slice(-MAX_OUTPUT);
			if (t.pending) { t.pending.output = tail(t.pending.output + data); if (new RegExp(`(?:^|\\r?\\n)${t.pending.marker}(?::\\d+)?\\r?\\n`).test(t.pending.output)) { const pending = t.pending; t.pending = undefined; clearTimeout(pending.timer); pending.resolve(pending.output); } }
			this.emit(clientId, "terminal_output", { text: tail(data) }, { nodeId: c.nodeId, terminalId: id, conversationId });
		});
		stream.on("close", () => {  t.pending?.reject(new Error("终端已断开")); c.terminals.delete(id); this.emit(clientId, "terminal_exit", {}, { nodeId: c.nodeId, terminalId: id, conversationId }); this.broadcastState(); });
		const directory = this.node(c.nodeId).defaultDir;
		if (directory !== "/") stream.write(`cd '${directory.replaceAll("'", "'\\''")}'\n`);
		this.broadcastState(); return { terminalId: id, conversationId };
	}
	private async execute(clientId: string, nodeId: string, terminalId: string, command: string, signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) throw new Error("命令已中断");
		const c = this.connection(clientId, nodeId), t = c.terminals.get(terminalId);
		if (!t) throw new Error("请选择已连接的手动终端");
		if (t.busy) throw new Error("终端正忙");
		t.busy = true; this.emit(clientId, "terminal_busy", { busy: true }, { nodeId, terminalId, conversationId: t.conversationId });
		try {
			const marker = `__PI_READY_${randomUUID().replaceAll("-", "")}__`;
			// Interrupt any foreground process, then wait for a shell-executed marker.
			t.stream.write("\x03\n");
			await this.waitMarker(t, marker, `printf '%s\\n' '${marker}'\n`, 5000, signal);
			const end = `__PI_DONE_${randomUUID().replaceAll("-", "")}__`;
			const output = await this.waitMarker(t, end, `${command}\nprintf '%s:%s\\n' '${end}' "$?"\n`, 120000, signal);
			const code = Number(output.match(new RegExp(`${end}:(\\d+)`))?.[1] ?? 0);
			return tail(output.replace(new RegExp(`${end}:\\d+`), "") + (code ? `\n[退出码 ${code}]` : ""));
		} finally { t.busy = false; this.emit(clientId, "terminal_busy", { busy: false }, { nodeId, terminalId, conversationId: t.conversationId }); }
	}
	private waitMarker(t: Terminal, marker: string, input: string, ms: number, signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) return Promise.reject(new Error("命令已中断"));
		return new Promise((resolve, reject) => {
			const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (t.pending?.marker === marker) t.pending = undefined; };
			const abort = () => { t.stream.write("\x03"); cleanup(); reject(new Error("命令已中断")); };
			const timer = setTimeout(() => { t.stream.write("\x03"); cleanup(); reject(new Error("无法确认 shell 提示符或命令超时")); }, ms);
			signal?.addEventListener("abort", abort, { once: true });
			t.pending = { marker, output: "", timer, resolve: (text) => { cleanup(); resolve(text); }, reject: (error) => { cleanup(); reject(error); } };
			t.stream.write(input);
		});
	}
	private async sftp(c: Connection): Promise<SFTPWrapper> {
		this.ensureCurrent(c);
		if (c.sftp) return c.sftp;
		c.sftp = await new Promise<SFTPWrapper>((ok, reject) => c.client.sftp((e, s) => e ? reject(e) : ok(s)));
		this.ensureCurrent(c);
		return c.sftp;
	}
	private async list(c: Connection, path: string): Promise<unknown[]> {
		const s = await this.sftp(c);
		const entries = await new Promise<import("ssh2").FileEntryWithStats[]>((ok, reject) => s.readdir(path, (e, list) => e ? reject(e) : ok(list)));
		return entries.map((e) => ({ name: e.filename, type: e.attrs.isDirectory() ? "dir" : "file", size: e.attrs.size }));
	}
	private async read(c: Connection, path: string): Promise<string> {
		const s = await this.sftp(c);
		const st = await new Promise<{ size: number }>((ok, reject) => s.stat(path, (e, attrs) => e ? reject(e) : ok(attrs)));
		if (st.size > MAX_FILE) throw new Error("文件超过 512 KiB");
		const chunks: Buffer[] = []; let size = 0;
		for await (const chunk of s.createReadStream(path)) { const b = Buffer.from(chunk); size += b.length; if (size > MAX_FILE) throw new Error("文件超过 512 KiB"); chunks.push(b); }
		return Buffer.concat(chunks).toString("utf8");
	}
	private async write(c: Connection, path: string, text: string): Promise<void> {
		if (Buffer.byteLength(text) > MAX_FILE) throw new Error("文件超过 512 KiB");
		const s = await this.sftp(c);
		await new Promise<void>((ok, reject) => { const stream = s.createWriteStream(path, { flags: "w" }); stream.once("error", reject); stream.once("close", ok); stream.end(text); });
	}

}
