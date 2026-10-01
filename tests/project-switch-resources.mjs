import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const base = mkdtempSync(join(tmpdir(), "pi-switch-"));
const agent = join(base, "agent");
process.env.PI_CODING_AGENT_DIR = agent;
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const projects = ["short-a", "short-b", "long-c"].map((name) => join(base, name));
for (const [i, project] of projects.entries()) {
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, `project-${i}.txt`), `project ${i}`);
	const session = SessionManager.create(project);
	for (let n = 0; n < (i === 2 ? 250 : 2); n++) {
		session.appendMessage({ role: "user", content: [{ type: "text", text: `fixture-${i}-${n}` }], timestamp: Date.now() });
		session.appendMessage({ role: "assistant", content: [{ type: "text", text: `reply-${i}-${n} ` + "example text ".repeat(40) }], api: "openai-completions", provider: "test", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	}
}

const baseline = process.argv[2];
if (!baseline) throw new Error("Usage: node tests/project-switch-resources.mjs /built/baseline [output.json]");
const output = process.argv[3] || join(base, "resources.json");
const diagnostic = join(base, "diagnostic.mjs");
writeFileSync(diagnostic, `process.on("message", (m) => {
	if (m?.type !== "resource-sample") return;
	const cpu = process.cpuUsage();
	if (m.gc) globalThis.gc?.();
	process.send?.({ type: "resource-sample", memory: process.memoryUsage(), cpu, time: Date.now() });
});`);
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
	for (const [version, root] of [["before", resolve(baseline)], ["after", process.cwd()]]) {
		const probe = createServer();
		await new Promise((r) => probe.listen(0, "127.0.0.1", r));
		const port = probe.address().port;
		await new Promise((r) => probe.close(r));
		assert(port >= 8900);
		const server = spawn(process.execPath, ["--expose-gc", "--import", diagnostic, join(root, "dist/server/index.js")], {
			cwd: root,
			env: { ...process.env, PORT: String(port), PI_WEB_CWD: projects[0], PI_WEB_DATA_DIR: join(base, version), PI_WEB_PKG_ROOT: root, PI_CODING_AGENT_DIR: agent },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		let logs = "";
		server.stdout.on("data", (d) => { logs += d; });
		server.stderr.on("data", (d) => { logs += d; });
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		const cdp = await context.newCDPSession(page);
		await cdp.send("Performance.enable");
		const samples = [];
		async function sample(phase, count, gc = true) {
			if (gc) { await sleep(150); await cdp.send("HeapProfiler.collectGarbage"); }
			const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
			const dom = await cdp.send("Memory.getDOMCounters");
			const backend = await new Promise((res, rej) => {
				const timer = setTimeout(() => { server.off("message", handler); rej(new Error("sample timeout")); }, 10000);
				const handler = (m) => { if (m.type === "resource-sample") { clearTimeout(timer); server.off("message", handler); res(m); } };
				server.on("message", handler);
				server.send({ type: "resource-sample", gc });
			});
			const record = { phase, count, metrics, dom, backend };
			samples.push(record);
			console.log(`${version} ${phase} ${count}: frontend heap=${(metrics.JSHeapUsedSize/1048576).toFixed(2)}MiB nodes=${dom.nodes} listeners=${dom.jsEventListeners}, server heap=${(backend.memory.heapUsed/1048576).toFixed(2)}MiB RSS=${(backend.memory.rss/1048576).toFixed(1)}MiB`);
			return record;
		}
		try {
			for (let n=0;n<200;n++) {
				try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
				if (n===199) throw new Error(logs);
				await sleep(50);
			}
			await page.goto(`http://127.0.0.1:${port}`);
			await page.locator(".setup-modal .modal-close").click();
			await page.waitForSelector(`.project-item[title="${projects[1]}"]`);
			async function select(i) {
				await page.evaluate((path) => document.querySelector(`.project-item[title="${path}"]`).click(), projects[i]);
				await page.waitForFunction((marker) => document.querySelector("main")?.textContent.includes(marker) && !document.querySelector('.protocol-banner[role="status"]') && !document.querySelector("textarea").disabled, `fixture-${i}-`);
				await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
			}
			for (let n=0;n<30;n++) await select((n+1)%3);
			await sample("projects",0);
			for (let n=0;n<300;n++) {
				await select((n+1)%3);
				if ((n+1)%50===0) await sample("projects",n+1);
			}
			await page.getByRole("tab").nth(1).click();
			await page.waitForSelector(".xterm-screen");
			await page.getByRole("tab").nth(2).click();
			await page.waitForSelector(".scm-view");
			await sample("views",0);
			for (let n=0;n<300;n++) {
				await page.evaluate(async (i) => {
					document.querySelectorAll('[role="tab"]')[i].click();
					await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
				}, n%3);
				if ((n+1)%100===0) await sample("views",n+1);
			}
			const start = await sample("idle",0,false);
			await sleep(10000);
			const end = await sample("idle",10,false);
			const seconds = (end.backend.time-start.backend.time)/1000;
			const idle = {
				rendererMainThreadPercent: (end.metrics.TaskDuration-start.metrics.TaskDuration)/seconds*100,
				serverCpuPercent: ((end.backend.cpu.user+end.backend.cpu.system)-(start.backend.cpu.user+start.backend.cpu.system))/1e6/seconds*100,
			};
			await sample("settled",300);
			results.push({ version, samples, idle });
			console.log(version, "idle", idle);
		} finally {
			await context.close(); server.kill("SIGTERM");
			await new Promise((r) => { if (server.exitCode !== null) r(); else server.once("exit",r); });
		}
	}
	writeFileSync(output, JSON.stringify({ baseline: "aa3d48a", node: process.version, chrome: await browser.version(), results }, null, 2));
	console.log(`Results: ${output}`);
} finally { await browser.close(); }
