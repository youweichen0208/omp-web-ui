import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool, createBashTool } from "@earendil-works/pi-coding-agent";
import { serializeMessage, nativeToolDetails, toolExitCode } from "../../server/serialize.js";
import { editWriteChange } from "../../web/src/edit-write-presentation.js";
import { openToolOutput } from "../../server/tool-output.js";
import { recoveryEvent, isRecovering } from "../../server/recovery-state.js";

it("preserves real SDK edit diff and line 42 without arbitrary metadata", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-result-"));
	try {
		writeFileSync(join(root, "file.txt"), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
		const result = await createEditTool(root).execute("edit-42", { path: "file.txt", edits: [{ oldText: "line 42", newText: "changed 42" }] });
		const message = serializeMessage({ role: "toolResult", toolCallId: "edit-42", toolName: "edit", timestamp: 1, isError: false, ...result, details: { ...result.details, secret: "never leak" } }, 1)!;
		expect(message.details).toMatchObject({ firstChangedLine: 42, diff: expect.stringContaining("changed 42") });
		expect(JSON.stringify(message)).not.toContain("never leak");
		const change = editWriteChange({ type: "toolCall", id: "edit-42", name: "edit", argumentsText: '{"path":"file.txt"}' }, message)!;
		expect(change.firstChangedLine).toBe(42); expect(change.fromArguments).toBe(false);
		expect(nativeToolDetails("edit", { details: { diff: "x".repeat(100001), firstChangedLine: "42" } })).toMatchObject({ diffTruncated: true });
	} finally { rmSync(root, { recursive: true, force: true }); }
});
it("uses structured success zero and failure codes before legacy fallbacks", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-bash-result-"));
	try {
		const tool = createBashTool(root);
		for (const code of [0, 7]) {
			const result = await tool.execute(`bash-${code}`, { command: `echo output; exit ${code}` });
			expect(toolExitCode(result, code !== 0)).toBe(code);
			expect(nativeToolDetails("bash", result)?.exitCode).toBe(code);
		}
		expect(toolExitCode({ structuredContent: { exit_code: 0 }, details: { exitCode: 4 } }, true)).toBe(0);
		expect(toolExitCode({ details: { exitCode: 3 } })).toBe(3);
		expect(toolExitCode({ content: [{ type: "text", text: "Command exited with code 9" }] }, true)).toBe(9);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
it("opens transcript-referenced output but rejects symlink escapes, directories and cleaned files", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-download-"));
	try {
		const work = join(root, "work"); mkdirSync(work);
		writeFileSync(join(work, "output"), "full output"); writeFileSync(join(root, "secret"), "secret");
		const file = await openToolOutput(work, "output"); expect(await file.readFile("utf8")).toBe("full output"); await file.close();
		symlinkSync(join(root, "secret"), join(work, "escape"));
		for (const path of ["escape", "../secret", "missing", "."]) await expect(openToolOutput(work, path)).rejects.toThrow();
	} finally { rmSync(root, { recursive: true, force: true }); }
});
it("keeps compaction alive when summary retry finishes and tracks native backoff", () => {
	let state = recoveryEvent({}, { type: "compaction_start", reason: "overflow" });
	const id = state.compaction!.id;
	state = recoveryEvent(state, { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 200000, errorMessage: "529" }, 100);
	expect(state.summary).toMatchObject({ source: "compaction", deadline: 200100 });
	state = recoveryEvent(state, { type: "summarization_retry_attempt_start", source: "compaction", reason: "overflow" });
	state = recoveryEvent(state, { type: "summarization_retry_finished" });
	expect(state.compaction?.id).toBe(id); expect(isRecovering(state)).toBe(true);
	state = recoveryEvent(state, { type: "compaction_end", reason: "overflow", result: undefined, aborted: true, willRetry: false });
	expect(isRecovering(state)).toBe(false);
	state = recoveryEvent(state, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 5000, errorMessage: "529" }, 100);
	expect(state.retry?.deadline).toBe(5100);
	expect(recoveryEvent(state, { type: "agent_settled" })).toEqual({ lastCompaction: state.lastCompaction });
});

it("retains compaction outcome with explicit before and estimated after counts", () => {
	let state = recoveryEvent({}, { type: "compaction_start", reason: "manual" }, 0, 8000);
	expect(state.compaction?.tokensBefore).toBe(8000);
	state = recoveryEvent(state, { type: "compaction_end", reason: "manual", result: { summary: "short", firstKeptEntryId: "a", tokensBefore: 8500 }, aborted: false, willRetry: false }, 0, 400);
	expect(state.lastCompaction).toMatchObject({ status: "completed", tokensBefore: 8500, tokensAfter: 400 });
	expect(isRecovering(state)).toBe(false);
	expect(recoveryEvent(state, { type: "agent_settled" }).lastCompaction).toEqual(state.lastCompaction);
});
