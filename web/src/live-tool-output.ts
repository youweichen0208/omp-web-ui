import type { ServerMessage } from "../../server/protocol.js";

type OutputUpdate = Pick<Extract<ServerMessage, { type: "tool_delta" }>, "delta" | "replace">;

const MAX_LIVE_OUTPUT = 200_000;

export function mergeLiveToolOutput(previous: string, update: OutputUpdate): string {
	const text = update.replace ? update.delta : previous + update.delta;
	return text.length > MAX_LIVE_OUTPUT
		? `…[前 ${text.length - MAX_LIVE_OUTPUT} 字符已省略]…\n${text.slice(-MAX_LIVE_OUTPUT)}`
		: text;
}
