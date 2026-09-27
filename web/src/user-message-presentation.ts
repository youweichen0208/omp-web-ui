/** Keep pasted box-drawing trees aligned when a user message is rendered as Markdown. */
export function preserveUserTree(text: string): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let fenced = false;
	for (let index = 0; index < lines.length;) {
		const line = lines[index];
		if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; result.push(line); index++; continue; }
		if (!fenced && /^\s*[│ ]*[├└]─{1,2}/.test(line)) {
			const previous = result.at(-1);
			const root = previous && previous.trim() && previous.length < 100 && !/^\s*(?:[-*#>]|\d+[.)])\s/.test(previous)
				? result.pop() : undefined;
			result.push("```text");
			if (root !== undefined) result.push(root);
			while (index < lines.length && /^\s*[│ ]*[├└]─{1,2}/.test(lines[index])) result.push(lines[index++]);
			result.push("```");
			continue;
		}
		result.push(line);
		index++;
	}
	return result.join("\n");
}
