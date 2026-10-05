/** Display only: preserve the real path for tooltips and directory editing. */
export function compactWorkspacePath(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	const home = normalized.replace(/^(?:\/(?:Users|home)\/[^/]+|[a-zA-Z]:\/Users\/[^/]+)(?=\/|$)/, "~");
	const parts = home.split("/");
	return parts.length > 3 ? `${parts.slice(0, 2).join("/")}/…/${parts.at(-1)}` : home;
}
