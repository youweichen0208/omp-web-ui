import { toolWatchdogTimeout } from "./tool-timeout.js";
import { Type } from "typebox";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { subagents, upstreamSubagent, unfinished } from "./subagents.js";
import type { SubagentSummary } from "./protocol.js";
import type { SubagentStart } from "./subagents.js";
export { upstreamSubagent };
export const SUBAGENT_GUIDANCE = "Built-in web_subagent is available when enabled. Delegate only when useful and permitted by the user's and skills' execution/waiting rules. spawn returns immediately; completion of the spawn tool does NOT mean completion of the task. Use wait when results are required. Read-only roles can run in parallel; writing roles serialize across the real project directory. Include only explicitly chosen background, never the entire chat. No recursive delegation.";
export function subagentGuard(cwd: string, owner: string): ExtensionFactory {
	return pi => {
		pi.on("tool_call", event => { if (event.toolName === "web_subagent" && (event.input as { action?: string }).action === "wait") subagents.yield(owner); const reason = subagents.enter(cwd, owner, event.toolCallId, event.toolName, event.input); if (reason) return { block: true, reason }; });
		pi.on("tool_result", event => { subagents.leave(cwd, owner, event.toolCallId); });
		pi.on("agent_settled", () => { subagents.leave(cwd, owner); });
		pi.on("session_shutdown", () => { subagents.leave(cwd, owner); });
	};
}
export function webSubagentTool(context: () => SubagentStart): ToolDefinition {
	return {
		name: "web_subagent", label: "Web subagent", description: "Spawn and supervise isolated subagents. spawn is asynchronous; wait for required results. Each wait returns within five minutes (or half the host tool deadline); repeat wait while queued/running. No recursive delegation.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("spawn"), Type.Literal("status"), Type.Literal("wait"), Type.Literal("message"), Type.Literal("stop")]), role: Type.Optional(Type.String()), task: Type.Optional(Type.String()), background: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()), text: Type.Optional(Type.String()), mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])) }),
		async execute(_id, raw, signal) {
			if (!subagents.config.enabled) throw new Error("Built-in subagents are disabled");
			const args = raw as { action: string; role?: string; task?: string; background?: string; taskId?: string; text?: string; mode?: "steer" | "followUp" };
			const c = context(); let value: unknown;
			if (args.action === "spawn") { value = subagents.spawn({ ...c, roleId: args.role ?? "analysis", task: args.task ?? "", background: args.background }); await subagents.whenLaunched(value as SubagentSummary); }
			else if (args.action === "status" && !args.taskId) value = subagents.state(c.clientId).tasks.filter(t => t.conversationId === c.conversationId).slice(-32).map(t => modelResult(subagents.get(t.id, c.clientId, c.conversationId)));
			else { const id = args.taskId ?? ""; subagents.get(id, c.clientId, c.conversationId);
				if (args.action === "wait") value = await subagents.wait(id, c.clientId, c.conversationId, signal, Math.min(300_000, toolWatchdogTimeout() / 2));
				else if (args.action === "message") { await subagents.message(id, c.clientId, c.conversationId, args.text ?? "", args.mode ?? "followUp"); value = { taskId: id, accepted: true }; }
				else if (args.action === "stop") { subagents.stop(id, c.clientId); value = { taskId: id, accepted: true }; }
				else value = subagents.get(id, c.clientId, c.conversationId);
			}
			if (value && !Array.isArray(value) && "status" in (value as object)) value = modelResult(value as SubagentSummary);
			return { content: [{ type: "text", text: JSON.stringify(value) }], details: { resultDelivered: args.action === "wait" && !!value && !unfinished(value as SubagentSummary), taskId: (value as { id?: string })?.id ?? args.taskId } };
		},
	};
}

export function modelResult(t: SubagentSummary) { return { id: t.id, status: t.status, role: t.role.name, result: t.result, error: t.error, usage: t.usage }; }
