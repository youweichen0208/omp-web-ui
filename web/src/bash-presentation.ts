/** Only trim search-result indentation, never whitespace in ordinary code output. */
export function compactSearchLine(line: string) {
	return line.replace(/^(\s*(?:[^:\s]+:)?\d+[:-])[ \t]+(?=\S)/, "$1 ");
}

/** Reuse grep's source line in the gutter instead of adding a second count. */
export function numberedOutputLine(raw: string, index: number, searchOutput: boolean | "mixed" = false): { number: string; text: string } {
	// A chained command can print dates, separators and other output before grep.
	// In that case only path:line: records identify their source unambiguously.
	const match = searchOutput === "mixed" ? /^([^:\s]+):(\d+):\s*(.*)$/.exec(raw)
		: searchOutput ? /^(?:([^:\s]+):)?(\d+):\s*(.*)$/.exec(raw) : null;
	return match
		? { number: match[2], text: match[1] ? `${match[1]}: ${match[3]}` : match[3] }
		: { number: String(index + 1), text: raw };
}

/** The SDK flattens stdout and stderr into one string, so this is a visual
 * hint for recognizable failures, not a claim about the original stream. */
export function isLikelyErrorLine(line: string): boolean {
	return /^(?:stderr\b|fatal:|error:|[^:\n]+:\s.*(?:No such file or directory|Permission denied|command not found|not found|cannot access|failed|error))/i.test(line.trim());
}

export function selectVisibleOutputLines(lines: string[], expanded: boolean): number[] {
	if (expanded || lines.length <= 8) return lines.map((_, index) => index);
	const visible = new Set<number>();
	for (let index = 0; index < Math.min(5, lines.length); index++) visible.add(index);
	for (let index = Math.max(0, lines.length - 3); index < lines.length; index++) visible.add(index);
	for (let index = 0; index < lines.length; index++) if (isLikelyErrorLine(lines[index])) visible.add(index);
	return [...visible].sort((a, b) => a - b);
}

/** Shorten the current user's home in display text only; copied commands stay exact. */
export function displayBashCommand(command: string, cwd: string): string {
	const home = /^\/(?:Users|home)\/[^/]+/.exec(cwd)?.[0];
	return home ? command.replaceAll(home, "~") : command;
}

export function searchOutputKind(argumentsText?: string): "standalone" | "mixed" | "none" {
	try {
		const command = (JSON.parse(argumentsText ?? "{}") as { command?: unknown }).command;
		if (typeof command !== "string" || !/(?:^|[;&|(\s])(?:grep|rg)\s+(?:-[\w-]*n[\w-]*\s+|--line-number\s+)/.test(command)) return "none";
		return /^\s*(?:grep|rg)\b/.test(command) && !/[;&|]/.test(command) ? "standalone" : "mixed";
	} catch { return "none"; }
}
export function isSearchCommand(argumentsText?: string): boolean { return searchOutputKind(argumentsText) !== "none"; }
export function differentCommandDirectory(argumentsText: string | undefined, cwd: string): string | null {
	try {
		const args = JSON.parse(argumentsText ?? "{}");
		const literal = typeof args.cwd === "string" ? args.cwd : typeof args.command === "string"
			? /^\s*cd\s+(?:"([^"$`]+)"|'([^']+)'|([^\s;&|$`]+))\s*&&/.exec(args.command)?.slice(1).find(Boolean) : undefined;
		if (!literal || /[$`*?]/.test(literal)) return null;
		const home = /^(\/(?:Users|home)\/[^/]+)/.exec(cwd)?.[1];
		const path = literal.startsWith("~/") && home ? home + literal.slice(1) : literal.startsWith("/") ? literal : `${cwd}/${literal}`;
		const parts: string[] = [];
		for (const part of path.split("/")) { if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part); }
		const normalized = "/" + parts.join("/");
		if (normalized === cwd.replace(/\/$/, "")) return null;
		return home && (normalized === home || normalized.startsWith(home + "/")) ? "~" + normalized.slice(home.length) : normalized;
	} catch { return null; }
}
