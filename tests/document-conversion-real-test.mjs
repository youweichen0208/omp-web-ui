/** Opt-in real model test. Set PI_WEB_DATA_DIR to an isolated, prepared runtime.
 * Does not download models or call a hosted model. Not part of zero-dependency CI.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { doctorRuntime, runDocumentProcess, runtimePython, bridgePath, shutdownDocumentRuntime } from "../dist/server/document-conversion/runtime.js";
import { convertDocument } from "../dist/server/document-conversion/service.js";

const doctor = await doctorRuntime();
assert.equal(doctor.ready, true, `Prepare an isolated runtime with /pdf-md setup: ${doctor.missing.join("; ")}`);
const folder = await mkdtemp(join(tmpdir(), "document-conversion-real-"));
try {
	await runDocumentProcess(runtimePython(), ["-c", "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from fixtures import make_fixtures; make_fixtures(Path(sys.argv[2]))", dirname(bridgePath()), folder], { offline: true });
	for (const [name, marker, expectedStatus = "complete"] of [["scanned.pdf", "123"], ["digital.pdf", "456"], ["digital-short.pdf", "456"], ["digital-ambiguous.pdf", "456", "partial"], ["office.docx", "789"], ["sheet.xlsx", "321"], ["slides.pptx", "654"]]) {
		const outputDir = join(folder, `${name}-output`);
		const result = await convertDocument({ inputPath: join(folder, name), outputDir, onProgress: line => console.log(line) });
		assert.equal(result.status, expectedStatus, `${name}: ${result.warnings.join("; ")}`);
		const markdown = await readFile(result.markdownPath, "utf8");
		assert.ok(markdown.includes(marker), `${name} lost fixture content`);
		if (name.startsWith("digital") && expectedStatus === "complete") assert.ok(markdown.includes("def calculate_total(values):\n    return sum(values)"), "PDF code lost text/indentation");
		if (expectedStatus === "partial") assert.ok(result.warnings.some(warning => warning.startsWith("Native code layout could not be verified")), "Ambiguous code was not flagged for review");
		if (name === "scanned.pdf") assert.ok(markdown.replace(/\s+/g, "").includes("公司资料扫描表格"), "Chinese OCR failed");
		const structure = JSON.parse(await readFile(result.structurePath, "utf8"));
		if (name.endsWith(".pdf")) {
			assert.ok(structure.tables.length > 0, `${name} lost table structure`);
			const expected = [[0, 0, "Name"], [0, 1, "Value"], [1, 0, "Total"], [1, 1, marker]];
			assert.ok(structure.tables.some(table => expected.every(([row, column, text]) => table.data.table_cells.some(cell => cell.start_row_offset_idx === row && cell.start_col_offset_idx === column && cell.text.trim() === text))), `${name} table values or row/column positions changed`);
			assert.ok(result.blocks.every(block => block.locator.page === 1), "PDF blocks lost page provenance");
		}
		const imageUris = [];
		function visit(value) {
			if (!value || typeof value !== "object") return;
			for (const [key, child] of Object.entries(value)) {
				if (key === "uri" && typeof child === "string") imageUris.push(child);
				else visit(child);
			}
		}
		visit(structure);
		for (const uri of imageUris) {
			assert.ok(!isAbsolute(uri) && !/^[a-z]+:/i.test(uri), `Nonportable image URI: ${uri}`);
			await access(join(outputDir, decodeURIComponent(uri)));
		}
		if (expectedStatus === "complete") {
			const progress = [];
			await convertDocument({ inputPath: join(folder, name), outputDir, onProgress: line => progress.push(line) });
			assert.ok(progress.some(line => line.includes("unchanged")), "Repeat conversion missed verified output cache");
		}
	}
} finally {
	await shutdownDocumentRuntime();
	await rm(folder, { recursive: true, force: true });
}
console.log("Real offline Docling fixtures passed (synthetic engine checks; company corpus quality still needs evaluation).");
