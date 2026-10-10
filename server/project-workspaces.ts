import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ProjectWorkspaceAction, ProjectWorkspaceCatalog } from "./protocol.js";
import { writeFileAtomic } from "./private-file.js";

/** UI-only catalog. No session or filesystem deletion belongs to this module. */
export class ProjectWorkspaceStore {
	private catalog: ProjectWorkspaceCatalog | undefined;

	constructor(private readonly file: string) {}

	read(): ProjectWorkspaceCatalog {
		if (!this.catalog) {
			let data: unknown;
			try { data = JSON.parse(readFileSync(this.file, "utf8")); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				data = { revision: 0, workspaces: [] };
			}
			if (!validCatalog(data)) throw new Error("Invalid project workspace catalog");
			this.catalog = data;
		}
		return structuredClone(this.catalog);
	}

	apply(revision: number, action: ProjectWorkspaceAction): { catalog: ProjectWorkspaceCatalog; workspaceId: string } {
		const next = this.read();
		if (revision !== next.revision) throw new Error("Workspace changed in another window. Refresh and retry.");
		if (!action || typeof action !== "object") throw new Error("Invalid workspace action");
		let workspaceId: string;
		if (action.kind === "create") {
			if (next.workspaces.length >= 100) throw new Error("Workspace limit reached (100)");
			const name = checkedName(action.name);
			checkDuplicate(next, name);
			workspaceId = randomUUID();
			next.workspaces.push({ id: workspaceId, name, paths: [] });
		} else {
			const group = next.workspaces.find((entry) => entry.id === action.id);
			if (!group) throw new Error("Workspace no longer exists");
			workspaceId = group.id;
			switch (action.kind) {
				case "rename": {
					const name = checkedName(action.name);
					checkDuplicate(next, name, group.id);
					group.name = name;
					break;
				}
				case "delete": next.workspaces = next.workspaces.filter((entry) => entry.id !== group.id); break;
				case "add": {
					if (typeof action.path !== "string" || !isAbsolute(action.path)) throw new Error("Project path must be absolute");
					const path = resolve(action.path);
					if (!statSync(path).isDirectory()) throw new Error("Project path must be a directory");
					if (!group.paths.includes(path)) {
						if (group.paths.length >= 1000) throw new Error("Project limit reached (1000 per workspace)");
						group.paths.push(path);
					}
					break;
				}
				case "remove": {
					if (typeof action.path !== "string" || !isAbsolute(action.path)) throw new Error("Project path must be absolute");
					// Missing directories can still be removed from a group.
					group.paths = group.paths.filter((path) => path !== resolve(action.path));
					break;
				}
				default: throw new Error("Invalid workspace action");
			}
		}
		next.revision++;
		writeFileAtomic(this.file, JSON.stringify(next, null, "\t") + "\n");
		this.catalog = next;
		return { catalog: structuredClone(next), workspaceId };
	}
}

function checkedName(value: unknown): string {
	if (typeof value !== "string") throw new Error("Workspace name is required");
	const name = value.trim().normalize("NFC");
	if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Workspace name must contain 1–80 characters without control characters");
	return name;
}

function checkDuplicate(catalog: ProjectWorkspaceCatalog, name: string, exceptId?: string): void {
	if (catalog.workspaces.some((group) => group.id !== exceptId && group.name.toLowerCase() === name.toLowerCase())) {
		throw new Error("Workspace name already exists");
	}
}

function validCatalog(value: unknown): value is ProjectWorkspaceCatalog {
	if (!value || typeof value !== "object") return false;
	const data = value as ProjectWorkspaceCatalog;
	if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.workspaces) || data.workspaces.length > 100) return false;
	const ids = new Set<string>();
	const names = new Set<string>();
	return data.workspaces.every((group) => {
		if (!group || typeof group.id !== "string" || !group.id || ids.has(group.id)) return false;
		try { if (checkedName(group.name) !== group.name || names.has(group.name.toLowerCase())) return false; } catch { return false; }
		ids.add(group.id); names.add(group.name.toLowerCase());
		return Array.isArray(group.paths) && group.paths.length <= 1000 && group.paths.every((path) => typeof path === "string" && isAbsolute(path)) && new Set(group.paths).size === group.paths.length;
	});
}
