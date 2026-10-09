import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createPdfMarkdownExtension } from "../../server/document-conversion/extension.js";
import { doctorRuntime, setupRuntime } from "../../server/document-conversion/runtime.js";
import { doctorChmRuntime, setupChmRuntime } from "../../server/document-conversion/chm-runtime.js";

vi.mock("../../server/document-conversion/runtime.js", () => ({ setupRuntime: vi.fn(), doctorRuntime: vi.fn() }));
vi.mock("../../server/document-conversion/chm-runtime.js", () => ({ setupChmRuntime: vi.fn(), doctorChmRuntime: vi.fn() }));
vi.mock("../../server/document-conversion/service.js", () => ({ convertDocument: vi.fn() }));
vi.mock("../../server/document-conversion/settings.js", () => ({ getDocumentSettings: () => ({ pdfEnabled: true, okfEnabled: true }), updateDocumentSettings: vi.fn() }));

async function command() {
	let registered: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	await createPdfMarkdownExtension()({ registerTool: vi.fn(), registerCommand: (_name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => { registered = options; } } as unknown as ExtensionAPI);
	return registered!;
}
function context(id: string) {
	const notify = vi.fn(), setStatus = vi.fn();
	return { notify, setStatus, ctx: { isIdle: () => true, sessionManager: { getSessionId: () => id }, ui: { notify, setStatus } } as unknown as ExtensionCommandContext };
}

describe("document setup commands", () => {
	it("routes explicit CHM setup and doctor to the lightweight runtime", async () => {
		const handler = (await command()).handler, owner = context("chm-owner");
		vi.mocked(setupChmRuntime).mockResolvedValueOnce({ ready: true, missing: [], warnings: [] });
		await handler("setup chm", owner.ctx);
		await vi.waitFor(() => expect(owner.setStatus).toHaveBeenLastCalledWith("document-runtime", undefined));
		expect(setupChmRuntime).toHaveBeenCalledTimes(1);
		vi.mocked(doctorChmRuntime).mockResolvedValueOnce({ ready: true, missing: [], warnings: [] });
		await handler("doctor chm", owner.ctx);
		expect(doctorChmRuntime).toHaveBeenCalledTimes(1);
		expect(setupRuntime).not.toHaveBeenCalled();
		expect(doctorRuntime).not.toHaveBeenCalled();
	});
	it("cancels only the initiating session's setup and releases ownership for retry", async () => {
		const handler = (await command()).handler;
		const owner = context("setup-owner"), other = context("other-session");
		let setupSignal: AbortSignal | undefined;
		vi.mocked(setupRuntime).mockImplementationOnce(async options => {
			setupSignal = options?.signal;
			options?.onProgress?.("Installing fixture runtime");
			return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new DOMException("Document operation canceled", "AbortError")), { once: true }));
		});
		await handler("setup", owner.ctx);
		expect(setupSignal).toBeDefined();
		expect(setupSignal?.aborted).toBe(false);
		await handler("cancel", other.ctx);
		expect(setupSignal?.aborted).toBe(false);
		expect(other.notify).toHaveBeenLastCalledWith(expect.stringContaining("其他会话"), "warning");
		await handler("setup", other.ctx);
		expect(setupRuntime).toHaveBeenCalledTimes(1);
		await handler("doctor", owner.ctx);
		expect(doctorRuntime).not.toHaveBeenCalled();
		// Reload creates a new extension instance but preserves the native session ID.
		await (await command()).handler("cancel", owner.ctx);
		expect(setupSignal?.aborted).toBe(true);
		await vi.waitFor(() => expect(owner.setStatus).toHaveBeenLastCalledWith("document-runtime", undefined));
		vi.mocked(setupRuntime).mockResolvedValueOnce({ ready: true, missing: [], warnings: [] });
		await handler("setup", other.ctx);
		expect(setupRuntime).toHaveBeenCalledTimes(2);
		await vi.waitFor(() => expect(other.setStatus).toHaveBeenLastCalledWith("document-runtime", undefined));
		await handler("cancel", owner.ctx);
		expect(owner.notify).toHaveBeenLastCalledWith(expect.stringContaining("没有正在安装"), "info");
	});
});
