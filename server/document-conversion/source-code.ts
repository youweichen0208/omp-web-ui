import { execFile } from "node:child_process";
import { dirname, extname, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { DocumentBlock, DocumentOrigin } from "../document-bundle.js";

const exec = promisify(execFile);
export const CODE_LANGUAGES: Record<string, string> = {
	".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp",
	".py": "python", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "jsx",
	".ts": "typescript", ".tsx": "tsx", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
	".rb": "ruby", ".php": "php", ".swift": "swift", ".sh": "bash", ".bash": "bash", ".ps1": "powershell",
	".sql": "sql", ".lua": "lua", ".r": "r", ".yaml": "yaml", ".yml": "yaml", ".json": "json", ".toml": "toml",
};

export async function sourceGitMetadata(path: string, signal?: AbortSignal): Promise<DocumentOrigin["git"]> {
	const git = async (args: string[], cwd = dirname(path)) => (await exec("git", ["-c", "core.fsmonitor=false", ...args], { cwd, signal, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout.trim();
	try {
		const repository = await git(["rev-parse", "--show-toplevel"]), commit = await git(["rev-parse", "--verify", "HEAD"]);
		let branch: string | undefined;
		try { branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]); } catch { signal?.throwIfAborted(); }
		const sourcePath = relative(repository, path).split(sep).join("/");
		let tracked = true;
		try { await git(["ls-files", "--error-unmatch", "--", sourcePath], repository); } catch { signal?.throwIfAborted(); tracked = false; }
		const dirty = !tracked || Boolean(await git(["status", "--porcelain=v1", "--untracked-files=all", "--", sourcePath], repository));
		return { repository, commit, ...(branch ? { branch } : {}), path: sourcePath, dirty };
	} catch { signal?.throwIfAborted(); return undefined; }
}

export function sourceCodeMarkdown(text: string, path: string, git?: DocumentOrigin["git"]): { markdown: string; blocks: DocumentBlock[] } {
	const lines = text.split("\n"); if (lines.at(-1) === "") lines.pop();
	const language = CODE_LANGUAGES[extname(path).toLowerCase()] ?? "text";
	const blocks: DocumentBlock[] = [];
	for (let start = 0; start < lines.length; start += 120) {
		const code = lines.slice(start, start + 120).join("\n"), end = Math.min(start + 120, lines.length);
		const fence = "`".repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(match => match[0].length + 1)));
		blocks.push({ id: `block-${blocks.length + 1}`, text: `${fence}${language}\n${code}\n${fence}`, locator: { path: git?.path ?? path, lineStart: start + 1, lineEnd: end, ...(git ? { repository: git.repository, commit: git.commit, dirty: git.dirty } : {}) } });
	}
	return { markdown: blocks.map(block => `## Lines ${block.locator.lineStart}–${block.locator.lineEnd}\n\n${block.text}`).join("\n\n") + "\n", blocks };
}
