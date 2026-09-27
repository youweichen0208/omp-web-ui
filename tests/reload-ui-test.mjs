/** Browser acceptance for the inline /reload result and stable composer. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";

const PORT = 8999;
const temp = mkdtempSync(join(tmpdir(), "piweb-reload-ui-"));
const cwd = join(temp, "work");
mkdirSync(cwd);
let server;
let browser;
try {
	assert(CHROME_PATH, "Chrome is required for the browser test");
	assert.equal(await portUp(PORT), false);
	server = spawn(process.execPath, ["dist/server/index.js"], {
		env: { ...process.env, PORT: String(PORT), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(temp, "data"), PI_CODING_AGENT_DIR: join(temp, "agent") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	server.stderr.on("data", (data) => { stderr += data; });
	for (let i = 0; i < 80 && !(await portUp(PORT)); i++) await sleep(250);
	assert(await portUp(PORT), stderr);
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
	await page.goto(`http://127.0.0.1:${PORT}`);
	const setupClose = page.locator(".setup-modal .modal-close");
	if (await setupClose.isVisible()) await setupClose.click();
	const input = page.locator(".inputbox textarea");
	await input.waitFor();
	await page.waitForFunction(() => !document.querySelector(".inputbox textarea")?.disabled);
	assert.equal(await page.locator(".composer-hint").count(), 0);
	await input.focus();
	assert.equal(await page.locator(".composer-hint").count(), 0);
	await input.fill("draft");
	assert.equal(await page.locator(".composer-hint").count(), 0);
	await input.fill("/reload ");
	await input.press("Enter");
	await page.locator(".reload-event-line", { hasText: "已重新加载" }).waitFor({ timeout: 20000 });
	assert.match(await page.locator(".reload-event-line").textContent(), /扩展 \d+ · 技能 \d+ · 提示模板 \d+ · \d+\.\ds/);
	assert.equal(await page.locator(".reload-command code").textContent(), "/reload");
	assert.match(await page.locator(".reload-event").first().getAttribute("title"), /技能：/);
	assert.equal(await page.locator(".notices .notice").count(), 0);
	const extensionsDir = join(temp, "agent", "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(join(extensionsDir, "broken.ts"), "export default function broken( {\n");
	await input.fill("/reload ");
	await input.press("Enter");
	const failed = page.locator(".reload-event.failed").last();
	await failed.waitFor({ timeout: 20000 });
	assert.match(await failed.locator(".reload-event-line").textContent(), /加载出错/);
	if (await setupClose.isVisible()) await setupClose.click();
	await failed.locator(".reload-errors summary").click();
	assert.match(await failed.locator(".reload-errors").textContent(), /broken\.ts/);
	await page.reload();
	await page.locator(".reload-event.failed").waitFor({ timeout: 20000 });
	assert.match(await page.locator(".reload-event.failed .reload-errors").textContent(), /broken\.ts/);
	if (await setupClose.isVisible()) await setupClose.click();
	await page.screenshot({ path: join(temp, "reload-desktop.png") });
	await page.setViewportSize({ width: 390, height: 780 });
	await page.waitForTimeout(350);
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "mobile overflow");
	await page.screenshot({ path: join(temp, "reload-mobile.png") });
	console.log(`PASS inline reload, composer hint, mobile layout; screenshots: ${temp}`);
} finally {
	await browser?.close();
	server?.kill("SIGTERM");
}
