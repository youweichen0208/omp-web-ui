/** Measure build/package footprint; run after benchmarks to avoid disk contention. */
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const visited = new Set();
function size(path) {
	if (visited.has(path) || !existsSync(path)) return 0;
	visited.add(path);
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) return stat.size;
	if (!stat.isDirectory()) return stat.size;
	return readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0);
}
const measure = path => { visited.clear(); return size(resolve(path)); };
const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }))[0];
const dependencyTree = spawnSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
if (!dependencyTree.stdout?.trim()) throw Error(dependencyTree.stderr);
const paths = dependencyTree.stdout.trim().split('\n').filter(path => path !== process.cwd());
visited.clear(); const productionDependencyBytes = paths.reduce((sum, path) => sum + size(path), 0);
const topProductionDirectories = paths.filter(path => /^(@[^/]+\/)?[^/]+$/.test(path.slice(resolve('node_modules').length + 1)))
	.map(path => ({ name: path.slice(resolve('node_modules').length + 1), bytes: measure(path) }))
	.sort((a, b) => b.bytes - a.bytes).slice(0, 15);
const app = 'release/mac-arm64/pi.app';
const version = JSON.parse(readFileSync('package.json')).version;
const installers = [`release/pi-${version}-mac-arm64.dmg`, `release/pi-${version}-mac-arm64.zip`].filter(existsSync).map(path => ({ path, bytes: lstatSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
const output = { version, sdk: '1.0.4', node: process.version, timestamp: new Date().toISOString(), definition: 'logical file bytes, symlink bytes counted once by path; production dependency paths from npm ls --omit=dev --all, no fresh global install', npm: { compressedBytes: pack.size, unpackedBytes: pack.unpackedSize, fileCount: pack.entryCount }, productionDependencyBytes, dependencyTreeExitCode: dependencyTree.status, dependencyTreeDiagnostic: dependencyTree.stderr, webBuildBytes: measure('web/dist'), serverBuildBytes: measure('dist/server'), localMacApplicationBytes: existsSync(app) ? measure(app) : null, localMacAllocatedBytes: existsSync(app) ? Number(execFileSync('du', ['-sk', app], { encoding: 'utf8' }).trim().split(/\s+/)[0]) * 1024 : null, localMacAppProductionDependencyBytes: existsSync(app) ? measure(join(app, 'Contents/Resources/app/node_modules')) : null, installers };
output.topProductionDirectories = topProductionDirectories;
writeFileSync('docs/review-data/package-size.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
