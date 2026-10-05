/** Native insertLineBreak uses BR nodes; textContent would silently lose them. */
export function richCodeText(code: HTMLElement): string {
	const clone = code.cloneNode(true) as HTMLElement;
	clone.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
	return clone.textContent ?? "";
}
