export type CodeTheme = "light" | "dark" | "system";

const KEY = "pi-web-ui:code-theme";
export const CODE_THEME_EVENT = "pi-web-ui:code-theme";

export function getCodeTheme(): CodeTheme {
	try {
		const value = localStorage.getItem(KEY);
		return value === "dark" || value === "system" ? value : "light";
	} catch {
		return "light";
	}
}

export function setCodeTheme(value: CodeTheme): void {
	try { localStorage.setItem(KEY, value); } catch { /* private mode */ }
	window.dispatchEvent(new Event(CODE_THEME_EVENT));
}
