import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

const execFileAsync = promisify(execFile);
const TEXT_LIMIT = 2 * 1024 * 1024;
const PDF_LIMIT = 20 * 1024 * 1024;
const SOURCE_KINDS = new Set(["code", "personal", "reference"]);

function validateFilePath(value) {
	if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split("/").some(part => !part || part === "." || part === "..")) {
		throw new Error(`Evidence path must be a normalized relative file path: ${JSON.stringify(value)}`);
	}
	return value;
}

function isWithin(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolveFile(root, file) {
	validateFilePath(file);
	let resolved;
	try {
		resolved = await realpath(path.resolve(root, file));
	} catch (error) {
		throw new Error(`Evidence file missing or inaccessible: ${file}`, { cause: error });
	}
	if (!isWithin(root, resolved)) throw new Error(`Evidence file escapes source root: ${file}`);
	return resolved;
}

async function readBounded(file, limit) {
	// POSIX FIFOs must not wait for a writer before fstat can reject them.
	// Windows does not expose O_NONBLOCK; its ordinary file opens remain read-only.
	const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`Evidence must be a regular file: ${file}`);
		if (info.size > limit) throw new Error(`Evidence exceeds ${limit} byte limit: ${file}`);
		const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) return buffer.subarray(0, length);
			length += bytesRead;
		}
		// Refuse growth during the read instead of silently indexing a truncated file.
		throw new Error(`Evidence changed size while reading; retry snapshot: ${file}`);
	} finally {
		await handle.close();
	}
}

function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function textLines(bytes, file) {
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new Error(`Evidence text must be UTF-8: ${file}`, { cause: error });
	}
	if (text.includes("\0")) throw new Error(`Binary evidence is unsupported: ${file}`);
	if (!text) return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function isPdf(file, bytes) {
	return /\.pdf$/i.test(file) || bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

async function readPdf(bytes, file, page) {
	// A separate worker gives even a synchronously stuck parser a real deadline.
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./pdf-worker.mjs", import.meta.url), {
			workerData: { bytes: new Uint8Array(bytes), page },
			resourceLimits: { maxOldGenerationSizeMb: 128 },
		});
		let finished = false;
		const finish = (error, result) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			void worker.terminate();
			if (error) reject(new Error(`Cannot read local PDF ${file}: ${error.message}`, { cause: error }));
			else resolve(result);
		};
		const timer = setTimeout(() => finish(new Error("PDF extraction timed out after 8 seconds")), 8000);
		worker.once("message", result => finish(result.error ? new Error(result.error) : undefined, result));
		worker.once("error", error => finish(error));
		worker.once("exit", () => finish(new Error("PDF reader stopped")));
	});
}

async function git(root, args) {
	return execFileAsync("git", ["-C", root, "--literal-pathspecs", ...args], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		timeout: 10_000,
		env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
	});
}

