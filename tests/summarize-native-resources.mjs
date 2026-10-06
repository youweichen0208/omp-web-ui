/** Summarize raw JSONL without confusing natural peaks with explicit post-GC samples. */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2] ?? 'docs/review-data');
const lines = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
const quantile = (values, fraction) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null; };
const mib = value => value / 1048576;
const summary = {};
for (const mode of ['sdk', 'web', 'electron', 'web-default', 'electron-default', 'web-history', 'electron-history']) {
	const directory = join(root, mode); if (!existsSync(directory)) continue;
	const events = lines(join(directory, 'events.jsonl'));
	const phases = [];
	for (const round of readdirSync(directory).filter(name => name.startsWith('round-'))) {
		const n = Number(round.slice(6));
		const samples = lines(join(directory, round, 'samples.jsonl'));
		for (let i = 1; i < samples.length; i++) {
			const a = samples[i - 1], b = samples[i];
			if (a.electronMain && b.electronMain) b.electronMainCpuPercent = (b.electronMain.cpu.user + b.electronMain.cpu.system - a.electronMain.cpu.user - a.electronMain.cpu.system) / ((b.time - a.time) * 1000) * 100;
			if (a.metrics && b.metrics) b.rendererMainThreadDutyPercent = (b.metrics.TaskDuration - a.metrics.TaskDuration) / (b.metrics.Timestamp - a.metrics.Timestamp) * 100;
		}
		const processes = lines(join(directory, round, 'process.jsonl')).filter(s => s.argv.some(a => a.endsWith('/server/index.js') || a.endsWith('resource-sdk.mjs')));
		for (let i = 1; i < processes.length; i++) {
			const a = processes[i - 1], b = processes[i];
			if (a.pid === b.pid) b.cpuPercent = (b.cpu.user + b.cpu.system - a.cpu.user - a.cpu.system) / ((b.time - a.time) * 1000) * 100;
		}
		for (const start of events.filter(e => e.round === n && e.state === 'start')) {
			const end = events.find(e => e.round === n && e.phase === start.phase && e.state === 'end' && e.time > start.time);
			if (!end) continue;
			const backend = processes.filter(s => s.time >= start.time && s.time <= end.time), natural = backend.filter(s => !s.gc), gc = backend.filter(s => s.gc).at(-1);
			const frontend = samples.filter(s => s.phase === start.phase && s.time >= start.time && s.time <= end.time), frontendGc = frontend.filter(s => s.gc).at(-1);
			const values = key => natural.map(s => s.memory[key]);
			const phase = { round: n, phase: start.phase, durationSeconds: (end.time - start.time) / 1000, backendSamples: backend.length,
				natural: { rssPeakMiB: mib(Math.max(...values('rss'))), heapPeakMiB: mib(Math.max(...values('heapUsed'))), externalPeakMiB: mib(Math.max(...values('external'))), cpuP50Percent: quantile(natural.map(s => s.cpuPercent), .5), cpuP95Percent: quantile(natural.map(s => s.cpuPercent), .95), handlesMax: Math.max(...natural.map(s => s.handles)) },
				postGc: gc ? { rssMiB: mib(gc.memory.rss), heapMiB: mib(gc.memory.heapUsed), externalMiB: mib(gc.memory.external), handles: gc.handles, activeResources: gc.resources.length } : null,
				electronMain: frontendGc?.electronMain ? { heapMiB: mib(frontendGc.electronMain.memory.heapUsed), rssMiB: mib(frontendGc.electronMain.memory.rss), externalMiB: mib(frontendGc.electronMain.memory.external), handles: frontendGc.electronMain.handles } : null,
				frontend: frontendGc?.metrics ? { heapMiB: mib(frontendGc.metrics.JSHeapUsedSize), nodes: frontendGc.dom.nodes, listeners: frontendGc.dom.jsEventListeners, httpBytesCumulative: frontendGc.netBytes, wsDecodedBytesCumulative: frontendGc.frontendWsBytes } : null,
				processTreeRssPeakMiB: Math.max(...frontend.filter(s => !s.gc).map(s => s.processes.reduce((sum, p) => sum + p.rssKiB, 0) / 1024)), processCountMax: Math.max(...frontend.map(s => s.processes.length)) };
			phase.frontendCpu = {
				electronMainP50: quantile(frontend.filter(s => !s.gc).map(s => s.electronMainCpuPercent), .5),
				electronMainP95: quantile(frontend.filter(s => !s.gc).map(s => s.electronMainCpuPercent), .95),
				rendererMainThreadDutyP50: quantile(frontend.filter(s => !s.gc).map(s => s.rendererMainThreadDutyPercent), .5),
				rendererMainThreadDutyP95: quantile(frontend.filter(s => !s.gc).map(s => s.rendererMainThreadDutyPercent), .95),
			};
			if (start.phase === 'soak') {
				const first = natural.filter(s => s.time < start.time + 60000), last = natural.filter(s => s.time > end.time - 60000);
				phase.soak = { firstMinuteMedianHeapMiB: mib(quantile(first.map(s => s.memory.heapUsed), .5)), lastMinuteMedianHeapMiB: mib(quantile(last.map(s => s.memory.heapUsed), .5)), firstMinuteMedianRssMiB: mib(quantile(first.map(s => s.memory.rss), .5)), lastMinuteMedianRssMiB: mib(quantile(last.map(s => s.memory.rss), .5)), loops: end.loops };
			}
			phases.push(phase);
		}
	}
	const latencies = [];
	for (const phase of ['server-ready', 'ui-ready', 'messages-500', 'messages-5000', 'messages-20000', 'soak']) {
		const values = events.filter(e => e.phase === phase && typeof e.ms === 'number').map(e => e.ms);
		latencies.push({ phase, samples: values.length, p50Ms: quantile(values, .5), p95Ms: quantile(values, .95) });
	}
	summary[mode] = { environment: JSON.parse(readFileSync(join(directory, 'environment.json'))), phases, latencies, cleanup: events.filter(e => e.phase === 'cleanup'), samplingErrors: events.filter(e => e.error), transfers: events.filter(e => e.transport) };
}
writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log('Wrote', join(root, 'summary.json'));
const format = n => Number.isFinite(n) ? n.toFixed(1) : '—';
const report = ['# 资源采样汇总', '', '由 `node tests/summarize-native-resources.mjs` 从原始 JSONL 生成。MiB=2²⁰ bytes；短场景为三个累计工作集轮次。峰值取三轮最大值，GC 后留存列三轮最小–最大值；不可将后续阶段当作干净基线。', ''];
for (const [mode, result] of Object.entries(summary)) {
	report.push(`## ${mode}`, '', '| 阶段 | 后端自然 RSS 峰值 MiB | 后端 GC heap MiB 范围 | 渲染 GC heap MiB 范围 | 最大 GC DOM | 全进程树自然 RSS 峰值 MiB |', '| --- | ---: | ---: | ---: | ---: | ---: |');
	for (const phase of new Set(result.phases.map(p => p.phase))) {
		const rows = result.phases.filter(p => p.phase === phase);
		const range = values => { const finite = values.filter(Number.isFinite); return finite.length ? `${format(Math.min(...finite))}–${format(Math.max(...finite))}` : '—'; };
		report.push(`| ${phase} | ${format(Math.max(...rows.map(p => p.natural.rssPeakMiB)))} | ${range(rows.map(p => p.postGc?.heapMiB))} | ${range(rows.map(p => p.frontend?.heapMiB))} | ${Math.max(...rows.map(p => p.frontend?.nodes ?? 0)) || '—'} | ${format(Math.max(...rows.map(p => p.processTreeRssPeakMiB)))} |`);
	}
	report.push('', '| 观测延迟（非精确按键到绘制） | n | P50 ms | P95 ms |', '| --- | ---: | ---: | ---: |');
	for (const latency of result.latencies.filter(l => l.samples)) report.push(`| ${latency.phase} | ${latency.samples} | ${format(latency.p50Ms)} | ${format(latency.p95Ms)} |`);
	for (const phase of result.phases.filter(p => p.soak)) report.push('', `固定工作集循环 ${format(phase.durationSeconds / 60)} 分钟、${phase.soak.loops} 次。首/末分钟后端 heap 中位数 ${format(phase.soak.firstMinuteMedianHeapMiB)} / ${format(phase.soak.lastMinuteMedianHeapMiB)} MiB；RSS 中位数 ${format(phase.soak.firstMinuteMedianRssMiB)} / ${format(phase.soak.lastMinuteMedianRssMiB)} MiB。CPU P50/P95 ${format(phase.natural.cpuP50Percent)}% / ${format(phase.natural.cpuP95Percent)}%，分母为单核100%。`);
	report.push('', `采样错误记录 ${result.samplingErrors.length} 条（保留在 events.jsonl）；清理检查：${result.cleanup.length} 轮；退出后本轮进程树剩余 ${result.cleanup.map(e => e.remaining.length).join('/')} 个。`, '');
}
writeFileSync(join(root, 'resource-metrics.md'), report.join('\n') + '\n');

