/** Bridge application appearance changes to the xterm CSS-variable palette. */
export const THEME_CHANGE_EVENT = "pi-harness:theme-change";

/** CSS variable → xterm theme. Reads the --term-* palette from the current
 * stylesheet, so the terminal canvas always matches the app's palette.
 * The stylesheet is the single source of palette values. */
export function buildTermTheme(): Record<string, string> {
	const cs = getComputedStyle(document.documentElement);
	const v = (name: string) => cs.getPropertyValue(name).trim();
	return {
		background: v("--term-bg"),
		foreground: v("--term-fg"),
		cursor: v("--term-cursor"),
		cursorAccent: v("--term-cursor-accent"),
		selectionBackground: v("--term-selection"),
		black: v("--term-black"),
		red: v("--term-red"),
		green: v("--term-green"),
		yellow: v("--term-yellow"),
		blue: v("--term-blue"),
		magenta: v("--term-magenta"),
		cyan: v("--term-cyan"),
		white: v("--term-white"),
		brightBlack: v("--term-bright-black"),
		brightRed: v("--term-bright-red"),
		brightGreen: v("--term-bright-green"),
		brightYellow: v("--term-bright-yellow"),
		brightBlue: v("--term-bright-blue"),
		brightMagenta: v("--term-bright-magenta"),
		brightCyan: v("--term-bright-cyan"),
		brightWhite: v("--term-bright-white"),
	};
}
