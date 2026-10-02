import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
const directory = mkdtempSync(join(tmpdir(), "pi-code-browser-"));
const port = 32000 + Math.floor(Math.random() * 10000);
const server = spawn(process.execPath, ["dist/server/index.js"], {
	env: {
		...process.env,
		PORT: String(port),
		PI_WEB_CWD: directory,
		PI_WEB_DATA_DIR: directory,
		PI_CODING_AGENT_DIR: join(directory, "agent"),
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let logs = "",
	browser;
server.stdout.on("data", (data) => (logs += data));
server.stderr.on("data", (data) => (logs += data));
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		try {
			const health = await (
				await fetch(`http://127.0.0.1:${port}/api/health`)
			).json();
			assert.equal(health.pid, server.pid);
			ready = true;
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	assert(ready, logs);
	browser = await chromium.launch({
		executablePath: CHROME_PATH || chromium.executablePath(),
	});
	for (const language of ["zh", "en"])
		for (const { width, platform } of [
			{ width: 1280, platform: "web" },
			{ width: 900, platform: "web" },
			{ width: 900, platform: "darwin" },
			{ width: 900, platform: "win32" },
		]) {
			const page = await browser.newPage({ viewport: { width, height: 800 } }),
				errors = [];
			let latestCodeState, latestCodeCwd, activeJavaStatus;
			page.on("pageerror", (error) => errors.push(String(error)));
			await page.addInitScript(
				(language) => localStorage.setItem("pi-web-ui:lang", language),
				language,
			);
			await page.addInitScript((platform) => {
				if (platform !== "web")
					window.electronAPI = {
						platform,
						windowAction() {},
						onWindowState(callback) {
							callback({ maximized: false, fullscreen: false });
							return () => {};
						},
					};
			}, platform);
			await page.routeWebSocket("**/ws", (route) => {
				const upstream = route.connectToServer();
				route.onMessage((wire) => upstream.send(wire));
				upstream.onMessage((wire) => {
					const msg = JSON.parse(wire.toString());
					if (msg.type === "snapshot") msg.state.piConfigured = true;
					if (msg.type === "code_result" && msg.state) {
						msg.state.services = [
							{
								language: "rust",
								status: "ready",
								rssMiB: 2048,
								restarts: 0,
								heapMiB: 0,
								checkedFiles: 1,
								pendingFiles: 0,
								unconfirmedFiles: 0,
							},
						];
						if (activeJavaStatus)
							msg.state.services.push({
								language: "java",
								status: activeJavaStatus,
								rssMiB: 123,
								restarts: 0,
								heapMiB: 1024,
								checkedFiles: 0,
								pendingFiles: 1,
								unconfirmedFiles: 0,
								error:
									activeJavaStatus === "failed"
										? "fixture Java startup failure"
										: undefined,
							});
						msg.state.diagnostics = [
							{
								path: "lib.rs",
								line: 1,
								column: 1,
								endLine: 1,
								severity: 3,
								message: "proc macro not expanded",
								code: "unresolved-proc-macro",
								analysisLimitation: true,
								freshness: "fresh",
							},
						];
					}
					if (msg.type === "code_result" && msg.state) {
						latestCodeState = msg.state;
						latestCodeCwd = msg.cwd;
					}
					route.send(JSON.stringify(msg));
				});
			});
			await page.goto(`http://127.0.0.1:${port}`);
			await page
				.locator("#sidebar-settings-slot button:visible")
				.first()
				.click();
			const all = page.locator(".workspace-settings-menu .dd-item").first();
			if (await all.isVisible()) await all.click();
			await page
				.getByRole("button", {
					name: language === "zh" ? "代码智能" : "Code intelligence",
					exact: true,
				})
				.click();
			await page.locator(".code-settings").waitFor();
			for (const name of language === "zh"
				? ["Maven 用户 settings.xml", "Maven 全局 settings.xml"]
				: ["Maven user settings.xml", "Maven global settings.xml"]) {
				await page.getByLabel(name, { exact: true }).waitFor();
			}
			assert(
				(await page.locator(".code-panel").textContent()).includes(
					language === "zh"
						? "Rust 诊断为部分覆盖"
						: "Rust diagnostics have partial coverage",
				),
			);
			assert(
				(
					await page.locator(".code-panel [role=status]").textContent()
				).includes(language === "zh" ? "内存占用较高" : "High memory usage"),
			);
			assert(
				(await page.locator(".code-problem").first().textContent()).includes(
					language === "zh" ? "分析限制" : "Analysis limitation",
				),
			);
			assert.equal(
				await page.locator(".code-settings input[type=checkbox]").count(),
				8,
			);
			assert.equal(
				await page
					.locator(".code-settings input[type=checkbox]")
					.nth(3)
					.isChecked(),
				false,
			);
			await page.locator(".code-panel input[aria-label]").fill("missing");
			await page
				.locator(".code-settings input[type=number]")
				.first()
				.fill("3072");
			await page
				.getByRole("button", {
					name: language === "zh" ? "保存" : "Save",
					exact: true,
				})
				.click();
			await page.waitForTimeout(200);
			assert.deepEqual(errors, []);
			assert(
				await page
					.locator(".code-panel")
					.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
			);
			console.log(
				`PASS ${language} ${platform} ${width}px: code settings, default-off feedback, filter and heap save`,
			);
			await page.locator(".settings-modal .modal-close").click();
			const indicator = page.getByRole("button", {
				name: language === "zh" ? "语言服务状态" : "Language service status",
				exact: true,
			});
			await indicator.click();
			await page.locator(".code-status-popup").waitFor();
			assert.equal(
				await page.locator(".code-status-popup .code-service-card").count(),
				6,
			);
			for (const [status, label] of language === "zh"
				? [
						["initializing", "初始化"],
						["missing", "缺少本机工具链"],
						["failed", "失败"],
						["untrusted", "项目未信任"],
						["ready", "已连接"],
					]
				: [
						["initializing", "Initializing"],
						["missing", "Local toolchain missing"],
						["failed", "Failed"],
						["untrusted", "Project untrusted"],
						["ready", "Connected"],
					]) {
				activeJavaStatus = status;
				const value = structuredClone(latestCodeState);
				value.services = value.services.filter(
					(service) => service.language !== "java",
				);
				value.services.push({
					language: "java",
					status,
					rssMiB: 123,
					restarts: 0,
					heapMiB: 1024,
					checkedFiles: 0,
					pendingFiles: 1,
					unconfirmedFiles: 0,
					error:
						status === "failed" ? "fixture Java startup failure" : undefined,
				});
				await page.evaluate(
					({ state, cwd }) =>
						window.dispatchEvent(
							new CustomEvent("pi-code-event", {
								detail: { type: "code_state", cwd, state },
							}),
						),
					{ state: value, cwd: latestCodeCwd },
				);
				await page
					.locator(".code-status-popup .code-service-card")
					.filter({ hasText: "Java · Maven" })
					.getByText(label, { exact: true })
					.waitFor();
				if (status === "failed") {
					await page
						.locator(".code-status-popup .code-service-card")
						.filter({ hasText: "Java · Maven" })
						.locator("summary")
						.click();
					await page
						.getByText("fixture Java startup failure", { exact: true })
						.waitFor();
				}
			}
			assert(
				await page.locator(".code-status-popup").evaluate((el) => {
					const rect = el.getBoundingClientRect();
					return (
						rect.left >= 0 &&
						rect.right <= window.innerWidth &&
						rect.top >= 0 &&
						rect.bottom <= window.innerHeight &&
						el.scrollWidth <= el.clientWidth + 1
					);
				}),
			);
			const before = await indicator.textContent();
			await page.evaluate(
				({ state }) =>
					window.dispatchEvent(
						new CustomEvent("pi-code-event", {
							detail: { type: "code_state", cwd: "/another-project", state },
						}),
					),
				{ state: latestCodeState },
			);
			assert.equal(await indicator.textContent(), before);
			await page.keyboard.press("Escape");
			await page.locator(".code-status-popup").waitFor({ state: "detached" });
			await indicator.click();
			await page
				.getByRole("button", {
					name:
						language === "zh"
							? "打开代码智能设置"
							: "Open Code Intelligence settings",
					exact: true,
				})
				.click();
			await page.locator(".code-settings").waitFor();
			assert.deepEqual(errors, []);
			console.log(
				`PASS ${language} ${platform} ${width}px: LSP statuses, failure reason, project isolation, Escape and direct settings entry`,
			);
			await page.close();
		}
} finally {
	await browser?.close();
	server.kill();
	await new Promise((r) =>
		server.exitCode !== null ? r() : server.once("exit", r),
	);
	rmSync(directory, { recursive: true, force: true });
}
