import type { ServerMessage } from "./protocol.js";

type OutputUpdate = Pick<Extract<ServerMessage, { type: "tool_delta" }>, "delta" | "replace">;

/** SDK tool updates are output snapshots; user_bash has a separate delta event. */
export function toolOutputUpdate(partial: unknown): OutputUpdate | null {
	const content = (partial as { content?: unknown } | null | undefined)?.content;
	if (!Array.isArray(content)) return null;
	const text = content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").join("");
	return { delta: text, replace: true };
}
