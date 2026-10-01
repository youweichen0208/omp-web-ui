/**
 * pi-web-ui Electron 桌面版主进程。
 *
 * 架构：
 *   - 主进程 fork 一个隐藏子进程跑 server（ELECTRON_RUN_AS_NODE=1），
 *     server 使用 Electron 内置的 Node 运行时，node-pty 等原生模块
 *     在 electron-builder 打包时自动 rebuild 为 Electron ABI。
 *   - BrowserWindow 加载 http://127.0.0.1:{PORT}（server 就绪后）。
 *   - 托盘：关闭窗口 → 最小化到托盘；Quit → 真正退出（杀 server 子进程）。
 *   - 自动更新：electron-updater + GitHub Releases（当前未接发布 CI，
 *     autoUpdater.checkForUpdates() 在没有可用 feed 时会静默失败，不影响使用）。
 *
 * 开发模式（npm run dev:electron）：
 *   先构建 web + server（npm run build），然后 electron . 即可。
 *   如有 Vite dev server (:5173)，优先加载它获取 HMR。
 *
 * 与当前 server/index.ts 的耦合点（重构时请对照检查）：
 *   - 就绪标记：server 启动后 stdout 打印 "⚡ pi-web-ui"（见 server/index.ts
 *     httpServer.listen 回调），本文件靠这行判断 server 已就绪。
 *   - PI_WEB_PKG_ROOT：告诉 server 去哪找 web/dist（resolvePkgRoot()），
 *     打包后指向 process.resourcesPath（electron-builder extraResources）。
 *   - PI_WEB_DATA_DIR：桌面版单独用 <home>/.pi-web-desktop，与命令行版
 *     的 <home>/.pi-web 分开，避免两边同时跑互相抢 client-state.json /
 *     terminals 等运行时状态（数据都在 SDK 的 ~/.pi/agent 里，两边共享，
 *     不受影响）。
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, Notification, ipcMain } from "electron";
import { fork } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// electron-updater 是 CJS 包，Node ESM 下不能直接 named import，
// 得走默认导出再解构（Node 的 CJS→ESM 互操作不会自动分析 named exports）。
import electronUpdaterPkg from "electron-updater";
const { autoUpdater } = electronUpdaterPkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const isDev = !app.isPackaged || !!process.env.DEV;

// ── 状态 ──
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
/** @type {import("node:child_process").ChildProcess | null} */
let serverProcess = null;
let isQuitting = false;
let serverPort = 0;

// ── 路径 ──

// asar 关掉之后（见 electron-builder.yml 里的长注释），打包后的目录结构跟开发
// 时是同构的：__dirname 是 <app>/electron，ROOT 就是 <app>——开发时是仓库根，
// 打包后是 Resources/app。dist / web/dist / extensions / node_modules 全都平铺
// 在 ROOT 下面，所以这两个函数不再需要分打包和开发两种情况。

/** server 入口：<root>/dist/server/index.js */
function getServerPath() {
	return join(ROOT, "dist", "server", "index.js");
}

/** server 找 web/dist、extensions 的根目录 */
function getPkgRoot() {
	return ROOT;
}

// ── 端口 ──

/** 找一个随机空闲端口（防止端口冲突） */
async function findFreePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = /** @type {import("node:net").AddressInfo} */ (srv.address()).port;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

// ── 启动 Server 子进程 ──