async function gitRepository(root) {
	let repository;
	try {
		repository = (await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
	} catch (error) {
		if (error.code === 128 && error.stderr?.includes("not a git repository")) return undefined;
		throw new Error(`Cannot inspect Git source ${root}: ${error.message}`, { cause: error });
	}
	let commit;
	try {
		commit = (await git(repository, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
	} catch (error) {
		if (error.code === 128 && error.stderr?.includes("Needed a single revision")) return undefined;
		throw new Error(`Cannot read Git HEAD for ${root}: ${error.message}`, { cause: error });
	}
	return { root: repository, commit };
}

async function gitProvenance(repository, file) {
	if (!repository) return undefined;
	const relative = path.relative(repository.root, file).split(path.sep).join("/");
	try {
		await git(repository.root, ["ls-files", "--error-unmatch", "--", relative]);
	} catch (error) {
		if (error.code === 1) return undefined;
		throw new Error(`Cannot inspect Git tracking for ${file}: ${error.message}`, { cause: error });
	}
	const status = await git(repository.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", relative]);
	return { commit: repository.commit, dirty: status.stdout.length > 0 };
}

/** Snapshot explicit local files only. The returned JSON contains provenance, never source text. */
export async function snapshotSources(sources, baseDir = process.cwd()) {
	if (!Array.isArray(sources) || !sources.length) throw new Error("At least one evidence source is required");
	const ids = new Set();
	const normalized = [];
	for (const source of sources) {
		if (!source || typeof source !== "object" || typeof source.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(source.id)) throw new Error("Source id must contain 1–64 letters, digits, dots, underscores or hyphens");
		if (ids.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
		ids.add(source.id);
		if (!SOURCE_KINDS.has(source.kind)) throw new Error(`Unsupported source kind: ${source.kind}`);
		if (typeof source.root !== "string" || !source.root || source.root.includes("\0")) throw new Error(`Source root is required: ${source.id}`);
		if (!Array.isArray(source.files) || !source.files.length) throw new Error(`Source files must be an explicit nonempty allowlist: ${source.id}`);
		const files = source.files.map(validateFilePath);
		if (new Set(files).size !== files.length) throw new Error(`Duplicate file in source: ${source.id}`);
		if (source.vikingUri !== undefined && (typeof source.vikingUri !== "string" || !source.vikingUri.startsWith("viking://"))) throw new Error(`Invalid vikingUri: ${source.id}`);
		let root;
		try {
			root = await realpath(path.resolve(baseDir, source.root));
			if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
		} catch (error) {
			throw new Error(`Source root missing or not a directory: ${source.id}`, { cause: error });
		}
		normalized.push({ id: source.id, kind: source.kind, root, files, ...(source.vikingUri === undefined ? {} : { vikingUri: source.vikingUri }) });
	}
	const documents = [];
	for (const source of normalized) {
		const repository = source.kind === "code" ? await gitRepository(source.root) : undefined;
		for (const file of source.files) {
			const resolved = await resolveFile(source.root, file);
			const bytes = await readBounded(resolved, /\.pdf$/i.test(file) ? PDF_LIMIT : TEXT_LIMIT);
			const document = { sourceId: source.id, path: file, kind: source.kind, sha256: digest(bytes), bytes: bytes.length };
			if (isPdf(file, bytes)) document.pageCount = (await readPdf(bytes, file)).pageCount;
			else document.lineCount = textLines(bytes, file).length;
			const provenance = await gitProvenance(repository, resolved);
			if (provenance) document.git = provenance;
			documents.push(document);
		}
	}
	return { sources: normalized, documents };
}

/** Revalidate containment and original bytes before materializing a recorded document. */
export async function readSnapshotBytes(corpus, request) {
	if (!corpus || !Array.isArray(corpus.sources) || !Array.isArray(corpus.documents)) throw new Error("Invalid evidence corpus");
	if (!request || typeof request !== "object") throw new Error("Evidence request is required");
	validateFilePath(request.path);
	const source = corpus.sources.find(item => item.id === request.sourceId);
	const document = corpus.documents.find(item => item.sourceId === request.sourceId && item.path === request.path);
	if (!source || !document || !source.files.includes(request.path)) throw new Error(`Unknown evidence document: ${request.sourceId}/${request.path}`);
	const root = await realpath(source.root).catch(error => { throw new Error(`Evidence source missing: ${source.id}`, { cause: error }); });
	if (root !== source.root) throw new Error(`Evidence source moved; refresh snapshot: ${source.id}`);
	const resolved = await resolveFile(root, request.path);
	const bytes = await readBounded(resolved, document.pageCount === undefined ? TEXT_LIMIT : PDF_LIMIT);
	if (digest(bytes) !== document.sha256) throw new Error(`Stale evidence; refresh snapshot before citing: ${source.id}/${request.path}`);
	return { document, bytes };
}

/** Read original evidence only after its current bytes still match the recorded snapshot. */
export async function readEvidence(corpus, request) {
	const { document, bytes } = await readSnapshotBytes(corpus, request);
	if (document.pageCount !== undefined) {
		if (request.lineStart !== undefined || request.lineEnd !== undefined) throw new Error("PDF evidence uses page numbers, not text line numbers");
		if (!Number.isInteger(request.page) || request.page < 1 || request.page > document.pageCount) throw new Error(`PDF page must be between 1 and ${document.pageCount}`);
		const { text } = await readPdf(bytes, request.path, request.page);
		return { document, text, location: { page: request.page } };
	}
	if (request.page !== undefined) throw new Error("Text evidence uses line numbers, not PDF page numbers");
	const lines = textLines(bytes, request.path);
	if (!lines.length && request.lineStart === undefined && request.lineEnd === undefined) return { document, text: "", location: {} };
	const lineStart = request.lineStart ?? 1;
	const lineEnd = request.lineEnd ?? lines.length;
	if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart || lineEnd > lines.length) throw new Error(`Text line range must be within 1–${lines.length}`);
	return { document, text: lines.slice(lineStart - 1, lineEnd).join("\n"), location: { lineStart, lineEnd } };
}
