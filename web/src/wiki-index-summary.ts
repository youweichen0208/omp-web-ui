import type { WikiIndexIssue } from "../../server/protocol.js";

/** Count each reported path under its actual limit, never under the first issue. */
export function wikiIndexIssueGroups(issues: readonly WikiIndexIssue[]) {
	const counts = new Map<WikiIndexIssue["reason"], number>();
	for (const issue of issues) counts.set(issue.reason, (counts.get(issue.reason) ?? 0) + 1);
	return [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}
