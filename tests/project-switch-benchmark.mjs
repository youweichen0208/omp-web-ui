import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import WebSocket from "ws";
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
if (!baseline) throw new Error("Usage: node tests/project-switch-benchmark.mjs /path/to/built/baseline [output.json]");
const roots = { before: resolve(baseline), after: process.cwd() };
const output = process.argv[3] || join(base, "results.json");
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const samples = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(version, delay, round) {
	const probe = createServer();
	await new Promise((r) => probe.listen(0, "127.0.0.1", r));
	const port = probe.address().port;
	await new Promise((r) => probe.close(r));
	assert(port >= 8900);
	const root = roots[version];
	const server = spawn(process.execPath, [join(root, "dist/server/index.js")], {
		cwd: root,
		env: { ...process.env, PORT: String(port), PI_WEB_CWD: projects[0], PI_WEB_DATA_DIR: join(base, `${version}-${delay}-${round}`), PI_WEB_PKG_ROOT: root, PI_CODING_AGENT_DIR: agent },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let logs = "";
	server.stdout.on("data", (d) => { logs += d; });
	server.stderr.on("data", (d) => { logs += d; });
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	const timers = new Set();
	try {
		for (let n = 0; n < 200; n++) {
			try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
			if (n === 199) throw new Error(logs);
			await sleep(50);
		}
		await page.routeWebSocket("**/ws", (route) => {
			const backend = route.connectToServer();
			route.onMessage((raw) => backend.send(raw));
			backend.onMessage((raw) => {
				if (!delay) { route.send(raw); return; }
				const timer = setTimeout(() => { timers.delete(timer); route.send(raw); }, delay);
				timers.add(timer);
			});
		});
		await page.goto(`http://127.0.0.1:${port}`);
		await page.locator(".setup-modal .modal-close").click();
		await page.waitForSelector(`.project-item[title="${projects[1]}"]`);
		const select = async (i) => {
			const ms = await page.evaluate(async ({ path, marker }) => {
				const start = performance.now();
				document.querySelector(`.project-item[title="${path}"]`).click();
				await new Promise((res, rej) => {
					const check = () => {
						const main = document.querySelector("main");
						if (main?.textContent.includes(marker) && main.getBoundingClientRect().height) {
							requestAnimationFrame(() => requestAnimationFrame(res));
						} else if (performance.now() - start > 10000) rej(new Error("target content timeout"));
						else requestAnimationFrame(check);
					}; check();
				});
				return performance.now() - start;
			}, { path: projects[i], marker: `fixture-${i}-` });
			// Keep synchronization outside the content-first-frame measurement.
			await page.waitForFunction(() => !document.querySelector('.protocol-banner[role="status"]') && !document.querySelector("textarea").disabled);
			await page.waitForTimeout(100);
			return ms;
		};
		const record = (scenario, ms) => samples.push({ version, delay, round, scenario, ms });
		record("cold-short", await select(1));
		await select(0);
		for (let n = 0; n < 20; n++) record("warm-short", await select(n % 2 ? 0 : 1));
		record("cold-long", await select(2));
		for (let n = 0; n < 20; n++) { await select(0); record("warm-long", await select(2)); }
		await page.getByRole("tab").nth(1).click();
		await page.waitForSelector(".xterm-screen");
		await page.getByRole("tab").nth(2).click();
		await page.waitForSelector(".scm-view");
		for (let n = 0; n < 20; n++) {
			const ms = await page.evaluate(async (index) => {
				const start = performance.now();
				document.querySelectorAll('[role="tab"]')[index].click();
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
				const el = document.querySelector(index === 1 ? ".xterm-screen" : ".scm-view");
				if (!el?.getBoundingClientRect().height) throw new Error("hidden view");
				return performance.now() - start;
			}, n % 2 ? 2 : 1);
			record("warm-view", ms);
		}
		console.log(`completed ${version} delay=${delay} round=${round}`);
	} finally {
		for (const timer of timers) clearTimeout(timer);
		await context.close();
		server.kill("SIGTERM");
		await new Promise((r) => { if (server.exitCode !== null) r(); else server.once("exit", r); });
	}
}
try {
	for (const delay of [0, 150]) {
		// ABBA order reduces warmup/order bias; each group has 40 warm samples.
		for (const [round, order] of [[0, ["before", "after"]], [1, ["after", "before"]]]) {
			for (const version of order) await run(version, delay, round);
		}
	}
	const summary = [];
	for (const delay of [0, 150]) for (const scenario of ["cold-short", "warm-short", "cold-long", "warm-long", "warm-view"]) {
		const row = { delay, scenario };
		for (const version of ["before", "after"]) {
			const values = samples.filter((s) => s.delay === delay && s.scenario === scenario && s.version === version).map((s) => s.ms).sort((a,b) => a-b);
			row[version] = { n: values.length, median: values[Math.ceil(values.length*.5)-1], p95: values[Math.ceil(values.length*.95)-1] };
		}
		summary.push(row);
	}
	writeFileSync(output, JSON.stringify({ baseline: "aa3d48a (0.47.6)", current: "working tree", node: process.version, chrome: await browser.version(), samples, summary }, null, 2));
	console.log(JSON.stringify(summary, null, 2));
	console.log(`Results: ${output}`);
} finally { await browser.close(); }
