import type { Static, TSchema } from "typebox";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

export type ToolDefinition<T extends TSchema = TSchema> = {
	name: string; label: string; description: string; parameters: T;
	promptSnippet?: string; promptGuidelines?: string[];
	concurrency?: "shared" | "exclusive";
	execute: (id: string, params: Static<T>, signal?: AbortSignal, onUpdate?: (result: AgentToolResult<unknown>) => void, context?: unknown) => Promise<AgentToolResult<unknown>>;
};
export function defineTool<T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition<T> { return tool; }