async function startServer(reusePort) {
	serverPort = reusePort || await findFreePort();
	const serverPath = getServerPath();

	if (!existsSync(serverPath)) {
		dialog.showErrorBox(
			"pi 启动失败",
			`找不到 server 入口：${serverPath}\n\n请先执行 npm run build，然后重试。`,
		);
		app.quit();
		return;
	}

	// 桌面版数据目录与命令行版分开（见文件头注释），确保存在
	const dataDir = process.env.PI_WEB_DATA_DIR || join(
		process.env.HOME || process.env.USERPROFILE || "~",
		".pi-web-desktop",
	);
	mkdirSync(dataDir, { recursive: true });

	serverProcess = fork(serverPath, [], {
		env: {
			...process.env,
			PORT: String(serverPort),
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_NO_BROWSER: "1", // 不要自动打开浏览器（本身也不会打开，桌面版有自己的窗口）
			PI_WEB_PKG_ROOT: getPkgRoot(), // 告诉 server 去哪找 web/dist / extensions
			ELECTRON_RUN_AS_NODE: "1", // 以 Node.js 模式运行（非 Electron）
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		serialization: "json",
	});

	// 收集 stdout/stderr 用于调试
	let serverOut = "";
	serverProcess.stdout?.on("data", (chunk) => {
		const text = chunk.toString();
		serverOut += text;
		process.stdout.write(`[server] ${text}`);
	});
	serverProcess.stderr?.on("data", (chunk) => {
		const text = chunk.toString();
		serverOut += text;
		process.stderr.write(`[server:err] ${text}`);
	});

	// 等待 server 就绪：监听 stdout 中的 "⚡ pi-web-ui" 标记（见 server/index.ts）
	await new Promise((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(() => {
			rejectPromise(
				new Error(`Server 启动超时（30s）。最后输出：\n${serverOut.slice(-500)}`),
			);
		}, 30_000);

		const checkOutput = (chunk) => {
			const text = chunk.toString();
			if (text.includes("⚡ pi-web-ui") || text.includes("http://localhost")) {
				clearTimeout(timeout);
				resolvePromise(undefined);
			}
		};

		serverProcess.stdout?.on("data", checkOutput);
		serverProcess.on("error", (err) => {
			clearTimeout(timeout);
			rejectPromise(err);
		});
		serverProcess.on("exit", (code) => {
			clearTimeout(timeout);
			if (code !== 0) {
				// 把 server 自己最后的输出带上。只报一个 exit code=1 的话，用户在
				// 弹窗里看到的就只有「启动失败」四个字，真正的原因（模块缺失、
				// 端口被占、配置读不了）全留在没人看得到的 stdout 里——超时那条
				// 分支早就是这么做的，退出这条漏了。
				const tail = serverOut.trim().slice(-800);
				rejectPromise(
					new Error(
						`Server 退出了 (exit code=${code})` +
							(tail ? `\n\n最后输出：\n${tail}` : ""),
					),
				);
			}
		});
	});

	console.log(`[electron] server 就绪，端口 ${serverPort}`);
}

/** Keep the window's URL stable so its WebSocket can reconnect after a crash. */
function watchServerExit() {
	const child = serverProcess;
	child?.once("exit", () => {
		if (isQuitting || serverProcess !== child) return;
		serverProcess = null;
		void recoverServer();
	});
}

async function recoverServer() {
	const port = serverPort;
	let lastError;
	for (const delay of [1000, 2000, 4000]) {
		await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
		if (isQuitting) return;
		try {
			await startServer(port);
			watchServerExit();
			return;
		} catch (error) {
			lastError = error;
			// A failed startup can leave a child alive until its own timeout fires.
			serverProcess?.kill("SIGTERM");
			serverProcess = null;
		}
	}
	if (!isQuitting) dialog.showErrorBox(
		"pi 服务已断开",
		`服务重启失败，请重新打开应用。\n\n${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

// ── 窗口 ──

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		title: "pi",
		backgroundColor: "#ffffff",
		show: false,
		...(process.platform === "darwin"
			? { titleBarStyle: "hidden", trafficLightPosition: { x: 18, y: 17 } }
			: { frame: false }),
		webPreferences: {
			preload: join(__dirname, "preload.cjs"),
			nodeIntegration: false,
			contextIsolation: true,
		},
		icon: join(__dirname, "icon.png"),
	});

	const publishWindowState = () => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("pi-window-state", {
				maximized: mainWindow.isMaximized(),
				fullscreen: mainWindow.isFullScreen(),
			});
		}
	};
	for (const event of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "restore"]) {
		mainWindow.on(event, publishWindowState);
	}
	mainWindow.webContents.on("did-finish-load", publishWindowState);
	mainWindow.webContents.on("will-prevent-unload", (event) => {
		const zh = app.getLocale().startsWith("zh");
		const choice = dialog.showMessageBoxSync(mainWindow, {
			type: "warning",
			message: zh ? "文件有未保存的修改，确定放弃并离开？" : "Discard unsaved file changes and leave?",
			buttons: zh ? ["取消", "放弃修改"] : ["Cancel", "Discard changes"],
			defaultId: 0,
			cancelId: 0,
		});
		// Electron allows unloading only when this event is prevented.
		if (choice === 1) event.preventDefault();
		else isQuitting = false;
	});

	// 加载 localhost 上的 server
	const url = `http://127.0.0.1:${serverPort}`;
	mainWindow.loadURL(url);

	mainWindow.once("ready-to-show", () => {
		mainWindow.show();
	});

	// 关闭窗口 → 隐藏到托盘（不退出）
	mainWindow.on("close", (event) => {
		if (!isQuitting) {
			event.preventDefault();
			mainWindow.hide();
			return false;
		}
	});

	mainWindow.on("closed", () => {
		mainWindow = null;
	});

	// 开发模式打开 DevTools
	if (isDev) {
		mainWindow.webContents.openDevTools({ mode: "detach" });
	}
}

// Only the app's main webContents may control its own window. The renderer
// receives fixed operations, never an arbitrary Electron method or channel.
ipcMain.handle("pi-window-action", (event, action) => {
	const win = mainWindow;
	if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
	switch (action) {
		case "minimize": win.minimize(); break;
		case "toggle-maximize":
			if (win.isFullScreen()) win.setFullScreen(false);
			else if (win.isMaximized()) win.unmaximize();
			else win.maximize();
			break;
		case "close": win.close(); break;
	}
});
ipcMain.handle("pi-window-state-read", (event) => {
	const win = mainWindow;
	if (!win || win.isDestroyed() || event.sender !== win.webContents) return null;
	return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
});

// ── 托盘 ──

function createTray() {
	const iconPath = join(__dirname, "icon.png");
	const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
	tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
	tray.setToolTip("pi");

	const contextMenu = Menu.buildFromTemplate([
		{
			label: "显示窗口",
			click: () => {
				if (mainWindow) {
					mainWindow.show();
					mainWindow.focus();
				}
			},
		},
		{ type: "separator" },
		{
			label: "关于 pi",
			click: () => {
				dialog.showMessageBox({
					type: "info",
					title: "关于 pi",
					message: `pi v${app.getVersion()}`,
					detail: "Web chat interface for the pi coding agent.",
				});
			},
		},
		{ type: "separator" },
		{
			label: "退出",
			click: () => {
				isQuitting = true;
				app.quit();
			},
		},
	]);

	tray.setContextMenu(contextMenu);

	// 点击托盘图标 → 显示/隐藏窗口
	tray.on("click", () => {
		if (mainWindow) {
			if (mainWindow.isVisible()) {
				mainWindow.hide();
			} else {
				mainWindow.show();
				mainWindow.focus();
			}
		}
	});
}

// ── 菜单 ──

function createAppMenu() {
	const template = [
		{
			label: "pi",
			submenu: [
				{
					label: "关于 pi",
					click: () => {
						dialog.showMessageBox({
							type: "info",
							title: "关于 pi",
							message: `pi v${app.getVersion()}`,
							detail: "Web chat interface for the pi coding agent.",
						});
					},
				},
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{
					label: "退出",
					accelerator: "CmdOrCtrl+Q",
					click: () => {
						isQuitting = true;
						app.quit();
					},
				},
			],
		},
		{
			label: "编辑",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "视图",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "窗口",
			submenu: [{ role: "minimize" }, { role: "close" }],
		},
	];

	// macOS 需要第一个菜单项是应用名
	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

// ── 自动更新 ──

function setupAutoUpdater() {
	if (isDev) return; // 开发模式不检查更新

	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;

	// 检查更新（启动后延迟 5s）。当前未配置发布 CI / publish feed，
	// 找不到更新源时会静默失败，不影响正常使用。
	setTimeout(() => {
		autoUpdater.checkForUpdates().catch(() => {
			// 静默失败（无网络 / 无 feed / 超时等）
		});
	}, 5000);

	autoUpdater.on("update-available", (info) => {
		const notification = new Notification({
			title: "pi 更新可用",
			body: `版本 ${info.version} 可下载（当前 ${app.getVersion()}）`,
		});
		notification.on("click", () => {
			autoUpdater.downloadUpdate();
		});
		notification.show();
	});

	autoUpdater.on("update-downloaded", () => {
		const result = dialog.showMessageBoxSync({
			type: "info",
			title: "更新已下载",
			message: "新版本已下载完成，是否立即重启以安装更新？",
			buttons: ["立即重启", "稍后"],
		});
		if (result === 0) {
			autoUpdater.quitAndInstall();
		}
	});
}

// ── 应用生命周期 ──

app.setAppUserModelId("com.youweichen.pi-web-ui");

// 确保只有一个实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.show();
			mainWindow.focus();
		}
	});
}

app.whenReady().then(async () => {
	try {
		await startServer();
		watchServerExit();
	} catch (err) {
		dialog.showErrorBox("pi 启动失败", err instanceof Error ? err.message : String(err));
		app.quit();
		return;
	}

	createAppMenu();
	createWindow();
	createTray();
	setupAutoUpdater();

	app.on("activate", () => {
		if (!mainWindow) createWindow();
		if (mainWindow) {
			mainWindow.show();
			mainWindow.focus();
		}
	});
});

app.on("window-all-closed", () => {
	// macOS 不退出（dock 图标还在）
	// 其他平台退出
	if (process.platform !== "darwin") {
		isQuitting = true;
		app.quit();
	}
});

app.on("before-quit", () => {
	isQuitting = true;
});

app.on("will-quit", () => {
	// 杀 server 子进程
	if (serverProcess) {
		try {
			serverProcess.kill("SIGTERM");
		} catch {
			// 可能已经退出
		}
		serverProcess = null;
	}
	if (tray) {
		tray.destroy();
		tray = null;
	}
});
