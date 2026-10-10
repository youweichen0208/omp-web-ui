import { useLayoutEffect, useRef, type ReactNode } from "react";
import { FiX } from "react-icons/fi";
import { drawerDestination, rubberband, springStep } from "../fluid-motion";
import { useT } from "../i18n";

/** Overlay motion is imperative; streaming React renders never restart a spring. */
export function FluidDrawer({ side, open, overlay, className, label, onClose, onOpen, children }: {
	side: "left" | "right"; open: boolean; overlay: boolean; className: string;
	label: string; onClose: () => void; onOpen: () => void; children: ReactNode;
}) {
	const t = useT();
	const root = useRef<HTMLDivElement>(null);
	const grip = useRef<HTMLDivElement>(null);
	const state = useRef({ open, onClose, onOpen });
	state.current = { open, onClose, onOpen };
	const retarget = useRef<() => void>(() => {});
	useLayoutEffect(() => {
		const el = root.current!;
		if (!overlay) { el.inert = false; return; }
		const reduced = matchMedia("(prefers-reduced-motion: reduce)");
		const direction = side === "left" ? -1 : 1;
		let width = el.getBoundingClientRect().width * 1.05;
		let position = width, velocity = 0, target = width, frame = 0, last = 0;
		let pointer: { id: number; x: number; origin: number; at: number; lastX: number; moved: boolean } | null = null;
		let restore: HTMLElement | null = null;
		const paint = () => {
			el.style.transform = `translate3d(${direction * position}px, 0, 0)`;
			el.inert = !state.current.open && Math.abs(position - width) < 0.5;
			el.style.visibility = el.inert ? "hidden" : "visible";
		};
		const tick = (now: number) => {
			const next = springStep(position, velocity, target, Math.min((now - last) / 1000, 0.064));
			position = next.position; velocity = next.velocity; last = now;
			if (Math.abs(position - target) < 0.25 && Math.abs(velocity) < 2) { position = target; velocity = 0; frame = 0; el.style.willChange = ""; paint(); return; }
			paint(); frame = requestAnimationFrame(tick);
		};
		const settle = () => {
			cancelAnimationFrame(frame); frame = 0;
			if (reduced.matches) { position = target; velocity = 0; paint(); }
			else { last = performance.now(); el.style.willChange = "transform"; frame = requestAnimationFrame(tick); }
		};
		const update = () => {
			target = state.current.open ? 0 : width;
			if (state.current.open) { el.inert = false; el.style.visibility = "visible"; }
			if (state.current.open && !restore) {
				restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
				el.querySelector<HTMLButtonElement>(".fluid-drawer-close")?.focus({ preventScroll: true });
			} else if (!state.current.open && restore) {
				if (el.contains(document.activeElement)) restore.focus({ preventScroll: true });
				restore = null;
			}
			settle();
		};
		retarget.current = update;
		paint(); update();
		const handle = grip.current!;
		const down = (event: PointerEvent) => {
			if (event.button !== 0 || !event.isPrimary || (event.target as Element).closest("button")) return;
			event.preventDefault();
			cancelAnimationFrame(frame); frame = 0;
			pointer = { id: event.pointerId, x: event.clientX, origin: position, at: event.timeStamp, lastX: event.clientX, moved: false };
			handle.setPointerCapture(event.pointerId);
		};
		const move = (event: PointerEvent) => {
			if (pointer?.id !== event.pointerId) return;
			const dx = event.clientX - pointer.x;
			if (!pointer.moved && Math.abs(dx) < 6) return;
			pointer.moved = true;
			const dt = event.timeStamp - pointer.at;
			if (dt > 0) velocity = direction * (event.clientX - pointer.lastX) / dt * 1000;
			pointer.lastX = event.clientX; pointer.at = event.timeStamp;
			position = rubberband(pointer.origin + direction * dx, width); paint();
		};
		const end = (event: PointerEvent) => {
			if (pointer?.id !== event.pointerId) return;
			const cancelled = event.type !== "pointerup";
			if (event.timeStamp - pointer.at > 100 || cancelled) velocity = 0;
			const close = !cancelled && pointer.moved && drawerDestination(position, velocity, width) === width;
			pointer = null;
			if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
			target = cancelled ? (state.current.open ? 0 : width) : close ? width : 0;
			settle(); if (close) state.current.onClose(); else if (!cancelled) state.current.onOpen();
		};
		const resize = new ResizeObserver(() => { width = el.getBoundingClientRect().width * 1.05; update(); });
		resize.observe(el);
		reduced.addEventListener("change", update);
		handle.addEventListener("pointerdown", down); handle.addEventListener("pointermove", move);
		for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(name, end as EventListener);
		return () => {
			cancelAnimationFrame(frame); resize.disconnect(); reduced.removeEventListener("change", update);
			handle.removeEventListener("pointerdown", down); handle.removeEventListener("pointermove", move);
			for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) handle.removeEventListener(name, end as EventListener);
			el.style.transform = ""; el.style.visibility = ""; el.style.willChange = ""; el.inert = false;
			retarget.current = () => {};
		};
	}, [overlay, side]);
	useLayoutEffect(() => { retarget.current(); }, [open]);
	return <div ref={root} className={className} data-fluid-drawer={overlay ? "overlay" : undefined}
		role={overlay ? "dialog" : undefined} aria-label={overlay ? label : undefined}
		onKeyDown={event => {
			if (!overlay || !open || event.defaultPrevented) return;
			if (event.key === "Escape") { event.stopPropagation(); onClose(); }
			if (event.key === "Tab") {
				const items = [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"], a[href]')].filter(el => el.getClientRects().length && !el.closest('[inert]'));
				const next = event.shiftKey ? items.at(-1) : items[0];
				if (document.activeElement === (event.shiftKey ? items[0] : items.at(-1))) { event.preventDefault(); next?.focus(); }
			}
		}}>
		{overlay && <div ref={grip} className="fluid-drawer-grip"><span>{label}</span><span className="fluid-drawer-handle" aria-hidden="true" /><button type="button" className="fluid-drawer-close" aria-label={t("close")} onClick={onClose}><FiX /></button></div>}
		{children}
	</div>;
}
