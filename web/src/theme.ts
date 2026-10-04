/** Bridge application appearance changes to the xterm CSS-variable palette. */
export const THEME_CHANGE_EVENT = "pi-web-ui:theme-change";

/** CSS variable → xterm theme. Reads the --term-* palette from the current
 * stylesheet, so the terminal canvas always matches the app's palette.
 * Defaults mirror the bundled (only) theme. */
export function buildTermTheme(): Record<string, string> {
	const cs = getComputedStyle(document.documentElement);
	const v = (name: string, fallback: string) => {
		const val = cs.getPropertyValue(name).trim();
		return val || fallback;
	};
	return {
		background: v("--term-bg", "#1b1f24"),
		foreground: v("--term-fg", "#e6e8ef"),
		cursor: v("--term-cursor", "#c2663f"),
		cursorAccent: v("--term-cursor-accent", "#1b1f24"),
		selectionBackground: v("--term-selection", "rgba(194, 102, 63, 0.35)"),
		black: v("--term-black", "#2a2f37"),
		red: v("--term-red", "#f87171"),
		green: v("--term-green", "#34d399"),
		yellow: v("--term-yellow", "#fbbf24"),
		blue: v("--term-blue", "#60a5fa"),
		magenta: v("--term-magenta", "#c084fc"),
		cyan: v("--term-cyan", "#22d3ee"),
		white: v("--term-white", "#e6e8ef"),
		brightBlack: v("--term-bright-black", "#6b7284"),
		brightRed: v("--term-bright-red", "#f87171"),
		brightGreen: v("--term-bright-green", "#34d399"),
		brightYellow: v("--term-bright-yellow", "#fbbf24"),
		brightBlue: v("--term-bright-blue", "#60a5fa"),
		brightMagenta: v("--term-bright-magenta", "#c084fc"),
		brightCyan: v("--term-bright-cyan", "#22d3ee"),
		brightWhite: v("--term-bright-white", "#ffffff"),
	};
}
