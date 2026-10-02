import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CodeQuery } from "./protocol.js";
import { codeManager } from "./code-intelligence.js";
export function codeTool(
	cwd: string,
	query: (query: CodeQuery, signal?: AbortSignal) => Promise<unknown> = (
		query,
		signal,
	) => codeManager().query(cwd, query, signal),
): ToolDefinition {
	return {
		name: "code",
		label: "Code intelligence",
		description:
			"Read-only TypeScript/JavaScript, Python, Java, Go, Rust and C/C++ language intelligence. Query symbols, navigate definition/references/hover, read an enclosing symbol, or inspect diagnostics for opened files. Locations use one-based lines and UTF-16 columns. Supply line + symbol when unsure of column. All except TypeScript/JavaScript require project trust. Native language tools must be installed locally. Diagnostics are not a full-project check. Rust is partial native analysis without Cargo check, build scripts or proc macros; analysisLimitation entries are informational, not confirmed errors.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("symbols"),
				Type.Literal("navigate"),
				Type.Literal("read_symbol"),
				Type.Literal("diagnostics"),
			]),
			path: Type.Optional(Type.String()),
			query: Type.Optional(Type.String()),
			line: Type.Optional(Type.Integer({ minimum: 1 })),
			column: Type.Optional(Type.Integer({ minimum: 1 })),
			symbol: Type.Optional(Type.String()),
			operation: Type.Optional(
				Type.Union([
					Type.Literal("definition"),
					Type.Literal("references"),
					Type.Literal("hover"),
				]),
			),
			expectedVersion: Type.Optional(Type.String()),
		}),
		async execute(_id, args, signal) {
			const result = await query(args as CodeQuery, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: {},
			};
		},
	};
}
