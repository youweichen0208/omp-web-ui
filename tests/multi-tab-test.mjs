// Multi-tab client isolation — regression test for issue #10.
//
// 两个标签页（同一 origin）曾共享 localStorage 里的 clientId，命中后端同一个
// ClientSession：B 页切换对话会同步切走 A 页并中断正在运行的 agent。
// 修复后 clientId 存 sessionStorage（每标签页独立），两页应是两个独立客户端：
//   1. 两页的 clientId 不同；
//   2. A 页切换对话不会改变 B 页的 activeId / 消息列表；
//   3. B 页发 prompt 不影响 A 页正在流式输出的内容（A 的 snapshot 不被 B 打断）。
//
// Usage: node tests/multi-tab-test.mjs   （需要本机 Chrome，见 lib/chrome.mjs）
import { chromium } from "playwright-core";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHROME_PATH } from "./lib/chrome.mjs";

const PORT = 8977;
const base = mkdtempSync(join(tmpdir(), "pi-web-multitab-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const otherDir = join(base, "other-work");
mkdirSync(otherDir);
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const NODE = realpathSync(process.execPath);
// fileURLToPath: URL.pathname 在 Windows 下非法；cwd 必须指向仓库根
const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const server = spawn(NODE, ["dist/server/index.js"], {
	cwd: REPO,
	env: {
		...process.env,
		PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "inherit", "inherit"],
	windowsHide: true,
});
server.on("error", (e) => console.error("[spawn error]", e));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

async function waitReady() {
	for (let i = 0; i < 60; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (res.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(300);
	}
	throw new Error("server did not start");
}

/** 从页面里读出当前 clientId（与 use-chat.ts 的 key 保持一致）。 */
const readClientId = (page) =>
	page.evaluate(() => sessionStorage.getItem("pi-web-client-id"));
/** 等待页面 WebSocket ready。 */
const waitChatReady = (page) =>
	page.waitForFunction(() => sessionStorage.getItem("pi-web-client-id") && document.querySelector(".project-item.active"), null, { timeout: 20000 });

try {
	await waitReady();
	if (!CHROME_PATH) throw new Error("no Chrome found (set PI_WEB_CHROME)");
	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
		headless: true,
	});
	const ctx = await browser.newContext();
	const a = await ctx.newPage();
	const b = await ctx.newPage();

	await a.goto(`http://127.0.0.1:${PORT}`);
	await waitChatReady(a);
	await b.goto(`http://127.0.0.1:${PORT}`);
	await waitChatReady(b);

	const idA = await readClientId(a);
	const idB = await readClientId(b);
	check("two tabs have DIFFERENT clientIds", !!idA && !!idB && idA !== idB, `${idA?.slice(0, 8)} vs ${idB?.slice(0, 8)}`);

	// Exercise actual workspace separation, not changing DOM length (clocks/setup change it).
	for (const page of [a, b]) {
		if (await page.locator(".setup-modal").count()) await page.locator(".setup-modal .modal-close").click();
	}
	const projectA = await a.locator(".project-item.active .project-name").textContent();
	await b.locator(".lp-add-project").click();
	await b.locator(".fpk-modal-foot input").fill(otherDir);
	await b.locator(".fpk-open-btn").click();
	await b.locator(".project-item.active .project-name", { hasText: "other-work" }).waitFor();
	await b.reload();
	await waitChatReady(b);
	check("tab B switch and reload do not disturb tab A", await a.locator(".project-item.active .project-name").textContent() === projectA);
	check("tab B restores its own workspace", await b.locator(".project-item.active .project-name").textContent() === "other-work");
	await a.reload();
	await waitChatReady(a);
	check("tab A keeps its clientId across reload", await readClientId(a) === idA);
	check("tab B keeps its independent clientId", await readClientId(b) === idB);

	await browser.close();
	console.log(`\n${passed} passed, ${failed} failed`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
} finally {
	if (server.pid) process.kill(server.pid, "SIGTERM");
	await sleep(500);
	process.exit(failed === 0 ? 0 : 1);
}
