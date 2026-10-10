import { useLayoutEffect, useRef } from "react";

const dialogs: HTMLElement[] = [];
export const isTopDialog = (root: HTMLElement | null) => !!root && dialogs.at(-1) === root;
const focusable = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Keep keyboard traversal in the topmost dialog and restore its opener. */
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>(active = true) {
	const ref = useRef<T>(null);
	const openerRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
	const menuTriggerRef = useRef(openerRef.current?.closest(".dropdown")?.querySelector<HTMLElement>(":scope > button") ?? null);
	const previouslyActive = useRef(false);
	if (active && !previouslyActive.current) {
		openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		menuTriggerRef.current = openerRef.current?.closest(".dropdown")?.querySelector<HTMLElement>(":scope > button") ?? null;
	}
	previouslyActive.current = active;
	useLayoutEffect(() => {
		const root = ref.current;
		if (!active || !root) return;
		const opener = openerRef.current;
		dialogs.push(root);
		const controls = () => Array.from(root.querySelectorAll<HTMLElement>(focusable)).filter(element =>
			!element.matches(':disabled, [aria-disabled="true"]') && !element.closest('[inert]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
		);
		if (dialogs.at(-1) === root && !root.contains(document.activeElement)) (controls()[0] ?? root).focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || dialogs.at(-1) !== root) return;
			const items = controls();
			const current = document.activeElement;
			if (!items.length) { event.preventDefault(); root.focus(); return; }
			if (!root.contains(current) || event.shiftKey && current === items[0] || !event.shiftKey && current === items.at(-1)) {
				event.preventDefault();
				(event.shiftKey ? items.at(-1)! : items[0]).focus();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			const topmost = dialogs.at(-1) === root;
			const index = dialogs.indexOf(root);
			if (index !== -1) dialogs.splice(index, 1);
			const restore = opener?.isConnected ? opener : menuTriggerRef.current;
			if (topmost && restore?.isConnected) restore.focus({ preventScroll: true });
		};
	}, [active]);
	return ref;
}
