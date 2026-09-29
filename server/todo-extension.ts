import { createRequire } from "node:module";
import type { Extension, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TODO_EXTENSION_PATH = createRequire(import.meta.url).resolve("@juicesharp/rpiv-todo/index.ts");

export const TODO_GUIDANCE = [
	"Use todo to track clearly scoped, authorized multi-stage work. Questions, small changes, clarification interviews and design discussions do not require an implementation checklist. Follow the user's instructions and the active skill's workflow, including waiting for answers when required. Recording tasks does not authorize implementation or add approval requirements to already-authorized work.",
	"Create short task subjects in the user's language, with details in description. Aim for 3–7 meaningful steps, adapting to the work. Put the overall title and completionCriteria in metadata on the first task. When revising the outline, record metadata.changeSummary on the affected task.",
	"Keep one task in_progress while working, and mark it completed only when its completion criteria are met. A reply ending or waiting for the user does not complete unfinished tasks. Resume the existing list across turns; clear it only when starting a genuinely different task. Completed tasks cannot be reopened: create a follow-up task instead.",
	"Change status with todo({action:'update',id,status:'in_progress'|'completed'|'pending'}); use activeForm for the current activity. Use blockedBy for dependencies and addBlockedBy/removeBlockedBy to update them. A task with unfinished dependencies must wait. list/get inspect existing tasks; delete removes a task from the outline.",
];

/** Adapt the pinned extension's presentation and prompting; upstream owns mutations/replay. */
export function adaptTodoExtensions(extensions: Extension[]): Extension[] {
	let found = false;
	return extensions.flatMap((extension) => {
		if (!extension.resolvedPath.replaceAll("\\", "/").includes("/@juicesharp/rpiv-todo/")) return [extension];
		// The bundled path is loaded first; ignore a second user-installed copy.
		if (found) return [];
		found = true;
		const tools = new Map(extension.tools);
		const todo = tools.get("todo");
		if (todo) tools.set("todo", { ...todo, definition: { ...todo.definition, promptSnippet: "Track authorized multi-stage work", promptGuidelines: TODO_GUIDANCE } });
		const handlers = new Map(extension.handlers);
		// Keep session replay, but let the Web task panel own rendering. In particular,
		// never let upstream's process-wide foreground overlay bind to one Web client.
		handlers.set("session_start", (handlers.get("session_start") ?? []).map((handler) => async (...args: unknown[]) => {
			const ctx = args[1] as ExtensionContext;
			return handler(args[0], new Proxy(ctx, { get: (target, key) => key === "hasUI" ? false : Reflect.get(target, key) }));
		}));
		return [{ ...extension, tools, handlers, shortcuts: new Map() }];
	});
}
