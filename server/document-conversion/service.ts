import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, stat, mkdir, rm, rename, access, lstat, readdir, cp, copyFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, isAbsolute } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { documentDataDir } from "./settings.js";
import { decodeText } from "../text-sniff.js";
import { CONVERSION_PROFILE, ensureRuntimeReady, runConversionWorker, runtimeFingerprint, waitDocumentQueue } from "./runtime.js";
import { chmRuntimeFingerprint, doctorChmRuntime, runChmConversion } from "./chm-runtime.js";
import { CODE_LANGUAGES, sourceCodeMarkdown, sourceGitMetadata } from "./source-code.js";
import type { DocumentBundle, DocumentOrigin } from "../document-bundle.js";

export const DOCUMENT_EXTENSIONS = new Set([".pdf", ".chm", ".md", ".markdown", ".txt", ".docx", ".xlsx", ".pptx", ...Object.keys(CODE_LANGUAGES)]);
export type { DocumentLocator, DocumentBlock } from "../document-bundle.js";
import type { DocumentBlock } from "../document-bundle.js";
import { textBlocks, markdownDependencyFingerprint, preserveMarkdownImages } from "../markdown-document.js";
export { textBlocks } from "../markdown-document.js";
export interface DocumentConversionResult {
	markdownPath: string;
	structurePath: string;
	sourceMapPath: string;
	assetsDir: string;
	bundlePath: string;
	sourceHash: string;
	parserVersion: string;
	warnings: string[];
	status: "complete" | "partial";
	blocks: DocumentBlock[];
}
export type ConvertedDocument = DocumentConversionResult;
export interface ConvertDocumentOptions { inputPath: string; outputDir: string; sourceName?: string; format?: "auto" | "code"; signal?: AbortSignal; onProgress?: (message: string) => void; markdownAssets?: Record<string, string | null> }
interface Manifest { schemaVersion: 1; cacheKey: string; sourceHash: string; parserVersion: string; status: "complete" | "partial"; warnings: string[]; files: Record<string, string> }
const locks = new Map<string, Promise<void>>();

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
	const hash = createHash("sha256"), stream = createReadStream(path, { signal });
	for await (const chunk of stream) hash.update(chunk);
	return hash.digest("hex");
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }


export async function convertDocument(options: ConvertDocumentOptions): Promise<DocumentConversionResult> {
	const key = resolve(options.outputDir), prior = locks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const lock = new Promise<void>(done => { release = done; });
	const chain = prior.then(() => lock); locks.set(key, chain);
	try { await waitDocumentQueue(prior, options.signal); options.signal?.throwIfAborted(); return await convert({ ...options, outputDir: key }); }
	finally { release(); if (locks.get(key) === chain) locks.delete(key); }
}

async function artifactFiles(root: string, prefix = ""): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
		const path = join(prefix, entry.name);
		if (entry.isSymbolicLink()) throw new Error("Parser artifacts must not contain symlinks");
		if (entry.isDirectory()) paths.push(...await artifactFiles(root, path));
		else if (entry.isFile() && path !== "manifest.json") paths.push(path);
	}
	return paths;
}
async function loadResult(root: string, manifest: Manifest): Promise<DocumentConversionResult> {
	const sourceMap: { blocks: DocumentBlock[] } = JSON.parse(await readFile(join(root, "source-map.json"), "utf8"));
	return { markdownPath: join(root, "document.md"), bundlePath: join(root, "bundle.json"), structurePath: join(root, "structure.json"), sourceMapPath: join(root, "source-map.json"), assetsDir: join(root, "assets"), sourceHash: manifest.sourceHash, parserVersion: manifest.parserVersion, warnings: manifest.warnings, status: manifest.status, blocks: sourceMap.blocks };
}

