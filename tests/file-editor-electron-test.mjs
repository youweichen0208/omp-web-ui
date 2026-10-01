// Real Electron shell with an isolated workspace, data directory and SDK config.
import { _electron as electron } from "playwright-core";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const base = mkdtempSync(join(tmpdir(), "pi-file-electron-"));
const workspace = join(base, "workspace");
mkdirSync(workspace);
writeFileSync(join(workspace, "note.md"), "# Electron");
let app;
try {
	app = await electron.launch({ args: [".", `--user-data-dir=${join(base, "profile")}`], env: { ...process.env, PI_WEB_DATA_DIR: join(base, "data"), PI_WEB_CWD: workspace, PI_CODING_AGENT_DIR: join(base, "agent") } });
	let page;
	for (let n = 0; n < 200; n++) {
		page = app.windows().find((w) => w.url().startsWith("http://127.0.0.1:"));
		if (page) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	assert(page);
	page.on("dialog", () => {});
	await page.locator(".setup-modal .modal-close").click();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
	await page.waitForFunction(() => innerWidth >= 1600);
	assert.equal(Math.round((await page.locator(".panel-left").boundingBox()).width), 264);
	assert.equal(Math.round((await page.locator(".panel-right").boundingBox()).width), 272);
	assert.equal(Math.round((await page.locator(".topbar").boundingBox()).height), 52);
	assert(await page.locator(".input-tools .thinking-segments").isVisible());
	assert((await page.locator("body").evaluate((node) => getComputedStyle(node).fontFamily)).includes("IBM Plex Sans"));
	await page.screenshot({ path: "/private/tmp/pi-workspace-desktop.png" });
	await page.locator(".file-name", { hasText: "note.md" }).click();
	await page.locator(".fp-markdown").waitFor();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 760));
	await page.waitForFunction(() => innerWidth <= 900);
	assert(await page.locator('.view-switch button[role="tab"] > svg').first().isVisible());
	assert.equal(await page.locator('.drawer-left').isVisible(), false);
	const chatWidth = (await page.locator('.view-pane:not(.hidden) .main').boundingBox()).width;
	const documentWidth = (await page.locator('.drawer-right').boundingBox()).width;
	assert(Math.abs(documentWidth / (chatWidth + documentWidth) - .45) < .002);
	assert.equal(await page.getByRole('toolbar', { name: '文档格式' }).count(), 1);
	await page.waitForTimeout(300);
	const emptyWidth = (await page.locator('.empty-examples').boundingBox()).width;
	assert(emptyWidth <= chatWidth);
	await page.screenshot({ path: '/private/tmp/pi-document-desktop.png' });
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
	await page.waitForFunction(() => innerWidth >= 1200);

	await page.getByRole("button", { name: "源码", exact: true }).click();
	await page.locator(".fp-editor").fill("# Native draft");
	await page.getByRole("tab").nth(2).click();
	await page.getByRole("tab").nth(0).click();
	assert.equal(await page.locator(".fp-editor").inputValue(), "# Native draft");
	await page.locator(".fp-editor").focus();
	await page.keyboard.press("Meta+s");
	await page.waitForFunction(() => document.querySelector(".fp-header-status")?.textContent?.includes("已保存"));
	assert.equal(readFileSync(join(workspace, "note.md"), "utf8"), "# Native draft");
	await page.locator(".fp-editor").fill("unsaved");
	// Exercise the native unload confirmation without requiring human input.
	await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; });
	await page.reload({ timeout: 1500 }).catch(() => {});
	assert.equal(await page.locator(".fp-editor").inputValue(), "unsaved");
	await page.getByRole("button", { name: "返回文件列表", exact: true }).click();
	await page.getByRole("button", { name: "放弃修改", exact: true }).click();
	console.log("PASS Electron: inline editing, retained draft, native save, cancelled unload");
} finally { await app?.close(); }
