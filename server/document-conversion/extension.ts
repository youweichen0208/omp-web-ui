import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { convertDocument } from "./service.js";
import { doctorRuntime, setupRuntime } from "./runtime.js";
import { doctorChmRuntime, setupChmRuntime } from "./chm-runtime.js";
import { getDocumentSettings, updateDocumentSettings } from "./settings.js";

const pathParameter = Type.String({ minLength: 1, maxLength: 4096 });
interface ActiveDocumentSetup { ownerSessionId: string; controller: AbortController; task?: Promise<void> }
let activeSetup: ActiveDocumentSetup | undefined;
export const pdfMarkdownParameters = Type.Object({
	inputPath: pathParameter,
	format: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("code")], { description: "Use code for extensionless source files; auto detects supported document and code extensions." })),
	outputDir: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Output directory inside the current workspace. Defaults to converted/<filename>-<path hash>. Existing edited files are never overwritten." })),
});
export const pdfMarkdownOutput = Type.Object({
	status: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
	bundlePath: Type.String(), markdownPath: Type.String(), structurePath: Type.String(), sourceMapPath: Type.String(), assetsDir: Type.String(),
	sourceHash: Type.String(), parserVersion: Type.String(), warnings: Type.Array(Type.String()),
});

/** Output files must remain accessible through the workspace's existing file UI. */
async function outputDirectory(cwd: string, input: string, requested?: string): Promise<string> {
	const root = await realpath(cwd);
	const hash = createHash("sha256").update(input).digest("hex").slice(0, 8);
	const destination = resolve(root, requested ?? `converted/${basename(input, extname(input))}-${hash}`);
	const within = (target: string) => { const rel = relative(root, target); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
	if (!within(destination) || destination === root) throw Error("Choose an output directory inside the current workspace.");
	let ancestor = destination;
	while (true) {
		try { await lstat(ancestor); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; continue;
		}
		// A dangling symlink exists according to lstat: its failed realpath must not
		// be mistaken for a missing directory and skipped to the parent.
		if (!within(await realpath(ancestor)) || !(await stat(ancestor)).isDirectory()) throw Error("Output directory leaves the workspace or is not a directory.");
		return destination;
	}
}

async function pdfSettings(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.isIdle()) { ctx.ui.notify("请等待当前任务结束后修改扩展设置。", "warning"); return; }
	const current = getDocumentSettings();
	let action = args.trim();
	if (!action && ctx.hasUI) action = await ctx.ui.select("文档转 Markdown 设置", ["启用", "停用", "Python 路径"]) ?? "";
	if (["on", "启用"].includes(action)) await updateDocumentSettings({ pdfEnabled: true });
	else if (["off", "停用"].includes(action)) await updateDocumentSettings({ pdfEnabled: false });
	else if (action === "Python 路径" || action.startsWith("python ")) {
		const path = action.startsWith("python ") ? action.slice(7).trim() : await ctx.ui.input("Python 可执行文件路径（留空恢复自动发现）", current.pythonPath ?? "");
		if (path === undefined) return;
		await updateDocumentSettings({ pythonPath: path.trim() || undefined });
	} else {
		ctx.ui.notify(`文档转 Markdown：${current.pdfEnabled ? "启用" : "停用"}；Python：${current.pythonPath ?? "自动发现"}。用 /documents settings on|off|python <路径> 修改。`, "info");
		return;
	}
	ctx.ui.notify("设置已保存。请使用 /reload 或新建会话更新工具列表；停用后现有工具调用会立即被拒绝。", "info");
}

