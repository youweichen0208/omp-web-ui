import { codemodeDetails } from "./codemode-presentation.js";
import { createHash } from "node:crypto";
/**
 * Serializes pi SDK AgentMessage[] into the browser-friendly UiMessage[] shape
 * defined in protocol.ts. Keeps payloads bounded (tool outputs and text blocks
 * are truncated with a marker) so snapshots stay cheap to stream.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { UiContentBlock, UiMessage } from "./protocol.js";
import { snapshotFromDetails } from "./plan/state.js";

/** AgentMessage is not re-exported from the package root; derive it from AgentSession. */
export type AgentMessage = AgentSession["messages"][number];

const TEXT_CAP = 200_000;
const TOOL_OUTPUT_CAP = 100_000;
const ARGS_CAP = 20_000;

function truncate(
	s: string,
	cap: number,
): { text: string; truncated: boolean } {
	if (s.length <= cap) return { text: s, truncated: false };
	return { text: `${s.slice(0, cap)}\n\n… [truncated]`, truncated: true };
}

/** Only documented native result fields cross the wire. */
export function toolExitCode(result: unknown, isError = false): number | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as { structuredContent?: { exit_code?: unknown }; details?: { exitCode?: unknown }; content?: { type: string; text?: string }[] };
	for (const value of [r.structuredContent?.exit_code, r.details?.exitCode]) {
		if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	}
	if (!isError) return undefined;
	const text = Array.isArray(r.content) ? r.content.filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text).join("\n") : "";
	const match = text.match(/exited with code (-?\d+)/);
	return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : undefined;
}

export function nativeToolDetails(name: string, result: unknown): Record<string, unknown> | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as { details?: Record<string, unknown>; structuredContent?: Record<string, unknown>; isError?: boolean };
	const d = r.details;
	const out: Record<string, unknown> = {};
	if (name === "edit") {
		if (typeof d?.diff === "string") { const bounded = truncate(d.diff, TOOL_OUTPUT_CAP); out.diff = bounded.text; out.diffTruncated = bounded.truncated; }
		if (typeof d?.firstChangedLine === "number" && Number.isSafeInteger(d.firstChangedLine) && d.firstChangedLine > 0) out.firstChangedLine = d.firstChangedLine;
	}
	const path = d?.fullOutputPath ?? (["bash", "powershell"].includes(name) ? r.structuredContent?.full_output_path : undefined);
	if (typeof path === "string" && path.length <= 4096) out.fullOutputPath = path;
	if (name === "bash") {
		out.exitCode = toolExitCode(result, r.isError);
		if (d?.truncation && typeof d.truncation === "object") {
			const source = d.truncation as Record<string, unknown>;
			const truncation: Record<string, unknown> = {};
			for (const key of ["truncated", "lastLinePartial"]) if (typeof source[key] === "boolean") truncation[key] = source[key];
			for (const key of ["totalLines", "totalBytes", "outputLines", "outputBytes"]) if (typeof source[key] === "number" && Number.isSafeInteger(source[key]) && source[key] >= 0) truncation[key] = source[key];
			if (source.truncatedBy === "lines" || source.truncatedBy === "bytes") truncation.truncatedBy = source.truncatedBy;
			out.truncation = truncation;
		}
	}
	return Object.keys(out).length ? out : undefined;
}

function serializeUserContent(
	content: Extract<AgentMessage, { content: unknown }>["content"],
): UiContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map((b) => {
		if (b.type === "image") {
			const img = b as unknown as {
				data?: string;
				mimeType?: string;
				source?: {
					type?: string;
					data?: string;
					mediaType?: string;
					url?: string;
				};
			};
			// Canonical ImageContent shape is { type, data, mimeType }; tolerate the
			// legacy { source } wrapper too.
			if (typeof img.data === "string" && img.data.length > 0) {
				return {
					type: "image",
					dataUrl: `data:${img.mimeType ?? "image/png"};base64,${img.data}`,
					mimeType: img.mimeType,
				};
			}
			const src = img.source;
			if (src?.type === "base64" && src.data) {
				return {
					type: "image",
					dataUrl: `data:${src.mediaType ?? "image/png"};base64,${src.data}`,
					mimeType: src.mediaType,
				};
			}
			return { type: "image", dataUrl: src?.url };
		}
		return { type: "text", text: String((b as { text?: unknown }).text ?? "") };
	});
}

function serializeAssistantContent(
	content: Extract<AgentMessage, { role: "assistant" }>["content"],
): UiContentBlock[] {
	return content.map((b) => {
		if (b.type === "text") {
			const { text, truncated } = truncate(b.text, TEXT_CAP);
			return { type: "text", text, truncated };
		}
		if (b.type === "thinking") {
			return { type: "thinking", thinking: b.thinking };
		}
		if (b.type === "toolCall") {
			if (b.arguments === undefined) {
				return { type: "toolCall", id: b.id, name: b.name };
			}
			const { text, truncated } = truncate(
				JSON.stringify(b.arguments),
				ARGS_CAP,
			);
			return {
				type: "toolCall",
				id: b.id,
				name: b.name,
				argumentsText: text,
				argumentsTruncated: truncated,
			};
		}
		return { type: "unknown", ...(b as unknown as Record<string, unknown>) };
	});
}

