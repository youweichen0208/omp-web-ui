import type { WikiApiError } from "./types";
export class WikiRequestError extends Error {
	constructor(public readonly detail: WikiApiError) { super(detail.error); }
}
import { withToken } from "./auth-token";
import { getClientId } from "./use-chat";
export async function wikiRequest<T>(cwd: string, action: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
	const response = await fetch(withToken("/api/wiki"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...args, clientId: getClientId(), cwd, action }), signal });
	const data = await response.json();
	if (!response.ok) throw new WikiRequestError({ ...data, error: data.error || response.statusText });
	return data;
}
export function wikiMedia(cwd: string, path: string, download = false): string {
	return withToken("/api/wiki-media?" + new URLSearchParams({ clientId: getClientId(), cwd, path, ...(download ? { download: "1" } : {}) }));
}
