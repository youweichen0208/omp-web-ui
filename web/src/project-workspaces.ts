import type { ProjectSummary, ProjectWorkspaceCatalog } from "../../server/protocol.js";

/** Catalog membership survives eviction from the recent-project list. */
export function workspaceProjects(projects: ProjectSummary[], catalog: ProjectWorkspaceCatalog | null, selectedId: string, query: string): ProjectSummary[] {
	const all = new Map(projects.map((project) => [project.path, project]));
	for (const group of catalog?.workspaces ?? []) {
		for (const path of group.paths) {
			if (!all.has(path)) all.set(path, { path, firstAdded: 0, lastUsed: 0 });
		}
	}
	const group = catalog?.workspaces.find((entry) => entry.id === selectedId);
	const members = group ? new Set(group.paths) : null;
	const needle = query.trim().toLowerCase();
	return [...all.values()].filter((project) => (!members || members.has(project.path)) && project.path.toLowerCase().includes(needle));
}
