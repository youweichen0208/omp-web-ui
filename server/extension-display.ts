/** Display-only metadata. Toggle/uninstall identities remain owned by the loader. */
export function extensionDisplay(path: string, source?: string, bundledTodoPath?: string): { name: string; builtin?: "todo" } {
	const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
	if (bundledTodoPath && normalized === bundledTodoPath.replaceAll("\\", "/")) {
		return { name: "rpiv-todo", builtin: "todo" };
	}
	if (source?.startsWith("npm:")) return { name: source.slice(4) };
	const marker = "/node_modules/";
	const packagePath = normalized.slice(normalized.lastIndexOf(marker) + marker.length);
	if (normalized.includes(marker)) {
		const parts = packagePath.split("/");
		const name = parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
		if (name) return { name };
	}
	const parts = normalized.split("/").filter(Boolean);
	const filename = parts.pop() ?? "";
	const stem = filename.replace(/\.(?:[cm]?[jt]s|tsx|jsx)$/i, "");
	if (!/^(?:index|main|extension|plugin)$/i.test(stem)) return { name: stem || source || path };
	// Entry points commonly sit in build/source folders beneath the extension.
	while (parts.length && /^(?:src|dist|lib|build|extensions?|\.pi)$/i.test(parts.at(-1)!)) parts.pop();
	return { name: parts.at(-1) || source || filename };
}
