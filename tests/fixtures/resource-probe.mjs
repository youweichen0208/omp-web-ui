// Test-only preload. Samples the production process without changing application code.
import { appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
const directory = process.env.PI_RESOURCE_PROBE;
if (directory) {
	setFlagsFromString('--expose_gc');
	const collect = runInNewContext('gc');
	const sample = () => {
		const request = join(directory, `gc-${process.pid}`);
		const gc = existsSync(request);
		if (gc) { unlinkSync(request); collect(); }
		appendFileSync(join(directory, 'process.jsonl'), JSON.stringify({ time: Date.now(), pid: process.pid, node: process.version, electron: process.versions.electron, argv: process.argv.slice(1), gc, memory: process.memoryUsage(), cpu: process.cpuUsage(), handles: process._getActiveHandles().length, resources: process.getActiveResourcesInfo() }) + '\n');
	};
	const timer = setInterval(sample, 1000); timer.unref(); sample();
}
