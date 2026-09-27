/** Keep pasted box-drawing trees aligned when a user message is rendered as Markdown. */
export function preserveUserTree(text: string): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let fenced = false;
	for (let index = 0; index < lines.length;) {
		const line = lines[index];
		if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; result.push(line); index++; continue; }
		if (!fenced && isPastedTableStart(lines, index)) {
			result.push("```ascii-table");
			while (index < lines.length && lines[index].trim()) result.push(lines[index++]);
			result.push("```");
			continue;
		}
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
		result.push(fenced ? line : linkifyFilePaths(line));
		index++;
	}
	return result.join("\n");
}

function isPastedTableStart(lines: string[], index: number): boolean {
	if (!lines[index]?.trim() || !isBoxRule(lines[index + 1] ?? "")) return false;
	let rules = 0;
	for (let cursor = index + 1; cursor < lines.length && cursor < index + 20 && lines[cursor].trim(); cursor++) {
		if (isBoxRule(lines[cursor])) rules++;
	}
	return rules >= 2;
}

function isBoxRule(line: string): boolean {
	const compact = line.replace(/\s/g, "");
	return compact.length >= 20 && /[─━═╌┄┈┉]/.test(compact) &&
		(compact.match(/[─━═╌┄┈┉│┃┌┐└┘├┤┼┬┴╭╮╰╯]/g)?.length ?? 0) / compact.length >= 0.7;
}

function linkifyFilePaths(line: string): string {
	if (line.includes("](")) return line;
	return line.split(/(`[^`]*`)/g).map((part) => part.startsWith("`") ? part : part.replace(
		/(^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+):([1-9]\d*)/g,
		(_, prefix: string, path: string, lineNumber: string) => `${prefix}[${path}:${lineNumber}](#pi-file=${encodeURIComponent(path)}:${lineNumber})`,
	)).join("");
}