const toolsDirectory = join(root, 'native-tools');
if (existsSync(toolsDirectory)) {
	const events = lines(join(toolsDirectory, 'events.jsonl'));
	const measurements = [];
	for (const round of [1, 2, 3]) {
		const samples = lines(join(toolsDirectory, `round-${round}`, 'process.jsonl')).filter(s => s.argv[0]?.endsWith('native-resource-tools.mjs'));
		for (const start of events.filter(e => e.round === round && e.state === 'start')) {
			const end = events.find(e => e.round === round && e.phase === start.phase && e.state === 'end');
			if (!end) continue;
			const stage = samples.filter(s => s.time >= start.time && s.time <= end.time);
			const gc = stage.filter(s => s.gc).at(-1);
			measurements.push({ round, phase: start.phase, naturalRssPeakMiB: mib(Math.max(...stage.filter(s => !s.gc).map(s => s.memory.rss))), postGc: gc ? { heapMiB: mib(gc.memory.heapUsed), externalMiB: mib(gc.memory.external), handles: gc.handles } : null });
		}
	}
	writeFileSync(join(root, 'native-tools-summary.json'), JSON.stringify({ definition: 'Isolated native session process, excludes MCP child RSS; three serial rounds with local model and stdio MCP', measurements }, null, 2) + '\n');
}
