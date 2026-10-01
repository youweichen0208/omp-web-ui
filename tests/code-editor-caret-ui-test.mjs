/** A pointer on a painted code line must place the native textarea caret on that line. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";

const port = 8995;
const cwd = mkdtempSync(join(tmpdir(), "code-editor-caret-"));
const lines = [
	"<!doctype html>", "<html>", "<head>", "<meta charset=\"utf-8\">", "<title>Test</title>",
	"<link rel=\"stylesheet\" href=\"../web/src/styles.css\">", "<style>",
	"  body { margin: 0; background: var(--bg); }", "  /* A comment above the selected line */",
	"  .bg-text {ddx", "    padding: 24px 10%;", "    color: var(--text-faint);", "  }", "</style>", "</head>", "</html>",
];
writeFileSync(join(cwd, "caret.html"), lines.join("\n"));
let server, browser;
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(cwd, "data"), PI_CODING_AGENT_DIR: join(cwd, "agent") }, stdio: "ignore" });
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	assert(await portUp(port));
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
	await page.goto(`http://localhost:${port}`);
	const setupClose = page.locator(".setup-modal .modal-close");
	await setupClose.waitFor();
	await setupClose.click();
	await page.locator(".file-name", { hasText: "caret.html" }).click();
	await page.locator(".fp-edit-line[data-line='10']").waitFor();
	await page.locator(".fp-code-editor").evaluate((node) => node.style.setProperty("--fp-zoom", "1.5"));
	assert.equal(await page.locator(".fp-editor").evaluate((node) => getComputedStyle(node).whiteSpace), "pre");
	const line10 = await page.locator(".fp-edit-line[data-line='10'] .fp-edit-text").boundingBox();
	await page.mouse.click(line10.x + 50, line10.y + line10.height / 2);
	const caretLine = await page.locator(".fp-editor").evaluate((node) => node.value.slice(0, node.selectionStart).split("\n").length);
	assert.equal(caretLine, 10, `clicking painted line 10 placed caret on line ${caretLine}`);
	await page.locator(".fp-code-editor").evaluate((node) => { node.classList.remove("no-wrap"); node.querySelector("textarea").wrap = "soft"; });
	const wrappedLine10 = await page.locator(".fp-edit-line[data-line='10'] .fp-edit-text").boundingBox();
	await page.mouse.click(wrappedLine10.x + 50, wrappedLine10.y + wrappedLine10.height / 2);
	const wrappedCaretLine = await page.locator(".fp-editor").evaluate((node) => node.value.slice(0, node.selectionStart).split("\n").length);
	assert.equal(wrappedCaretLine, 10, `clicking wrapped painted line 10 placed caret on line ${wrappedCaretLine}`);
	console.log("PASS code editor: painted line 10 and textarea caret stay aligned after zoom");
} finally {
	await browser?.close();
	server?.kill("SIGTERM");
}
