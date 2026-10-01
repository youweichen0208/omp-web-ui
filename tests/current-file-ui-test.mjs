/** Current-file chip + editor snapshot (0.50.0 semantics) in a real browser
 *  (or Electron with --electron): the chip strictly mirrors the preview panel,
 *  every message carries a fresh snapshot of the editor draft, and opening
 *  another file replaces — never accumulates — the chip. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, _electron as electron } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";

const base = mkdtempSync(join(tmpdir(), "current-file-ui-"));
const cwd = join(base, "workspace");
mkdirSync(cwd);
writeFileSync(join(cwd, "code.ts"), "const disk = 1;\n");
writeFileSync(join(cwd, "note.md"), "# Note\n\nSelected paragraph.\n");
writeFileSync(join(cwd, "large.txt"), "a".repeat(512 * 1024 + 1));
const env = { ...process.env, PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: join(base, "agent") };
let server, browser, app;
try {
	let page;
	if (process.argv.includes("--electron")) {
		app = await electron.launch({ args: [".", `--user-data-dir=${join(base, "profile")}`], env });
		for (let i = 0; i < 200; i++) { page = app.windows().find((window) => window.url().startsWith("http://127.0.0.1:")); if (page) break; await sleep(100); }
		assert(page);
	} else {
		assert.equal(await portUp(8993), false);
		server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...env, PORT: "8993" }, stdio: "ignore" });
		for (let i = 0; i < 100 && !await portUp(8993); i++) await sleep(100);
		assert(await portUp(8993));
		browser = await chromium.launch({ executablePath: CHROME_PATH });
		page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	}
	const prompts = [];
	await page.routeWebSocket("**/ws", (route) => {
		const upstream = route.connectToServer();
		route.onMessage((wire) => {
			const message = JSON.parse(wire.toString());
			if (message.type === "prompt") {
				prompts.push(message);
				route.send(JSON.stringify({ type: "prompt_result", requestId: message.requestId, ok: true }));
			} else upstream.send(wire);
		});
	});
	await page.goto(app ? page.url() : "http://127.0.0.1:8993");
	await page.locator(".setup-modal .modal-close").click();
	const chip = page.locator(".attach-chip.current-file");
	const input = page.locator(".inputbox textarea");
	const submit = async (text) => { await input.fill(text); await input.press("Enter"); };
	const sent = () => page.waitForFunction(() => document.querySelector(".inputbox textarea")?.value === "");

	// [1] Opening a file shows exactly one chip mirroring it.
	await page.locator(".file-name", { hasText: "code.ts" }).click();
	await page.locator(".fp-editor").waitFor();
	await chip.waitFor();
	assert((await chip.textContent()).includes("@code.ts"));

	// [2] Unsaved edits mark the chip; send-on-send flushes the draft first,
	// so the snapshot matches the disk (dirty=false) and carries the draft.
	await page.locator(".fp-editor").fill("const draft = '最后一次输入';\n");
	assert((await chip.textContent()).includes("未保存"), "chip should show the unsaved marker");
	await submit("first question");
	await sent();
	assert.equal(prompts[0].attachments.length, 1);
	assert.equal(prompts[0].attachments[0].mode, "inline");
	assert.equal(prompts[0].attachments[0].editorSnapshot.text, "const draft = '最后一次输入';\n");
	assert.equal(prompts[0].attachments[0].editorSnapshot.dirty, false, "save-on-send: draft is flushed before the prompt");
	assert.equal(readFileSync(join(cwd, "code.ts"), "utf8"), "const draft = '最后一次输入';\n");

	// [3] Each message takes a fresh snapshot; earlier messages stay frozen.
	await page.locator(".fp-editor").fill("second draft");
	await submit("second question");
	await sent();
	assert.equal(prompts[1].attachments[0].editorSnapshot.text, "second draft");
	assert.equal(prompts[0].attachments[0].editorSnapshot.text, "const draft = '最后一次输入';\n");

	// [4] A manual same-path reference is superseded by the snapshot.
	await page.locator(".fp-reference").click();
	await submit("reference question");
	await sent();
	const merged = prompts.at(-1).attachments;
	assert.equal(merged.filter((a) => a.mode === "reference").length, 0, "same-path reference must be superseded");
	assert.equal(merged.length, 1);
	assert.equal(merged[0].editorSnapshot.text, "second draft");

	// [5] Dismissing the chip stops the auto attachment while the file stays open.
	await chip.locator("button").click();
	assert.equal(await chip.count(), 0);
	await page.locator(".fp-editor").fill("third draft");
	await submit("no automatic file");
	await sent();
	assert.equal(prompts.at(-1).attachments.length, 0);

	// [6] Strict mirror: opening another file swaps the chip — no accumulation.
	await page.locator(".fp-back").click();
	await page.locator(".fp-leave").getByRole("button", { name: "放弃修改" }).click();
	await page.locator(".file-name", { hasText: "note.md" }).click();
	await page.locator(".fp-rich-document").waitFor();
	await chip.waitFor();
	assert((await chip.textContent()).includes("@note.md"), "chip follows the newly opened file");
	assert.equal(await chip.count(), 1, "exactly one current-file chip");
	await page.locator(".fp-reference").click();
	await page.locator(".attach-chip.reference").waitFor();
	await page.locator(".fp-back").click();
	await page.locator(".attach-chip.reference").waitFor({ state: "detached" });
	await page.locator(".file-name", { hasText: "code.ts" }).click();
	await page.locator(".fp-editor").waitFor();
	assert.equal(await page.locator(".attach-chip.reference").count(), 0, "old whole-file reference is removed after switching previews");
	await submit("switched file only");
	await sent();
	assert.deepEqual(prompts.at(-1).attachments.map((a) => a.path), ["code.ts"]);
	await page.locator(".fp-back").click();
	await page.locator(".file-name", { hasText: "note.md" }).click();
	await page.locator(".fp-rich-document").waitFor();

	// [7] Quote-selected lines coexist with the snapshot; markdown edits ride along.
	await page.locator(".fp-markdown p").evaluate((node) => {
		const range = document.createRange();
		range.selectNodeContents(node);
		const selected = window.getSelection();
		selected.removeAllRanges();
		selected.addRange(range);
		node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
	});
	await page.locator(".fp-quote-selection").click();
	await page.locator(".attach-chip.lines").waitFor();
	await page.locator(".fp-rich-document").fill("Markdown last input");
	await submit("markdown question");
	await sent();
	const withLines = prompts.at(-1).attachments;
	assert.equal(withLines.find((a) => a.mode === "lines")?.lines.start, 3);
	assert.equal(withLines.find((a) => a.editorSnapshot)?.path, "note.md");
	assert(withLines.find((a) => a.editorSnapshot)?.editorSnapshot.text.includes("Markdown last input"));
	assert(readFileSync(join(cwd, "note.md"), "utf8").includes("Markdown last input"), "save-on-send flushed the markdown draft");

	// [8] An oversized draft (>512 KiB) blocks the send; the text stays put.
	// ([7]'s submit already flushed note.md, so closing needs no leave dialog.)
	await page.locator(".fp-back").click();
	await page.locator(".file-name", { hasText: "code.ts" }).click();
	await page.locator(".fp-editor").waitFor();
	await chip.waitFor(); // reopening restores the chip (dismissal was per open)
	await page.locator(".fp-editor").fill("中".repeat(180000));
	const count = prompts.length;
	await submit("oversized question");
	await sleep(100);
	assert.equal(prompts.length, count, "oversized snapshot must block the send");
	assert.equal(await input.inputValue(), "oversized question");

	// [9] A truncated on-disk file (over the server byte cap) gets no chip.
	await page.locator(".fp-back").click();
	await page.locator(".fp-leave").getByRole("button", { name: "放弃修改" }).click();
	await page.locator(".file-name", { hasText: "large.txt" }).click();
	await page.locator(".fp-file-path").waitFor();
	await sleep(200);
	assert.equal(await chip.count(), 0, "truncated files are not current-file eligible");

	console.log("PASS current-file chip: strict mirror, fresh per-message snapshots, same-path supersede, dismissal, size guard, truncated exclusion");
} finally {
	await browser?.close();
	await app?.close();
	server?.kill("SIGTERM");
}
