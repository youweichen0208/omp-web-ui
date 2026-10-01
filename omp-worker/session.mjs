/** Bun-only bootstrap. OMP owns both the agent loop and the public RPC protocol.
 * The inherited Node IPC channel is private; it is never a network endpoint.
 */
import { getPluginsNodeModules } from "@oh-my-pi/pi-utils";
import { relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentSession, Settings } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcDecoder, encodeFrame } from "../dist/server/omp/rpc.js";

if (!process.send) throw new Error("OMP management IPC is required");
let writes = Promise.resolve();
function send(frame) {
	writes = writes.then(async () => {
		for (const line of encodeFrame(frame)) await new Promise((resolve, reject) => process.send(line, error => error ? reject(error) : resolve()));
	});
	return writes;
}
const initialized = Promise.withResolvers();
const hostCalls = new Map();
let session, creation;
let messageRevision = 0;
const decoder = new RpcDecoder(frame => {
	if (frame.type === "webui_init") { initialized.resolve(frame); return; }
	if (frame.type === "host_tool_result" || frame.type === "host_tool_update") {
		const pending = hostCalls.get(frame.id);
		if (!pending) return;
		if (frame.type === "host_tool_update") pending.update?.(frame.partialResult);
		else { hostCalls.delete(frame.id); pending.cleanup(); frame.isError ? pending.reject(new Error(frame.result.content?.map(c => c.text ?? "").join("\n") || "Remote tool failed")) : pending.resolve(frame.result); }
		return;
	}
	void manage(frame).then(data => send({ type: "response", command: frame.type, id: frame.id, success: true, data }), error => send({ type: "response", command: frame.type, id: frame.id, success: false, error: error.message })).catch(() => process.exit(1));
});
process.on("message", message => {
	try {
		if (typeof message !== "string") throw new Error("Invalid OMP management frame");
		decoder.push(Buffer.from(message));
	} catch { process.exit(1); }
});
process.on("disconnect", () => { void Promise.resolve(session?.dispose()).finally(() => process.exit(0)); });
// Tell the parent that the management listener is installed before it sends init.
await send({ type: "webui_control_ready" });

function remoteTool(definition) {
	return { ...definition, execute: (toolCallId, args, update, _context, signal) => new Promise((resolve, reject) => {
		const id = randomUUID();
		const abort = () => {
			hostCalls.delete(id);
			signal?.removeEventListener("abort", abort);
			void send({ type: "host_tool_cancel", id: randomUUID(), targetId: id }).catch(() => {});
			reject(new Error("Remote tool cancelled"));
		};
		if (signal?.aborted) { reject(new Error("Remote tool cancelled")); return; }
		hostCalls.set(id, { resolve, reject, update, cleanup: () => signal?.removeEventListener("abort", abort) });
		signal?.addEventListener("abort", abort, { once: true });
		void send({ type: "host_tool_call", id, toolCallId, toolName: definition.name, arguments: args }).catch(error => {
			hostCalls.delete(id); signal?.removeEventListener("abort", abort); reject(error);
		});
	}) };
}

async function manage(frame) {
	if (!session) throw new Error("OMP session is not initialized");
	switch (frame.type) {
		case "webui_metadata": return {
			messages: session.messages, messageRevision,
			contextEntries: (() => {
				const messages = new Set(session.sessionManager.buildSessionContext().messages);
				return session.sessionManager.getBranch().filter(entry => entry.type === "message" && messages.has(entry.message));
			})(),
			entries: session.sessionManager.getEntries(), branch: session.sessionManager.getBranch(), leafId: session.sessionManager.getLeafId(),
			stats: session.getSessionStats(), skills: session.skills, prompts: session.promptTemplates,
			extensions: creation.extensionsResult.extensions.map(e => (() => {
				const path = relative(getPluginsNodeModules(), e.resolvedPath).replaceAll("\\", "/");
				const parts = path.split("/");
				const packageName = path.startsWith("../") || isAbsolute(path) ? undefined : parts.slice(0, parts[0].startsWith("@") ? 2 : 1).join("/");
				return { path: e.path, resolvedPath: e.resolvedPath, packageName };
			})()),
			diagnostics: [...creation.extensionsResult.errors.map(e => ({ path: e.path, message: e.error })), ...session.configWarnings.map(message => ({ path: "", message }))],
			tools: session.getActiveToolNames(), allTools: session.getAllToolNames(), defaultSystemPrompt,
		};
		case "webui_custom_message": return session.sendCustomMessage(frame.message, frame.options);
		case "webui_append_entry": return session.sessionManager.appendCustomEntry(frame.customType, frame.data);
		case "webui_active_tools": return session.setActiveToolsByName(frame.names);
		case "webui_toggle_tools": {
			const enabled = new Set(session.getEnabledToolNames());
			for (const name of frame.names) frame.enabled ? enabled.add(name) : enabled.delete(name);
			return session.setActiveToolsByName([...enabled]);
		}
		case "webui_reload": return session.reload();
		case "webui_refresh_models":
			await session.modelRegistry.authStorage.credentials.reload();
			await session.modelRegistry.refresh("offline");
			return;
		default: throw new Error(`Unsupported management operation: ${frame.type}`);
	}
}

const config = await initialized.promise;
const manager = config.sessionPath ? await SessionManager.open(config.sessionPath)
	: config.sessionMode === "memory" ? SessionManager.inMemory(config.cwd)
	: config.sessionMode === "recent" ? await SessionManager.continueRecent(config.cwd, config.sessionDir)
	: SessionManager.create(config.cwd, config.sessionDir);
const settings = await Settings.loadIsolated({ cwd: config.cwd, agentDir: config.agentDir, overrides: {
	"skills.ignoredSkills": config.disabledSkills ?? [], disabledExtensions: config.disabledExtensions ?? [],
	// Web attachment preparation owns the user-visible vision bridge setting.
	// Do not silently run a second transcription when that setting is off.
	"images.describeForTextModels": false,
} });
let defaultSystemPrompt = "";
creation = await createAgentSession({
	cwd: config.cwd, agentDir: config.agentDir, sessionManager: manager, settings,
	...(config.model ? { modelPattern: `${config.model.provider}/${config.model.id}` } : {}),
	...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
	...(config.systemPrompt ? { systemPrompt: base => { defaultSystemPrompt = base.join("\n\n"); return config.systemPrompt; } } : {}),
	appendSystemPrompt: config.appendSystemPrompt,
	interactivePrompts: true, hasUI: !config.restricted,
	...(config.restricted ? {
		restrictToolNames: true, allowRestrictedCustomTools: true, toolNames: (config.tools ?? []).map(t => t.name),
		customTools: (config.tools ?? []).map(remoteTool), enableMCP: false, enableLsp: false, enableIrc: false,
		disableExtensionDiscovery: true, skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
		skipPythonPreflight: true,
	} : {}),
});
session = creation.session;
// Snapshot messages and their revision are read synchronously on this pipe.
// The host can discard events already included in a concurrently requested snapshot.
session.subscribe(event => {
	if (event.type === "message_end") void send({ ...event, type: "webui_message_end", messageRevision: ++messageRevision }).catch(() => process.exit(1));
});
defaultSystemPrompt ||= session.systemPrompt.join("\n\n");
await runRpcMode(session, { setToolUIContext: creation.setToolUIContext, subagentEventBus: creation.subagentEventBus });
