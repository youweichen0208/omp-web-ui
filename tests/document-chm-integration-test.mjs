/** Real CHM -> service/cache -> OKF evidence, no model calls. Requires an installed CHM runtime. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { updateDocumentSettings } from '../dist/server/document-conversion/settings.js';
import { chmPython, doctorChmRuntime } from '../dist/server/document-conversion/chm-runtime.js';
import { convertDocument } from '../dist/server/document-conversion/service.js';
import { nextIngestion, publishKnowledge, readCandidates, startIngestion, submitCandidates } from '../dist/server/okf/service.js';

const runtimeParent = process.env.PI_CHM_TEST_RUNTIME;
assert(runtimeParent, 'PI_CHM_TEST_RUNTIME must name a directory containing chm-html-v1/venv');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-chm-integration-')));
const previous = process.env.PI_WEB_DATA_DIR;
process.env.PI_WEB_DATA_DIR = join(root, 'data');
try {
	updateDocumentSettings({ runtimePath: resolve(runtimeParent) });
	const doctor = await doctorChmRuntime();
	assert(doctor.ready, JSON.stringify(doctor));
	const cwd = join(root, 'workspace'); mkdirSync(cwd);
	const inputPath = join(cwd, 'manual.CHM');
	execFileSync(chmPython(), ['-c', 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from fixture import archive_bytes, sample_files; files = sample_files(); files["start.htm"] += b\'<a href="ms-its:manual.CHM::/api.htm#call">Self archive</a>\'; Path(sys.argv[2]).write_bytes(archive_bytes(files))', resolve('server/document-conversion/python/chm'), inputPath]);
	const outputDir = join(cwd, 'converted');
	const first = await convertDocument({ inputPath, outputDir });
	assert.equal(first.status, 'complete');
	assert.match(readFileSync(first.markdownPath, 'utf8'), /中文内容/);
	assert(first.blocks.some(block => block.locator.member === 'api.htm' && block.text.includes('return sum')));
	const progress = [];
	await convertDocument({ inputPath, outputDir, onProgress: text => progress.push(text) });
	assert(progress.some(text => text.includes('unchanged')), 'complete CHM artifacts reuse cache');
	updateDocumentSettings({ pdfEnabled: false }); // Markdown intake has no conversion dependency.
	const job = await startIngestion({ cwd, inputPaths: [outputDir] });
	await nextIngestion({ cwd, jobId: job.jobId });
	const review = await readCandidates({ cwd, jobId: job.jobId });
	const source = review.sources[0];
	assert.equal(source.state, 'complete');
	const blocks = JSON.parse(readFileSync(source.blocksPath, 'utf8'));
	const block = blocks.find(block => block.text.includes('return sum'));
	assert(block);
	assert.equal(block.locator.member, 'api.htm');
	await submitCandidates({ cwd, jobId: job.jobId, sourceId: source.sourceId, producer: 'pi-harness/chm-test', candidates: [{ basis: 'fact', conceptId: 'api-total', title: 'Total API', type: 'API', statement: 'The example returns the sum of the values.', evidence: [{ sourceId: source.sourceId, sourceHash: source.hash, blockId: block.id, quote: 'return sum(values)' }], review: { support: 'supported', rationale: 'The synthetic CHM code directly calls sum; no other concepts or conflicting sources exist.', comparedConceptIds: [], conflicts: [] } }] });
	const published = await publishKnowledge({ cwd, jobId: job.jobId, producer: 'pi-harness/chm-test' });
	assert(published.draft.includes('api-total'));
	assert(existsSync(published.indexPath));
	const structure = JSON.parse(readFileSync(join(source.markdownPath, '..', 'structure.json'), 'utf8'));
	assert(structure.topics.every(topic => existsSync(join(source.markdownPath, '..', topic.markdownPath))), 'topic files are archived with OKF evidence');
	writeFileSync(first.markdownPath, 'Human edit');
	await assert.rejects(convertDocument({ inputPath, outputDir }), /edited/);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(convertDocument({ inputPath, outputDir: join(cwd, 'aborted'), signal: controller.signal }), /abort/i);
	console.log('PASS real CHM conversion, cache, provenance, OKF publication, archived topics, edit protection and cancellation');
} finally {
	if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
	rmSync(root, { recursive: true, force: true });
}
