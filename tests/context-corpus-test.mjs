import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { readEvidence, snapshotSources } from "../dev/context-eval/corpus.mjs";

const execFileAsync = promisify(execFile);

async function temporary(t) {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-context-corpus-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

function source(root, files, extras = {}) {
	return { id: "notes", kind: "personal", root, files, ...extras };
}

async function runGit(root, ...args) {
	return execFileAsync("git", ["-C", root, "-c", "user.name=Context Test", "-c", "user.email=context-test@example.invalid", "-c", `core.hooksPath=${path.join(root, "no-hooks")}`, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, "no-git-config"), GIT_CONFIG_NOSYSTEM: "1" },
	});
}

function onePagePdf() {
	const stream = "BT /F1 12 Tf 36 100 Td (Local engineering evidence) Tj ET\n";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
	];
	let output = "%PDF-1.4\n";
	const offsets = [0];
	for (let i = 0; i < objects.length; i++) {
		offsets.push(Buffer.byteLength(output));
		output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(output);
	output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	output += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
	output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(output);
}

test("snapshots only allowlisted files and keeps same-name sources separate", async t => {
	const directory = await temporary(t);
	await mkdir(path.join(directory, "one"));
	await mkdir(path.join(directory, "two"));
	await writeFile(path.join(directory, "one", "README.md"), "First repository\n");
	await writeFile(path.join(directory, "one", "private.md"), "Do not index this file");
	await writeFile(path.join(directory, "two", "README.md"), "Second repository\n");
	const corpus = await snapshotSources([
		source("one", ["README.md"], { id: "one", vikingUri: "viking://resources/one" }),
		source("two", ["README.md"], { id: "two", kind: "reference" }),
	], directory);
	assert.equal(corpus.documents.length, 2);
	assert.equal(corpus.sources[0].root, await realpath(path.join(directory, "one")));
	assert.equal(corpus.sources[0].vikingUri, "viking://resources/one");
	assert.equal(corpus.documents[0].sha256, createHash("sha256").update("First repository\n").digest("hex"));
	assert.equal(corpus.documents[0].bytes, Buffer.byteLength("First repository\n"));
	assert.equal(corpus.documents[1].kind, "reference");
	assert.equal((await readEvidence(corpus, { sourceId: "one", path: "README.md" })).text, "First repository");
	assert.equal((await readEvidence(corpus, { sourceId: "two", path: "README.md" })).text, "Second repository");
	assert(!JSON.stringify(corpus).includes("First repository"));
	await assert.rejects(readEvidence(corpus, { sourceId: "one", path: "private.md" }), /Unknown evidence/);
});

test("rejects invalid paths, duplicate identities and files outside a root", async t => {
	const directory = await temporary(t);
	await mkdir(path.join(directory, "root"));
	await writeFile(path.join(directory, "outside.md"), "outside");
	const root = path.join(directory, "root");
	for (const invalid of ["../outside.md", "/tmp/outside.md", "folder/../outside.md", "./outside.md", "folder//outside.md", "C:\\outside.md", "C:outside.md", "folder\\outside.md"]) {
		await assert.rejects(snapshotSources([source(root, [invalid])]), /relative file path/);
	}
	await assert.rejects(snapshotSources([source(root, ["README.md"]), source(root, ["README.md"])]), /Duplicate source id/);
	await assert.rejects(snapshotSources([source(root, ["README.md", "README.md"])]), /Duplicate file/);
	await assert.rejects(snapshotSources([source(root, [])]), /explicit nonempty allowlist/);
	await assert.rejects(snapshotSources([source(root, ["README.md"], { id: "../bad" })]), /Source id/);
	await assert.rejects(snapshotSources([source(root, ["README.md"], { kind: "unknown" })]), /Unsupported source kind/);
	await symlink(path.join(directory, "outside.md"), path.join(root, "link.md"));
	await assert.rejects(snapshotSources([source(root, ["link.md"])]), /escapes source root/);
	await mkdir(path.join(root, "folder"));
	await assert.rejects(snapshotSources([source(root, ["folder"])]), /regular file/);
});

test("rejects FIFOs during snapshot and reread without waiting for a writer", { skip: process.platform === "win32" }, async t => {
	const directory = await temporary(t);
	await execFileAsync("mkfifo", [path.join(directory, "pipe.md")]);
	await writeFile(path.join(directory, "plain.md"), "original\n");
	const corpusModule = new URL("../dev/context-eval/corpus.mjs", import.meta.url).href;
	const program = `
		import assert from "node:assert/strict";
		import { rename } from "node:fs/promises";
		import { join } from "node:path";
		import { snapshotSources, readEvidence } from ${JSON.stringify(corpusModule)};
		const root = process.argv[1];
		const source = { id: "notes", kind: "personal", root, files: ["pipe.md"] };
		await assert.rejects(snapshotSources([source]), /regular file/);
		const corpus = await snapshotSources([{ ...source, files: ["plain.md"] }]);
		await rename(join(root, "pipe.md"), join(root, "plain.md"));
		await assert.rejects(readEvidence(corpus, { sourceId: "notes", path: "plain.md" }), /regular file/);
		console.log("FIFO rejected at both read boundaries");
	`;
	// A regression must kill only this child, never leave a blocked filesystem thread in the test runner.
	const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", program, directory], { timeout: 2000 });
	assert.equal(stdout.trim(), "FIFO rejected at both read boundaries");
});

