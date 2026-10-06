/** Check every sampled PID after all benchmarks, including reparented descendants.
 * Ignore reused PIDs whose current start time is newer than their final observation.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.argv[2] ?? 'docs/review-data';
const observed = new Map();
for (const mode of ['sdk', 'web', 'electron', 'web-default', 'electron-default', 'web-history', 'electron-history', 'native-tools']) {
	const directory = join(root, mode); if (!existsSync(directory)) continue;
	for (const round of readdirSync(directory).filter(name => name.startsWith('round-'))) {
		for (const filename of ['samples.jsonl', 'process.jsonl']) {
			const path = join(directory, round, filename); if (!existsSync(path)) continue;
			for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
				const sample = JSON.parse(line);
				for (const process of sample.processes ?? [{ pid: sample.pid }]) observed.set(process.pid, Math.max(observed.get(process.pid) ?? 0, sample.time));
			}
		}
	}
}
const current = execFileSync('ps', ['-axo', 'pid=,lstart=,command='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
const remaining = [], reused = [];
for (const line of current.trim().split('\n')) {
	const match = line.trim().match(/^(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
	if (!match || !observed.has(Number(match[1]))) continue;
	const record = { pid: Number(match[1]), startTime: match[2], command: match[3], lastObserved: observed.get(Number(match[1])) };
	const start = Date.parse(match[2]);
	if (Number.isFinite(start) && start > record.lastObserved) reused.push({ pid: record.pid, startTime: record.startTime, lastObserved: record.lastObserved });
	else remaining.push(record);
}
const result = { timestamp: new Date().toISOString(), observedPidCount: observed.size, definition: 'All sampled descendants, checked after benchmark exit; excludes later PID reuse; cannot detect processes never sampled', remaining, reused };
writeFileSync(join(root, 'cleanup-audit.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (remaining.length) process.exitCode = 1;