export function serializeMessage(
	m: AgentMessage,
	seq: number,
): UiMessage | null {
	switch (m.role) {
		case "user":
			return {
				id: `u-${m.timestamp}-${seq}`,
				role: "user",
				content: serializeUserContent(m.content),
				timestamp: m.timestamp,
			};

		case "assistant":
			return {
				id: `a-${m.timestamp}-${seq}`,
				role: "assistant",
				content: serializeAssistantContent(m.content),
				timestamp: m.timestamp,
				model: m.model,
				provider: m.provider,
				stopReason: m.stopReason,
				usage: m.usage ? { input: m.usage.input, output: m.usage.output, cacheRead: m.usage.cacheRead, cacheWrite: m.usage.cacheWrite } : undefined,
				errorMessage: m.errorMessage,
			};

		case "toolResult": {
			const raw = m.content
				.map((c) => (c.type === "text" ? c.text : ""))
				.join("\n");
			const { text, truncated } = truncate(raw, TOOL_OUTPUT_CAP);
			const plan = m.toolName === "plan" && !m.isError ? snapshotFromDetails(m.details) : undefined;
			let nestedComplete = m.nestedCalls?.complete === true && m.nestedCalls.calls.length <= 256;
			const nestedCalls = m.nestedCalls?.calls.slice(0, 256).map(call => {
				const args = call.arguments ? truncate(JSON.stringify(call.arguments), ARGS_CAP) : undefined;
				if (args?.truncated) nestedComplete = false;
				return { id: call.id, name: call.name, status: call.status, durationMs: call.durationMs,
					error: call.error?.slice(0, 500), argumentsBytes: call.argumentsBytes,
					argumentsText: args?.text };
			});
			return {
				id: `t-${m.toolCallId}`,
				role: "toolResult",
				content: [{ type: "text", text, truncated }, ...serializeUserContent(m.content.filter(block => block.type === "image"))],
				...(nestedCalls ? { nestedCalls: { complete: nestedComplete, calls: nestedCalls } } : {}),
				toolCallId: m.toolCallId,
				toolName: m.toolName,
				details: nativeToolDetails(m.toolName, m),
				...(m.toolName === "codemode" ? { codemode: codemodeDetails(m.details) } : {}),
				isError: m.isError,
				...(plan ? { planSnapshot: plan } : {}),
				timestamp: m.timestamp,
			};
		}

		case "bashExecution": {
			const { text, truncated } = truncate(m.output, TOOL_OUTPUT_CAP);
			return {
				id: `b-${m.timestamp}-${seq}`,
				role: "bashExecution",
				content: [
					{
						type: "bash",
						command: m.command,
						output: text,
						exitCode: m.exitCode,
						cancelled: m.cancelled,
						truncated,
					},
				],
				timestamp: m.timestamp,
			};
		}

		case "custom": {
			// Third-party extension messages with display:false are UI-hidden
			// (they still go into LLM context — the SDK handles that).
			if ((m as { display?: boolean }).display === false) {
				return null;
			}
			const content = serializeUserContent(m.content);
			return {
				id: `c-${m.timestamp}-${seq}`,
				role: "custom",
				content,
				customType: m.customType,
				details: (m as { details?: unknown }).details,
				timestamp: m.timestamp,
			};
		}

		case "branchSummary": {
			const { text, truncated } = truncate(m.summary, TEXT_CAP);
			return {
				id: `bs-${m.timestamp}-${seq}`,
				role: "branchSummary",
				content: [{ type: "text", text, truncated }],
				timestamp: m.timestamp,
			};
		}

		case "compactionSummary": {
			const { text, truncated } = truncate(m.summary, TEXT_CAP);
			return {
				id: `cs-${m.timestamp}-${seq}`,
				role: "compactionSummary",
				content: [{ type: "text", text, truncated }],
				timestamp: m.timestamp,
			};
		}

		default:
			return {
				id: `x-${seq}`,
				role: String((m as { role?: unknown }).role ?? "unknown"),
				content: [],
				timestamp: (m as { timestamp?: number }).timestamp,
			};
	}
}

/**
 * Serialize the in-progress assistant message (agent.state.streamingMessage).
 *
 * Unlike persisted messages, the id must be STABLE across snapshots: the SDK
 * replaces the partial object on every stream event, so a seq-based id would
 * remount the React component (and collapse open thinking/tool blocks) every
 * 60ms. The timestamp is fixed at message creation, so `stream-<ts>` stays
 * constant for the whole stream.
 */
export function serializeStreamingMessage(m: AgentMessage): UiMessage | null {
	const msg = serializeMessage(m, 0);
	if (!msg) return null;
	return { ...msg, id: `stream-${m.timestamp ?? 0}` };
}

/** Stable discriminator for messages sharing a role and millisecond timestamp. */
const fingerprints = new WeakMap<AgentMessage, string>();
export function contentFingerprint(message: AgentMessage): string {
	const cached = fingerprints.get(message);
	if (cached) return cached;
	// Persisted messages are immutable. Hash all blocks once, including image
	// bytes, thinking, tool arguments and custom metadata; a prefix/length is
	// not an identity. Streaming messages never use this cache.
	const fingerprint = createHash("sha256").update(JSON.stringify(message)).digest("hex");
	fingerprints.set(message, fingerprint);
	return fingerprint;
}
