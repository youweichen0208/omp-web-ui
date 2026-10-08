import type { UiMessage } from "../../server/protocol.js";
import { toolTextIncidents } from "../../server/tool-text-incidents.js";
export { toolTextIncidents, projectToolTextMessages } from "../../server/tool-text-incidents.js";
export type { ToolTextIncident } from "../../server/tool-text-incidents.js";
export { unexecutedToolText } from "../../server/tool-text.js";

/** The recovery action always belongs to the original user, never the reminder. */
export function latestToolTextFailure(messages: readonly UiMessage[], streaming = false) {
	const { current } = toolTextIncidents(messages, streaming);
	return !streaming && current?.state === "stopped" ? { message: current.last, user: current.user } : null;
}
