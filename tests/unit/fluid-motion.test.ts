import { expect, it } from "vitest";
import { springStep, drawerDestination, rubberband } from "../../web/src/fluid-motion.js";
it("retargets from the presentation value with continuous velocity", () => {
	const moving = springStep(300, 0, 0, 0.1);
	const reversed = springStep(moving.position, moving.velocity, 300, 0);
	expect(reversed.position).toBeCloseTo(moving.position);
	expect(reversed.velocity).toBeCloseTo(moving.velocity);
	let next = moving;
	for (let i = 0; i < 100; i++) next = springStep(next.position, next.velocity, 300, 1 / 60);
	expect(next.position).toBeCloseTo(300, 2);
	expect(next.velocity).toBeCloseTo(0, 2);
});
it("settles identically at different frame rates without overshoot from rest", () => {
	const run = (fps: number) => { let s = { position: 300, velocity: 0 }; for (let i = 0; i < fps; i++) { s = springStep(s.position, s.velocity, 0, 1 / fps); expect(s.position).toBeGreaterThanOrEqual(0); } return s; };
	expect(run(30).position).toBeCloseTo(run(120).position, 5);
});
it("projects release momentum and resists outside the drawer bounds", () => {
	expect(drawerDestination(60, 900, 300)).toBe(300);
	expect(drawerDestination(200, -900, 300)).toBe(0);
	expect(rubberband(150, 300)).toBe(150);
	expect(rubberband(-100, 300)).toBeGreaterThan(-100);
	expect(rubberband(-100, 300)).toBeLessThan(0);
	expect(rubberband(400, 300)).toBeGreaterThan(300);
	expect(rubberband(400, 300)).toBeLessThan(400);
});
