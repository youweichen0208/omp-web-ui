import { THEME_CHANGE_EVENT } from "./theme";

export type Appearance = "light" | "dark" | "system";
const KEY = "pi-web-ui:appearance";

export function getAppearance(): Appearance {
	try {
		const value = localStorage.getItem(KEY);
		return value === "dark" || value === "system" ? value : "light";
	} catch { return "light"; }
}

function apply(value: Appearance = getAppearance()) {
	document.documentElement.dataset.appearance = value === "system"
		? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
		: value;
	window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

export function setAppearance(value: Appearance) {
	try { localStorage.setItem(KEY, value); } catch { /* private browsing */ }
	apply(value);
}

export function initAppearance() {
	apply();
	matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		if (getAppearance() === "system") apply();
	});
	window.addEventListener("storage", event => { if (event.key === KEY || event.key === null) apply(); });
}
