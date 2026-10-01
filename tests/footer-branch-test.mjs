import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
const base = mkdtempSync(join(tmpdir(), "pi-footer-"));
const repo = join(base, "repo"), plain = join(base, "plain");
mkdirSync(repo); mkdirSync(plain);
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-b", "main");
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
assert(port >= 8900);
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: repo, PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: join(base, "agent") }, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; server.stdout.on("data", (d) => { logs += d; }); server.stderr.on("data", (d) => { logs += d; });
let browser;
try {
	for (let n=0;n<100;n++) {
		try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
		if (n===99) throw new Error(logs);
		await new Promise((r) => setTimeout(r,100));
	}
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".setup-modal .modal-close").click();
	const waitBranch = (text) => page.waitForFunction((text) => document.querySelector(".status-branch-name")?.textContent === text, text);
	await waitBranch("main");
	assert(!(await page.locator("footer").innerText()).includes("$"));
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
	git("checkout", "-b", "feature/footer");
	await waitBranch("feature/footer");
	git("checkout", "--detach", "HEAD");
	await page.waitForFunction(() => document.querySelector(".status-branch-name")?.textContent.includes("HEAD"));
	const hash = git("rev-parse", "--short", "HEAD").toString().trim();
	assert((await page.locator(".status-branch-name").innerText()).includes(hash));
	await page.locator(".status-cwd").click();
	await page.locator(".status-cwd-input").fill(plain + "/");
	await page.locator(".status-cwd-input").press("Enter");
	await waitBranch("—");
	await page.waitForFunction((cwd) => document.querySelector(".status-cwd")?.textContent.includes(cwd), plain);
	await page.screenshot({ path: join(base,"footer.png") });
	console.log("PASS footer: unborn branch, external checkout auto-refresh, detached HEAD, non-repo, cost removed");
} finally {
	await browser?.close();
	server.kill("SIGTERM");
	await new Promise((r) => { if (server.exitCode !== null) r(); else server.once("exit",r); });
}
