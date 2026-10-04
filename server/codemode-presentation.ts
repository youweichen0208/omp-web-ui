import type { UiCodemodeDetails } from "./protocol.js";

/** Allowlist native renderer details; never forward arbitrary extension metadata. */
export function codemodeDetails(value: unknown): UiCodemodeDetails | undefined {
	if (!value || typeof value !== "object" || !Array.isArray((value as { calls?: unknown }).calls)) return;
	const raw = value as { calls: unknown[]; fullOutputPath?: unknown };
	const calls: UiCodemodeDetails["calls"] = [];
	for (const item of raw.calls.slice(0, 256)) {
		if (!item || typeof item !== "object") continue;
		const call = item as Record<string, unknown>;
		if (typeof call.id !== "string" || typeof call.name !== "string" || !["running", "ok", "error", "cancelled"].includes(String(call.status))) continue;
		calls.push({ id: call.id.slice(0, 500), name: call.name.slice(0, 300), args: typeof call.args === "string" ? call.args.slice(0, 4000) : "", status: call.status as UiCodemodeDetails["calls"][number]["status"],
			...(typeof call.durationMs === "number" && Number.isFinite(call.durationMs) && call.durationMs >= 0 ? { durationMs: call.durationMs } : {}),
			...(typeof call.cost === "number" && Number.isFinite(call.cost) && call.cost >= 0 ? { cost: call.cost } : {}),
			...(typeof call.error === "string" ? { error: call.error.slice(0, 4000) } : {}),
		});
	}
	return { calls, totalCalls: raw.calls.length, ...(typeof raw.fullOutputPath === "string" ? { fullOutputPath: raw.fullOutputPath.slice(0, 4096) } : {}) };
}
