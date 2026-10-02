/** Shared host tool deadline; bounded subagent waits use half of this value. */
export const DEFAULT_TOOL_TIMEOUT_MS = 20 * 60_000;
export function toolWatchdogTimeout(): number {
	const value = Number(process.env.PI_WEB_TOOL_TIMEOUT_MS);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_TOOL_TIMEOUT_MS;
}
