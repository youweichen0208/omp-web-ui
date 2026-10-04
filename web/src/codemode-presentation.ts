/** Native raw-input arguments are stored as { code }; tolerate older raw strings. */
export function codemodeScript(argumentsText?: string): string {
	if (!argumentsText) return "";
	try { const value = JSON.parse(argumentsText); if (typeof value === "string") return value; if (typeof value?.code === "string") return value.code; } catch { /* incomplete stream */ }
	return argumentsText;
}
export function codemodeOptions(script: string): { max_output_tokens?: number; timeout_ms?: number } {
	const match = /^\s*\/\/\s*@options:\s*(\{[^\n]*\})/.exec(script);
	if (!match) return {};
	try { const value = JSON.parse(match[1]); return Object.fromEntries(["max_output_tokens", "timeout_ms"].filter(k => typeof value[k] === "number" && Number.isFinite(value[k]) && value[k] >= 0).map(k => [k, value[k]])); } catch { return {}; }
}
