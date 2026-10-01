/** Save-on-send (layer 2): submitting a message that carries the current file
 *  flushes the dirty editor draft to disk first; a version conflict blocks the
 *  send via the existing conflict UI. Real browser, intercepted WS. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";

const base = mkdtempSync(join(tmpdir(), "save-on-send-"));
const cwd = join(base, "workspace");
mkdirSync(cwd);
writeFileSync(join(cwd, "code.ts"), "const disk = 1;\n");
const env = { ...process.env, PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: join(base, "agent") };
const PORT = 8997;
let server, browser;
try {
	assert.equal(await portUp(PORT), false, "isolated port must be free");
	server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...env, PORT: String(PORT) }, stdio: "ignore" });
	for (let i = 0; i < 100 && !await portUp(PORT); i++) await sleep(100);
	assert(await portUp(PORT));
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	const order = [];
	const prompts = [];
	let lastWriteVersion = null;
	await page.routeWebSocket("**/ws", (route) => {
		const upstream = route.connectToServer();
		route.onMessage((wire) => {
			const message = JSON.parse(wire.toString());
			if (message.type === "prompt") {
				order.push("prompt");
				prompts.push(message);
				route.send(JSON.stringify({ type: "prompt_result", requestId: message.requestId, ok: true }));
			} else if (message.type === "write_file") {
				order.push("write");
				upstream.send(wire);
			} else upstream.send(wire);
		});
		upstream.onMessage((wire) => {
			const message = JSON.parse(wire.toString());
			if (message.type === "file_result" && message.operation === "write" && message.ok) lastWriteVersion = message.version;
			route.send(wire);
		});
	});
	await page.goto(`http://localhost:${PORT}`);
	await page.locator(".setup-modal .modal-close").click();
	await page.locator(".file-name", { hasText: "code.ts" }).click();
	await page.locator(".fp-editor").waitFor();
	const editor = page.locator(".fp-editor");
	const input = page.locator(".inputbox textarea");
	const submit = async (text) => { await input.fill(text); await input.press("Enter"); };
	const sent = () => page.waitForFunction(() => document.querySelector(".inputbox textarea")?.value === "");

	// [1] Clean draft: the prompt goes out immediately, no write.
	await submit("clean question");
	await sent();
	assert.equal(order.filter((s) => s === "write").length, 0, "clean draft must not trigger a write");
	assert.equal(prompts.length, 1);
	assert.equal(prompts[0].attachments[0].editorSnapshot.dirty, false);

	// [2] Dirty draft: flush to disk first, then send the fresh snapshot.
	await editor.fill("const saved = 2;\n");
	await submit("dirty question");
	await sent();
	assert.equal(order.filter((s) => s === "write").length, 1, "dirty draft must be flushed before the prompt");
	assert.equal(order.indexOf("write") < order.lastIndexOf("prompt"), true, "write must precede the prompt");
	assert.equal(readFileSync(join(cwd, "code.ts"), "utf8"), "const saved = 2;\n", "draft must be on disk");
	const snapshot = prompts[1].attachments[0].editorSnapshot;
	assert.equal(snapshot.text, "const saved = 2;\n");
	assert.equal(snapshot.dirty, false, "snapshot must reflect the saved state");
	assert.equal(snapshot.version, lastWriteVersion, "snapshot must carry the post-save version");

	// [3] External disk change + dirty draft: conflict blocks the send.
	await editor.fill("const conflicted = 3;\n");
	writeFileSync(join(cwd, "code.ts"), "const external = 9;\n");
	await submit("blocked question");
	await sleep(500);
	assert.equal(prompts.length, 2, "conflict must block the prompt");
	assert.equal(await input.inputValue(), "blocked question", "input keeps the unsent text");
	assert.equal(readFileSync(join(cwd, "code.ts"), "utf8"), "const external = 9;\n", "conflict must not overwrite disk");
	await page.locator(".fp-notice").waitFor();
	assert.equal(await page.getByRole("button", { name: "覆盖磁盘文件", exact: true }).isVisible(), true, "conflict UI offers overwrite");

	console.log("PASS save-on-send: flush before send, snapshot matches disk, conflict blocks via existing UI");
} finally {
	await browser?.close();
	server?.kill("SIGTERM");
}
