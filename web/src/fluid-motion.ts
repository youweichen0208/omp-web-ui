/** Exact critically damped spring step: re-target without resetting velocity. */
export function springStep(position: number, velocity: number, target: number, seconds: number, response = 0.32) {
	const omega = 2 * Math.PI / response;
	const delta = position - target;
	const c = velocity + omega * delta;
	const decay = Math.exp(-omega * seconds);
	return { position: target + (delta + c * seconds) * decay, velocity: (velocity - omega * c * seconds) * decay };
}

export function drawerDestination(position: number, velocity: number, width: number): number {
	return position + velocity * 0.2 > width / 2 ? width : 0;
}

export function rubberband(position: number, width: number): number {
	const bound = position < 0 ? 0 : width;
	if (position >= 0 && position <= width) return position;
	const delta = position - bound;
	return bound + delta * 0.35 / (1 + Math.abs(delta) / width);
}
