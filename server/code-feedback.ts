import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CodeDiagnostic } from "./protocol.js";
import { codeManager, languageOf } from "./code-intelligence.js";
interface Change {
	path: string;
	before: string;
	baseline?: CodeDiagnostic[];
}
export function changedLines(before: string, after: string): [number, number] {
	const a = before.split("\n"),
		b = after.split("\n");
	let start = 0,
		end = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	while (
		end < a.length - start &&
		end < b.length - start &&
		a[a.length - end - 1] === b[b.length - end - 1]
	)
		end++;
	return [Math.max(1, start + 1 - 5), Math.max(start + 1, b.length - end) + 5];
}
export const diagnosticKey = (d: CodeDiagnostic) =>
	`${d.path}:${d.line}:${d.column}:${d.code}:${d.message}`;
/** Result-only feedback: nested edits are accumulated on their outermost call. */
export function codeFeedback(cwd: string, owner: string): ExtensionFactory {
	return (pi) => {
		const parents = new Map<string, string>();
		const changes = new Map<string, Change>();
		const batches = new Map<string, Map<string, Change>>();
		const root = (id: string) => {
			const seen = new Set<string>();
			while (parents.has(id) && !seen.has(id)) {
				seen.add(id);
				id = parents.get(id)!;
			}
			return id;
		};
		const clear = () => {
			parents.clear();
			changes.clear();
			batches.clear();
			void codeManager().busy(cwd, owner, false);
		};
		pi.on("agent_start", () => {
			void codeManager().busy(cwd, owner, true);
		});
		pi.on("agent_settled", clear);
		pi.on("session_shutdown", clear);
		pi.on("tool_call", async (event) => {
			if (event.parentToolCallId)
				parents.set(event.toolCallId, event.parentToolCallId);
			if (event.toolName !== "edit" && event.toolName !== "write") return;
			const path = (event.input as { path?: unknown }).path;
			if (typeof path !== "string" || !languageOf(path)) return;
			const manager = codeManager();
			const settings = manager.settingsFor(cwd);
			if (!settings.enabled) return;
			if (!settings.feedback) {
				changes.set(event.toolCallId, { path, before: "" });
				return;
			}
			try {
				const file = await manager.file(cwd, path);
				changes.set(event.toolCallId, {
					path: file.path,
					before: file.text,
					baseline: await manager.baseline(cwd, file.path),
				});
			} catch {
				changes.set(event.toolCallId, { path, before: "" });
			}
		});
		pi.on("tool_result", async (event) => {
			const manager = codeManager(),
				change = changes.get(event.toolCallId);
			changes.delete(event.toolCallId);
			if (change && !event.isError) {
				const id = root(event.toolCallId);
				let batch = batches.get(id);
				if (!batch) {
					batch = new Map();
					batches.set(id, batch);
				}
				if (!batch.has(change.path)) batch.set(change.path, change);
				void manager.touch(cwd, change.path).catch(() => {});
			}
			if (event.parentToolCallId) return;
			const batch = batches.get(event.toolCallId);
			batches.delete(event.toolCallId);
			parents.delete(event.toolCallId);
			if (!batch?.size) return;
			const settings = manager.settingsFor(cwd);
			if (!settings.feedback) return;
			const started = Date.now(),
				controller = new AbortController();
			let timer: NodeJS.Timeout | undefined;
			const work = Promise.all(
				[...batch.values()].map(async (change) => {
					try {
						const result = (await manager.query(
							cwd,
							{ action: "diagnostics", path: change.path },
							controller.signal,
						)) as { freshness: string; diagnostics: CodeDiagnostic[] };
						const file = await manager.file(cwd, change.path);
						const interval = changedLines(change.before, file.text),
							prior = new Set(change.baseline?.map(diagnosticKey));
						const diagnostics = result.diagnostics.filter(
							(d) =>
								!d.analysisLimitation &&
								d.severity <= 2 &&
								(change.baseline
									? !prior.has(diagnosticKey(d))
									: d.line >= interval[0] && d.line <= interval[1]),
						);
						return `${change.path} (${result.freshness})${languageOf(change.path) === "rust" ? " — partial Rust native analysis; no Cargo check, borrow checking or macro expansion" : ""}${change.baseline ? "" : " — possibly pre-existing; not necessarily caused by this edit"}\n${diagnostics
							.slice(0, 10)
							.map((d) => `${d.line}:${d.column} ${d.message}`)
							.join("\n")}`;
					} catch {
						return `${change.path}: unavailable`;
					}
				}),
			);
			try {
				const value = await Promise.race([
					work,
					new Promise<string[]>((resolve) => {
						timer = setTimeout(
							() =>
								resolve([...batch.keys()].map((path) => `${path}: pending`)),
							1200,
						);
					}),
				]);
				return {
					content: [
						...event.content,
						{
							type: "text" as const,
							text: (
								"\nCode diagnostics (opened files only):\n" + value.join("\n")
							).slice(0, 4000),
						},
					],
					structuredContent: event.structuredContent,
					details: event.details,
					isError: event.isError,
					usage: event.usage,
				};
			} finally {
				if (timer) clearTimeout(timer);
				controller.abort();
				void manager.recordWait(cwd, Date.now() - started);
			}
		});
	};
}
