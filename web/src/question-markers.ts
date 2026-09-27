/** Merge marks that would visually overlap on the question rail. */
export function questionPreviewText(text: string): string {
	return text.trim().replace(/^\d+[.)、．]\s*/, "").replace(/\s+/g, " ");
}

export function clusterQuestionMarkers(
	markers: readonly { id: string; position: number }[],
	railHeight: number,
	minGapPx = 32,
): { ids: string[]; position: number }[] {
	const groups: { ids: string[]; positions: number[] }[] = [];
	for (const marker of [...markers].sort((a, b) => a.position - b.position)) {
		const previous = groups.at(-1);
		if (previous && (marker.position - previous.positions.at(-1)!) * railHeight < minGapPx) {
			previous.ids.push(marker.id);
			previous.positions.push(marker.position);
		} else groups.push({ ids: [marker.id], positions: [marker.position] });
	}
	return groups.map(({ ids, positions }) => ({ ids, position: positions.reduce((sum, value) => sum + value, 0) / positions.length }));
}