test("rechecks containment and freshness before reading evidence", async t => {
	const directory = await temporary(t);
	const root = path.join(directory, "root");
	await mkdir(root);
	await writeFile(path.join(root, "notes.md"), "original\n");
	await writeFile(path.join(directory, "outside.md"), "original\n");
	const corpus = await snapshotSources([source(root, ["notes.md"])]);
	await writeFile(path.join(root, "notes.md"), "changed\n");
	await assert.rejects(readEvidence(corpus, { sourceId: "notes", path: "notes.md" }), /Stale evidence/);
	await rm(path.join(root, "notes.md"));
	await assert.rejects(readEvidence(corpus, { sourceId: "notes", path: "notes.md" }), /missing or inaccessible/);
	await symlink(path.join(directory, "outside.md"), path.join(root, "notes.md"));
	await assert.rejects(readEvidence(corpus, { sourceId: "notes", path: "notes.md" }), /escapes source root/);
});

test("returns validated one-based text ranges without a phantom trailing line", async t => {
	const directory = await temporary(t);
	await writeFile(path.join(directory, "notes.md"), "first\r\n第二行\r\nthird\r\n");
	await writeFile(path.join(directory, "empty.md"), "");
	const corpus = await snapshotSources([source(directory, ["notes.md", "empty.md"])]);
	assert.equal(corpus.documents[0].lineCount, 3);
	assert.equal(corpus.documents[1].lineCount, 0);
	const result = await readEvidence(corpus, { sourceId: "notes", path: "notes.md", lineStart: 2, lineEnd: 3 });
	assert.equal(result.text, "第二行\nthird");
	assert.deepEqual(result.location, { lineStart: 2, lineEnd: 3 });
	for (const range of [{ lineStart: 0 }, { lineStart: 2, lineEnd: 1 }, { lineEnd: 4 }, { lineStart: 1.5 }, { lineStart: "1" }]) {
		await assert.rejects(readEvidence(corpus, { sourceId: "notes", path: "notes.md", ...range }), /Text line range/);
	}
	await assert.rejects(readEvidence(corpus, { sourceId: "notes", path: "notes.md", page: 1 }), /Text evidence uses line/);
	const empty = await readEvidence(corpus, { sourceId: "notes", path: "empty.md" });
	assert.equal(empty.text, "");
	assert.deepEqual(empty.location, {});
	await assert.rejects(readEvidence(corpus, { sourceId: "notes", path: "empty.md", lineStart: 1 }), /Text line range/);
});

test("attributes Git commits only to tracked files and keeps dirty content hashes", async t => {
	const directory = await temporary(t);
	await runGit(directory, "init");
	await writeFile(path.join(directory, "tracked.mjs"), "export const version = 1;\n");
	await runGit(directory, "add", "tracked.mjs");
	await runGit(directory, "commit", "--no-gpg-sign", "-m", "test: initial evidence");
	const commit = (await runGit(directory, "rev-parse", "HEAD")).stdout.trim();
	const clean = await snapshotSources([source(directory, ["tracked.mjs"], { kind: "code" })]);
	assert.deepEqual(clean.documents[0].git, { commit, dirty: false });
	await writeFile(path.join(directory, "tracked.mjs"), "export const version = 2;\n");
	const dirty = await snapshotSources([source(directory, ["tracked.mjs"], { kind: "code" })]);
	assert.deepEqual(dirty.documents[0].git, { commit, dirty: true });
	assert.notEqual(clean.documents[0].sha256, dirty.documents[0].sha256);
	await assert.rejects(readEvidence(clean, { sourceId: "notes", path: "tracked.mjs" }), /Stale evidence/);
	await mkdir(path.join(directory, "node_modules", "sdk"), { recursive: true });
	await writeFile(path.join(directory, "node_modules", "sdk", "index.mjs"), "export const sdk = true;\n");
	const dependency = await snapshotSources([source(path.join(directory, "node_modules", "sdk"), ["index.mjs"], { kind: "code" })]);
	assert.equal(dependency.documents[0].git, undefined);
	assert.match(dependency.documents[0].sha256, /^[a-f0-9]{64}$/);
});

test("extracts original local PDF pages and rejects invented line mappings", async t => {
	const directory = await temporary(t);
	await writeFile(path.join(directory, "manual.pdf"), onePagePdf());
	const corpus = await snapshotSources([source(directory, ["manual.pdf"], { kind: "reference" })]);
	assert.equal(corpus.documents[0].pageCount, 1);
	assert.equal(corpus.documents[0].lineCount, undefined);
	const result = await readEvidence(corpus, { sourceId: "notes", path: "manual.pdf", page: 1 });
	assert.match(result.text, /Local engineering evidence/);
	assert.deepEqual(result.location, { page: 1 });
	await assert.rejects(readEvidence(corpus, { sourceId: "notes", path: "manual.pdf" }), /PDF page must/);
	await assert.rejects(readEvidence(corpus, { sourceId: "notes", path: "manual.pdf", page: 2 }), /PDF page must/);
	await assert.rejects(readEvidence(corpus, { sourceId: "notes", path: "manual.pdf", page: 1, lineStart: 1 }), /PDF evidence uses page/);
	await writeFile(path.join(directory, "manual.pdf"), "%PDF-1.4\ninvalid");
	await assert.rejects(readEvidence(corpus, { sourceId: "notes", path: "manual.pdf", page: 1 }), /Stale evidence/);
});

test("rejects oversized, binary and invalid UTF-8 documents before indexing", async t => {
	const directory = await temporary(t);
	await writeFile(path.join(directory, "large.md"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
	await writeFile(path.join(directory, "binary.txt"), Buffer.from([0x61, 0, 0x62]));
	await writeFile(path.join(directory, "legacy.txt"), Buffer.from([0xff, 0xfe]));
	await assert.rejects(snapshotSources([source(directory, ["large.md"])]), /byte limit/);
	await assert.rejects(snapshotSources([source(directory, ["binary.txt"])]), /Binary evidence is unsupported/);
	await assert.rejects(snapshotSources([source(directory, ["legacy.txt"])]), /must be UTF-8/);
});