async function existingManifest(root: string, signal?: AbortSignal): Promise<Manifest | undefined> {
	try { await access(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	if ((await lstat(root)).isSymbolicLink()) throw new Error("Output directory must not be a symlink");
	if ((await readdir(root)).length === 0) return undefined;
	let manifest: Manifest;
	try { manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")); }
	catch { throw new Error("Output directory contains existing files without a conversion manifest; choose another directory"); }
	if (manifest.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== "object") throw new Error("Invalid existing conversion manifest");
	const actual = await artifactFiles(root);
	if (actual.length !== Object.keys(manifest.files).length) throw new Error("Conversion output has added or removed files; choose another directory to preserve changes");
	for (const path of actual) {
		if (!manifest.files[path] || await hashFile(join(root, path), signal) !== manifest.files[path]) throw new Error(`Conversion output was edited: ${path}. Choose another directory to preserve changes.`);
	}
	for (const required of ["document.md", "structure.json", "source-map.json"]) if (!manifest.files[required]) throw new Error("Incomplete conversion manifest");
	return manifest;
}

async function destinationLock(root: string, signal?: AbortSignal): Promise<() => Promise<void>> {
	for (;;) {
		signal?.throwIfAborted();
		try { return await lockfile.lock(root, { realpath: false, lockfilePath: `${root}.conversion-lock`, stale: 120_000, retries: 0 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
			await new Promise(done => setTimeout(done, 100));
		}
	}
}

async function withArtifactMutationQueues<T>(root: string, paths: string[], operation: () => Promise<T>): Promise<T> {
	const ordered = [...new Set(paths)].sort();
	const acquire = (index: number): Promise<T> => index === ordered.length ? operation() : withFileMutationQueue(join(root, ordered[index]), () => acquire(index + 1));
	return acquire(0);
}

async function convert(options: ConvertDocumentOptions): Promise<DocumentConversionResult> {
	const { outputDir, signal, onProgress } = options, inputPath = resolve(options.inputPath), suffix = extname(inputPath).toLowerCase();
	if (!DOCUMENT_EXTENSIONS.has(suffix) && options.format !== "code") throw new Error(`Unsupported document format: ${suffix}; use format=code only for a known text source file`);
	if (inputPath === outputDir || inputPath.startsWith(outputDir + "/") || inputPath.startsWith(outputDir + "\\")) throw new Error("Output directory must not contain the source document");
	const info = await stat(inputPath);
	if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error("Document must be a file no larger than 100 MiB");
	const sourceHash = await hashFile(inputPath, signal), code = options.format === "code" || Object.hasOwn(CODE_LANGUAGES, suffix);
	const plain = code || [".md", ".markdown", ".txt"].includes(suffix);
	const git = await sourceGitMetadata(inputPath, signal);
	let parserVersion = code ? "source-code-v1" : "text-v1", fingerprint = parserVersion, markdownDependencies: string | undefined;
	if (!code && (suffix === ".md" || suffix === ".markdown")) {
		if (info.size > 16 * 1024 * 1024) throw new Error("Text documents are limited to 16 MiB");
		markdownDependencies = await markdownDependencyFingerprint(decodeText(await readFile(inputPath)), inputPath, options.markdownAssets);
		fingerprint += markdownDependencies;
	}
	if (!code && suffix === ".chm") {
		const doctor = await doctorChmRuntime({ signal, onProgress });
		if (!doctor.ready) throw new Error(`Local CHM runtime is not ready. Run /pdf-md setup chm. ${doctor.missing.join("; ")}`);
		parserVersion = doctor.parserVersion!; fingerprint = await chmRuntimeFingerprint(doctor);
	} else if (!plain) {
		const doctor = await ensureRuntimeReady({ signal, onProgress });
		if (!doctor.ready) throw new Error(`Local document runtime is not ready. Run /pdf-md setup. ${doctor.missing.join("; ")}`);
		parserVersion = `docling-${doctor.parserVersion}`; fingerprint = await runtimeFingerprint();
	}
	const archiveName = suffix === ".chm" ? basename(options.sourceName ?? inputPath) : undefined;
	const cacheKey = digest(JSON.stringify({ sourceHash, suffix, profile: CONVERSION_PROFILE, fingerprint, archiveName, code, git, bundleVersion: 1, codePath: code ? inputPath : undefined }));
	await mkdir(dirname(outputDir), { recursive: true });
	const unlock = await destinationLock(outputDir, signal);
	try {
	const existing = await existingManifest(outputDir, signal);
	if (existing?.cacheKey === cacheKey && existing.status === "complete") {
		const priorSource = JSON.parse(await readFile(join(outputDir, "source-map.json"), "utf8")).source;
		if (priorSource === inputPath) { onProgress?.("Using unchanged document conversion"); return await loadResult(outputDir, existing); }
	}
	const cacheDir = join(documentDataDir(), "document-cache", cacheKey);
	const staging = join(dirname(outputDir), `.${basename(outputDir)}-${randomUUID()}.partial`), backup = `${staging}.previous`;
	await mkdir(join(staging, "assets"), { recursive: true });
	let installed = false, backedUp = false;
	try {
		let warnings: string[] = [], status: "complete" | "partial" = "complete";
		let reused: Manifest | undefined;
		try { reused = await existingManifest(cacheDir, signal); } catch { signal?.throwIfAborted(); }
		if (reused?.cacheKey === cacheKey && reused.status === "complete") {
			await cp(cacheDir, staging, { recursive: true }); warnings = reused.warnings; status = reused.status;
			const sourceMap = JSON.parse(await readFile(join(staging, "source-map.json"), "utf8")); sourceMap.source = inputPath;
			await writeFile(join(staging, "source-map.json"), JSON.stringify(sourceMap, null, 2));
			const structure = JSON.parse(await readFile(join(staging, "structure.json"), "utf8"));
			if (structure.origin && typeof structure.origin === "object") structure.origin.filename = archiveName ?? basename(inputPath);
			await writeFile(join(staging, "structure.json"), JSON.stringify(structure, null, 2));
			onProgress?.("Reusing the local document content cache");
		} else if (plain) {
			if (info.size > 16 * 1024 * 1024) throw new Error("Text documents are limited to 16 MiB");
			const data = await readFile(inputPath);
			try { new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { warnings.push("Source is not UTF-8; decoded using the legacy text encoding fallback. Verify non-ASCII text."); }
			const text = decodeText(data).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
			if (code && text.includes("\0")) throw new Error("Source code input contains binary NUL bytes");
			const sourceCode = code ? sourceCodeMarkdown(text, inputPath, git) : undefined;
			const blocks = sourceCode?.blocks ?? textBlocks(text);
			const markdown = sourceCode?.markdown ?? (suffix === ".txt" ? text : await preserveMarkdownImages(text, inputPath, staging, warnings, options.markdownAssets));
			if (warnings.some(warning => warning.startsWith("Markdown image was not copied"))) status = "partial";
			await writeFile(join(staging, "document.md"), markdown.endsWith("\n") ? markdown : markdown + "\n");
			await writeFile(join(staging, "structure.json"), JSON.stringify({ schemaVersion: 1, kind: "text", blocks }, null, 2));
			await writeFile(join(staging, "source-map.json"), JSON.stringify({ schemaVersion: 1, source: inputPath, sourceHash, blocks }, null, 2));
		} else {
			onProgress?.(`Converting ${basename(inputPath)} locally`);
			const response = suffix === ".chm"
				? await runChmConversion({ inputPath, outputDir: staging, sourceHash, archiveName }, { signal, onProgress })
				: await runConversionWorker({ inputPath, outputDir: staging, sourceHash }, { signal, onProgress });
			if (response.status !== "complete" && response.status !== "partial") throw new Error("Invalid parser completion status");
			status = response.status; warnings = response.warnings ?? [];
		}
		if (await hashFile(inputPath, signal) !== sourceHash) throw new Error("Source changed during conversion; retry with the current document");
		if (markdownDependencies !== undefined && await markdownDependencyFingerprint(decodeText(await readFile(inputPath)), inputPath, options.markdownAssets) !== markdownDependencies) throw new Error("Markdown images changed during conversion; retry with the current document");
		for (const path of ["document.md", "structure.json", "source-map.json"]) await access(join(staging, path));
		if (git?.dirty) warnings = [...new Set([...warnings, "Source differs from its Git commit; provenance identifies the working-tree snapshot, not committed production code."])];
		await mkdir(join(staging, "original"), { recursive: true });
		const original = `original/source${suffix.replace(/[^a-z0-9.]/g, "")}`;
		await copyFile(inputPath, join(staging, original));
		if (await hashFile(join(staging, original), signal) !== sourceHash || await hashFile(inputPath, signal) !== sourceHash) throw new Error("Source changed while creating its portable evidence snapshot");
		const source: DocumentOrigin = { id: digest(inputPath), name: options.sourceName ?? basename(inputPath), format: code ? "source_code" : suffix.slice(1), inputPath, original, contentHash: sourceHash, ...(git ? { git } : {}) };
		const bundleFiles: Record<string, string> = {};
		for (const path of await artifactFiles(staging)) if (path !== "bundle.json") bundleFiles[path.split(/[/\\]/).join("/")] = await hashFile(join(staging, path), signal);
		const bundle: DocumentBundle = { kind: "pi-harness-normalized-document", version: 1, source, markdown: "document.md", sourceMap: "source-map.json", structure: "structure.json", parserVersion, status, warnings, files: bundleFiles };
		await writeFile(join(staging, "bundle.json"), JSON.stringify(bundle, null, 2));
		const files: Record<string, string> = {};
		for (const path of await artifactFiles(staging)) files[path] = await hashFile(join(staging, path), signal);
		const manifest: Manifest = { schemaVersion: 1, cacheKey, sourceHash, parserVersion, status, warnings, files };
		await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
		signal?.throwIfAborted();
		onProgress?.("Committing verified document artifacts");
		await withArtifactMutationQueues(outputDir, ["manifest.json", ...Object.keys(existing?.files ?? {}), ...Object.keys(files)], async () => {
			// Revalidate after the slow parser run, catching edits made during OCR.
			await existingManifest(outputDir, signal);
			try { await access(outputDir); await rename(outputDir, backup); backedUp = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			await rename(staging, outputDir); installed = true;
		});
		if (status === "complete") {
			await mkdir(dirname(cacheDir), { recursive: true });
			const temporaryCache = `${cacheDir}.${randomUUID()}.partial`;
			try { await cp(outputDir, temporaryCache, { recursive: true }); await rename(temporaryCache, cacheDir); }
			catch { /* Cache races or cache I/O failures never invalidate the output. */ }
			finally { await rm(temporaryCache, { recursive: true, force: true }); }
		}
		return await loadResult(outputDir, manifest);
	} finally {
		if (!installed && backedUp) await rename(backup, outputDir);
		await rm(staging, { recursive: true, force: true });
		if (installed) await rm(backup, { recursive: true, force: true });
	}
	} finally { await unlock(); }
}
