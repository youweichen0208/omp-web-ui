// Real Electron shell, isolated backend and Chromium profile. No provider calls.
import { _electron as electron } from "playwright-core";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const base = mkdtempSync(join(tmpdir(), "pi-switch-electron-"));
const workspace = join(base, "workspace");
mkdirSync(workspace);
let app;
try {
	app = await electron.launch({ args: [".", `--user-data-dir=${join(base, "profile")}`], env: { ...process.env, PI_WEB_DATA_DIR: join(base, "data"), PI_WEB_CWD: workspace, PI_CODING_AGENT_DIR: join(base, "agent") } });
	let page;
	for (let n = 0; n < 200; n++) {
		page = app.windows().find((w) => w.url().startsWith("http://127.0.0.1:"));
		if (page) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	assert(page, "main application window must load");
	page.on("pageerror", (e) => console.error("renderer", e));
	page.on("console", (m) => { if (m.type() === "error") console.error(m.text()); });
	try { await page.waitForSelector("textarea"); } catch (error) { console.error(page.url(), await page.locator("body").innerText()); throw error; }
	await page.locator(".setup-modal .modal-close").waitFor();
	await page.locator(".setup-modal .modal-close").click();
	await page.getByRole("tab").nth(1).click();
	await page.waitForSelector(".xterm-screen");
	for (let n = 0; n < 5; n++) {
		await page.getByRole("tab").nth(2).click();
		await page.waitForSelector(".scm-view");
		await page.getByRole("tab").nth(0).click();
		await page.getByRole("tab").nth(1).click();
	}
	assert.equal(await page.locator(".xterm-screen").count(), 1);
	console.log("PASS Electron: native shell starts, Chat/Git/terminal switch, one retained terminal");
} finally { await app?.close(); }