export const createPdfMarkdownExtension = (): ExtensionFactory => pi => {
	for (const format of ["Document", "PDF", "CHM"] as const) {
		const name = format === "Document" ? "document_to_markdown" : format === "PDF" ? "pdf_to_markdown" : "chm_to_markdown";
		pi.registerTool({
			name, label: `${format} to Markdown`,
			description: format === "Document" ? "Convert local PDF, CHM, DOCX, XLSX, PPTX, text, Markdown or source-code files into faithful structured Markdown and a portable source evidence bundle. Preserve original files, locations, assets and quality warnings; perform no knowledge extraction or truth assessment. For source repositories select relevant files using native tools; code bundles retain Git commit, branch and line locations. Feed the resulting bundle directory to okf_ingest only when knowledge distillation is requested. Setup is explicit via /documents setup [chm]." : format === "PDF" ? "Convert a local PDF, including scans, to structured Markdown with local Docling OCR, tables, code, images and source locations. Uses the local parser without extra chat model calls. Returns file paths and quality warnings. Read the Markdown and warnings before reporting quality; do not invent missing content. Link the resulting workspace-relative Markdown file in your final answer." : "Convert a local CHM compiled HTML help file to Markdown with contents order, linked topic files, Chinese encodings, tables, exact preformatted code, archived images and topic source locations. Offline; no OCR or extra model calls. Run /documents setup chm only when setup is explicitly requested. Read quality warnings and link the returned Markdown; unresolved content remains partial.",
			exposure: getDocumentSettings().pdfEnabled ? "deferred" : "hidden", executionMode: "sequential",
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			parameters: pdfMarkdownParameters, outputSchema: pdfMarkdownOutput,
			async execute(_id, args, signal, onUpdate, ctx) {
				if (!getDocumentSettings().pdfEnabled) throw Error("PDF / CHM conversion is disabled. Enable it with /documents settings on.");
				signal?.throwIfAborted();
				const cwd = await realpath(ctx.cwd);
				const inputPath = await realpath(resolve(cwd, args.inputPath));
				if (format !== "Document" && extname(inputPath).toLowerCase() !== `.${format.toLowerCase()}`) throw Error(`${name} accepts ${format} files; use document_to_markdown for other document formats.`);
				const outputDir = await outputDirectory(cwd, inputPath, args.outputDir);
				const result = await convertDocument({ inputPath, outputDir, format: format === "Document" ? args.format : "auto", signal, onProgress: text => onUpdate?.({ content: [{ type: "text", text }], details: {} }) });
				const localPath = (path: string) => relative(cwd, path).split(sep).join("/");
				const data = { status: result.status, bundlePath: localPath(result.bundlePath), markdownPath: localPath(result.markdownPath), structurePath: localPath(result.structurePath), sourceMapPath: localPath(result.sourceMapPath), assetsDir: localPath(result.assetsDir), sourceHash: result.sourceHash, parserVersion: result.parserVersion, warnings: result.warnings };
				return { content: [{ type: "text", text: `${JSON.stringify(data, null, 2)}\nRead the generated Markdown and conversion warnings. In your final reply, link [converted document](${data.markdownPath}).` }], structuredContent: data, details: {} };
			},
		});
	}
	for (const command of ["documents", "pdf-md"]) pi.registerCommand(command, {
		description: "文档转 Markdown；convert、setup [chm]、cancel、doctor [chm]、settings",
		async handler(args, ctx) {
			const [, action = "", rest = ""] = /^(\S+)?\s*([\s\S]*)$/.exec(args.trim()) ?? [];
			if (action === "settings") { await pdfSettings(rest, ctx); return; }
			if (action === "cancel") {
				if (!activeSetup) { ctx.ui.notify("没有正在安装的文档解析环境。", "info"); return; }
				if (activeSetup.ownerSessionId !== ctx.sessionManager.getSessionId()) { ctx.ui.notify("解析环境正在其他会话中安装，请在发起安装的会话中运行 /documents cancel。", "warning"); return; }
				activeSetup.controller.abort();
				ctx.ui.notify("已请求取消解析环境安装，正在清理安装进程。", "info");
				return;
			}
			if (action === "doctor" || action === "setup") {
				if (rest && rest !== "chm") { ctx.ui.notify("用法：/documents setup [chm]；/documents doctor [chm]", "warning"); return; }
				if (!ctx.isIdle()) { ctx.ui.notify("请等待当前任务结束后检查或安装解析环境。", "warning"); return; }
				if (activeSetup) { ctx.ui.notify("文档解析环境已经在安装中。可在发起安装的会话运行 /documents cancel 取消。", "warning"); return; }
				const setup: ActiveDocumentSetup | undefined = action === "setup" ? { ownerSessionId: ctx.sessionManager.getSessionId(), controller: new AbortController() } : undefined;
				if (setup) activeSetup = setup;
				const run = async () => {
					try {
						const signal = setup ? (ctx.signal ? AbortSignal.any([setup.controller.signal, ctx.signal]) : setup.controller.signal) : ctx.signal;
						const installer = rest === "chm" ? setupChmRuntime : setupRuntime;
						const doctor = rest === "chm" ? doctorChmRuntime : doctorRuntime;
						const result = setup ? await installer({ signal, onProgress: text => ctx.ui.setStatus("document-runtime", text) }) : await doctor({ signal });
						ctx.ui.notify(JSON.stringify(result, null, 2), result.ready ? "info" : "warning");
					} catch (error) { ctx.ui.notify((error as Error).message, "error"); }
					finally { if (setup && activeSetup === setup) activeSetup = undefined; ctx.ui.setStatus("document-runtime", undefined); }
				};
				if (setup) {
					// Acknowledge this explicit command immediately so the same WebUI
					// input remains available for /documents cancel during installation.
					ctx.ui.notify("已开始安装文档解析环境。进度显示在状态栏；可用 /documents cancel 取消。", "info");
					setup.task = run();
				} else await run();
				return;
			}
			if (action !== "convert" || !rest) { ctx.ui.notify("用法：/documents convert <文档或代码路径及可选输出要求>；/documents setup [chm]；/documents cancel；/documents doctor [chm]；/documents settings", "info"); return; }
			if (!getDocumentSettings().pdfEnabled) { ctx.ui.notify("文档转换已停用，请先用 /documents settings on 启用。", "warning"); return; }
			pi.sendUserMessage(`Convert the document described below with the native document_to_markdown tool. Use tool_search to discover it if needed. Preserve the source document, inspect the conversion warnings, and give a clickable relative link to the resulting Markdown. Do not install dependencies unless I explicitly request setup.\n\n${rest}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});
};

/** Historical factory name retained for native extension filter compatibility. */
export const createDocumentMarkdownExtension = createPdfMarkdownExtension;
