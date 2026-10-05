# 部署

## 内置 Pi 与用户配置

Desktop 使用安装包内精确锁定的 Pi SDK。桌面包不包含应用自己的 `extensions/`，包元数据不声明应用扩展；CLI 的 `/webui` 扩展只随 npm 包提供。用户扩展由原生资源加载器读取 `~/.pi/agent/extensions`、Pi settings.json 声明的本地/已安装扩展包和受信任项目 `.pi/extensions`；`PI_CODING_AGENT_DIR` 可指定其他用户配置目录。沿用原生启停、过滤和项目信任，不复制或删除用户文件。Codemode、tool_search、MCP 属于 Pi 原生能力，继续按原生配置启用。终端执行 `pi update` 更新的是外部 CLI，不会替换桌面内置依赖；内置版本随应用构建升级。用户安装的原生扩展和凭据则由 Desktop 使用的 agent 目录加载，重启或 `/reload` 可加载其变化；不要把“内置版本固定”理解为“用户扩展配置永远无效”。

Pi 1.0 的原生 MCP 配置入口和旧界面 MCP 桥不同，见 [插件文档](architecture-plugins.md)。模型管理提供官方账号登录桥，OpenAI 支持 ChatGPT 授权；真实账号授权由用户在浏览器完成。macOS 产物回归检查 ChatGPT 的 lazy 模块，不能仅凭应用能启动判断 OAuth 功能完整。

## CLI

```bash
pi-web-ui --port 9000 --cwd /path          # 前台
pi-web-ui install <源> [--name --force --data-dir]  # 安装 GitHub 界面插件到 <dataDir>/plugins/
#                                源: owner/repo · https://github.com/o/r[/tree/分支/子目录] · #分支 · 本地目录；刷新浏览器即生效
pi-web-ui plugins / uninstall <id>          # 列出 / 卸载界面插件
pi-web-ui plugins --check-updates          # 逐个对比远端 HEAD，列出可更新插件
pi-web-ui plugins --rollback <id>          # 回滚到最近一份更新前备份（<dataDir>/plugin-backups/）
pi-web-ui server install [--port --cwd --data-dir --name]   # 开机自启：
                                           #   macOS→launchd（无需 sudo）
                                           #   Linux→systemd（自动 sudo）
                                           #   Windows→计划任务（登录自启，隐藏窗口无黑窗）
pi-web-ui server shortcut [--port --cwd --data-dir --name]  # 桌面「一键启动」图标（启动服务并打开浏览器）：
                                           #   Windows→桌面 .lnk（WScript.Shell COM，OneDrive 安全；服务未运行则在本
                                           #     隐藏窗口前台启动并记录 PID，server stop/uninstall 可止停）
                                           #   macOS→桌面 .command 双击启动器（已装 launchd 则 kickstart，否则终端前台）
                                           #   Linux→桌面 .desktop 图标 + ~/.local/share/pi-web-ui 启动脚本（systemctl 优先）
pi-web-ui server status|restart|stop|uninstall
# Docker：docker-compose.yml（端口映射 + 挂载数据目录）
```

> uninstall 会自动移除桌面图标；未装服务时桌面快捷方式启动的实例在 status/stop 中单独报告（PS1 前台+记录 PID）。

## Windows 下载选择

- `pi-<版本>-setup-x64.exe`：安装版，包含安装向导、安装目录选择，以及桌面和开始菜单快捷方式。
- `pi-<版本>-win-x64.exe`：免安装便携版，双击直接启动，没有安装向导，也不自动创建快捷方式。
- `pi-<版本>-win-x64.zip`：解压后运行 `pi.exe`。

Windows 打包使用 `win.signExecutable: false` 跳过签名，保留 EXE 图标和产品信息写入；不要设置 `signAndEditExecutable: false`，它会连资源编辑一起禁用。安装器、卸载器和应用使用 `build/icon.ico` 的紫色 π 图标。

## 桌面版（Electron）

不进 npm 发布包（`package.json` `files` 不含 `electron/`/`build/`）——桌面版走自己的发布渠道：
push 一个 `v*` tag，`.github/workflows/release-desktop.yml` 会在 mac/win/linux 真机 runner 上
各自构建并 `--publish always` 传到 [GitHub Releases](https://github.com/youweichen0208/pi-web-ui/releases)
（`electron-builder.yml` 里 `publish: provider: github` 已经配好，用的是 CI 自带的
`GITHUB_TOKEN`，不需要额外配 secrets；当前不签名）。本地手动构建命令如下：

```bash
npm install                    # 会装 electron / electron-builder / electron-updater（devDeps）
npm run build                  # build:web + build:server（打包前必须先构建）
npm run dev:electron           # 直接跑 electron .，加载本地构建，走 dev 模式（自动开 DevTools）
npm run build:electron:mac     # 产出 dmg/zip（release/），需要在真机 macOS 上跑（原生模块要 rebuild）
npm run build:electron:win     # 产出 nsis 安装包 + portable 绿色版 + zip
npm run build:electron:win -- --win zip --x64 -c.npmRebuild=false
                                # 只出 zip，能在 mac/Linux 上交叉构建（不需要 wine）；
                                # nsis/portable 两个目标要跑 makensis，非 Windows 机器上必须装 wine，
                                # 否则只能在真机 Windows 或 GitHub Actions windows runner 上出
npm run build:electron:linux   # 产出 AppImage + deb
npm run publish:electron       # 同 build，但 --publish always——本地跑这个会真的发到 GitHub Releases，
                                # 平时发布走 push tag 让 CI 做，这个命令是给手动补发/重发用的
```

架构（`electron/main.mjs`）：

- 主进程 `fork()` 一个隐藏子进程跑 `dist/server/index.js`（`ELECTRON_RUN_AS_NODE=1`，
  即用 Electron 自带的 Node 运行时跑纯 Node 代码，不是渲染进程）。
- 桌面 Pi SDK 精确锁定为 1.0.2；终端 `pi update` 只更新外部 CLI。
- 打包排除仓库里的 `.pi`、`.omp` 和 `.env*`。产物运行 `tests/packaged-server-start-test.mjs`、`tests/native-tools-desktop-test.mjs`、`tests/provider-auth-test.mjs`，检查终端、Codemode worker、SDK 文档、OAuth lazy 模块。

- 通过 stdout 里的 `⚡ pi-web-ui` 标记（见 `server/index.ts` 的 `httpServer.listen` 回调）
  判断 server 就绪，再让 `BrowserWindow` 加载 `http://127.0.0.1:{随机空闲端口}`。
- 子进程意外退出后，主进程在同一端口最多重启 3 次（间隔 1/2/4 秒），窗口保留原 URL，
  WebSocket 会自行重连；三次均失败时显示错误弹窗。退出应用时不会触发重启。
- `PI_WEB_PKG_ROOT` 告诉 server 去哪找 `web/dist`（打包后指向
  `process.resourcesPath`，即 `electron-builder.yml` 里 `extraResources` 复制的
  `dist/`、`web/dist/`）。
- `PI_WEB_DATA_DIR` 桌面版单独用 `~/.pi-web-desktop`，和命令行版的 `~/.pi-web` 分开，
  避免两边同时跑时抢 `client-state.json` 等运行时状态；对话历史本身走 SDK 的
  `~/.pi/agent`，两边共享，不受影响。
- 桌面单窗口客户端 ID 保存到 `<PI_WEB_DATA_DIR>/desktop-client-id`，由主进程通过沙箱 preload
  传给前端，不依赖随机端口的浏览器存储；完整退出再启动仍恢复服务端保存的最近项目和最后工作目录。
  浏览器版继续为每个标签页分配独立 ID。旧版各临时 ID 下的记录保留，不自动合并。
- HTTP/HTTPS 新窗口链接和离开应用的页面跳转由系统默认浏览器打开；应用内锚点保留，
  非网页协议不交给系统执行。文件的默认应用打开仍走已验证的专用 IPC。
  回归：`node tests/desktop-state-links-test.mjs` 与 `--links`（真实 Electron，临时数据目录，浏览器打开仅在系统调用边界替换）。
- 关闭窗口 → 最小化到托盘（不退出）；托盘菜单可重新打开 / 退出。
- 桌面窗口共用一条内容顶栏：macOS 隐藏系统标题栏、保留左侧原生红黄绿按钮；
  Windows/Linux 使用无边框窗口和右侧自绘最小化、最大化、关闭按钮。可拖动区域
  仅在品牌和项目标题，导航和菜单不参与拖动；双击标题区、系统缩放和全屏仍由 Electron
  处理。沙箱兼容的 `preload.cjs` 仅暴露固定窗口操作和窗口状态通知，关闭按钮继续隐藏到托盘。
- Electron 渲染页加 `pi-desktop` 类，次要操作位于设置菜单；窗口宽度
  ≤1100px 时右侧文件树变为抽屉。Web 和桌面共用工作区布局，模型设置位于输入框底部；
  顶栏高 44px，项目栏全高显示；macOS 品牌区为原生窗口按钮留空，项目栏开关固定在红绿灯右侧，收起项目栏时标题仍避让这些控件。Windows/Linux 顶栏为右上角 132px 窗口按钮预留空间；宽屏文件栏可见时由文件栏承担这段空间。设置和文件按钮不压缩，视图标签在空间不足时横向滚动。`tests/desktop-toolbar-test.mjs` 在 Chromium 中模拟两平台外壳，验证顶栏边界、状态数字与任务定位（不替代真机窗口验证）。详见 [界面布局](ui-design.md)。
- 原生模块（`node-pty`）：`electron-builder.yml` 里 `npmRebuild: true`，打包时自动
  rebuild 成 Electron 的 Node ABI，不需要手动 `electron-rebuild`；本机需要装好
  Xcode Command Line Tools（mac）/ Visual Studio Build Tools（win）。
- 聊天任务清单与 Web 共用 `TodoChecklist`：连续更新合并、后续变化行及历史任务定位一起随 `web/dist` 构建进入桌面包。`tests/todo-chat-browser-test.mjs` 覆盖 Web 和 macOS/Windows 桌面外壳的 900px 布局、键盘跳转、历史折叠与清空后编号复用；它不替代原生安装包验证。
- 图标：`build/icon.png`（1024×1024，从 `web/public/favicon.svg` 派生）+
  `build/icon.ico`；electron-builder 打包时自动生成各平台格式，不需要手动出
  `.icns`。
- 自动更新：`electron-updater` 使用 GitHub Releases feed；安装版启动时检查版本，
  在「设置 → 组件更新」点击「自动更新」下载，显示进度后点击「重启并安装」。
  安装前系统对话框提示保存文件并确认，不在普通退出时自动安装。检查/下载错误在设置页显示，
  开发模式禁用安装。`electron/app-updater.mjs` 管理状态及重复请求，preload 仅暴露固定操作，
  主进程校验请求来自主窗口主 frame；内置 Pi 跟随应用版本升级。
- 浏览器版的应用更新在可见终端运行固定的 `npm install -g @youweichen/pi-web-ui@<版本>`；
  registry 版本不高于当前版本时禁用，避免旧 npm 标签导致降级。成功后手动执行
  `pi-web-ui server restart`。原生扩展更新继续使用 Pi 包管理器。

注意：这个 Electron 壳子和 CLI 共用同一份 `server/index.ts`，改 server 端代码
时两边都要重新验证——尤其是 `resolvePkgRoot()`（`PI_WEB_PKG_ROOT` 覆盖逻辑）和
启动就绪标记（`⚡ pi-web-ui` 字符串），main.mjs 依赖这两处约定。

交叉构建 Windows 版的坑：

- `npmRebuild: true` 会触发 `@electron/rebuild` 用 node-gyp 从源码重编译 `node-pty`；node-gyp **不支持跨平台编译**，在 mac/Linux 上给 Windows target 跑会直接报错 `node-gyp does not support cross-compiling native modules from source`。在真机 Windows 上构建，或者 CI 用 windows runner 时不受影响，正常走 `npmRebuild: true` 即可。
- 在非 Windows 机器上要出 zip（`-c.npmRebuild=false`）时，跳过的是重编译这一步，实际用的是 `node-pty` 包自带的 `prebuilds/win32-x64/pty.node`（跟 mac 版同理，不是本项目编译的，是 node-pty 官方发布时带的预编译产物）。electron-builder 会自动把 `.node` 原生模块解到 `app.asar.unpacked/`（不进 asar 压缩包），不需要手动配 `asarUnpack`。这条路径下**终端功能在 Windows 上是否正常没有用真机验证过**，其余功能（聊天/文件树/模型管理）不依赖 node-pty，应该没问题。
- `npm run build:electron:win` 默认的 `nsis`/`portable` 两个 target 要跑 `makensis`，在非 Windows 机器上必须装 `wine`（本仓库开发用的沙箱环境没有 root 权限装不了）——要出正式的安装包，得在真机 Windows 上跑，或者接 GitHub Actions 的 `windows-latest` runner。
- `artifactName` 模板别用 `${name}`——`package.json` 的 `name` 是 `@youweichen/pi-web-ui`（带 npm scope），`${name}` 里那个斜杠会被当成路径分隔符，实际文件会跑到 `release/@youweichen/` 子目录里而不是 `release/` 根目录，CI 里按 `release/*.exe` 收集产物会直接漏掉。已经全部改成 `${productName}`（就是 `pi-web-ui`，干净的，不带 scope）。

桌面测试可设置 `PI_WEB_DATA_DIR` 指向临时数据目录；未设置时继续使用 `~/.pi-web-desktop`。Chromium 配置可用 `--user-data-dir` 隔离。

桌面文件编辑与 Web 共用右栏组件。Wiki 关闭到托盘或退出前，主进程通过固定 `pi-window-before-close` 请求等待自动保存，校验主 frame 与请求 ID 后才接受 `pi-window-close-result`；失败或 30 秒超时取消关闭、保留窗口，服务保持运行。普通文件预览关闭到托盘仍保留草稿；退出或刷新遇到未保存内容时，主进程通过 `will-prevent-unload` 显示原生放弃确认，取消后服务继续运行。回归：`tests/wiki-desktop-save-test.mjs`。

### Windows 便携版临时目录

`electron-builder.yml` 的 `portable.unpackDirName: true` 让锁定的 electron-builder 26.15.3 不定义 `UNPACK_DIR_NAME`，NSIS 为每次启动分配独立 `$PLUGINSDIR`。该版本上游类型注释写的是 false，但实际实现需要 true。默认每个构建复用同一临时目录，重复打开时第二个单实例进程退出会删除第一个实例仍在使用的 SDK 文件，导致 `ERR_MODULE_NOT_FOUND`（如 `anthropic-messages.js`）。不要恢复默认值。

Windows 发布先构建，再执行 `tests/packaged-server-start-test.mjs`（使用打包后的 Electron 加载懒加载 provider 并启动包内服务端）及 `tests/portable-relaunch-test.ps1`（首次启动、重复打开、原进程存活及模块保留），通过后才上传安装包；这些检查失败会阻断 Windows 发布。手动运行 `Verify Windows desktop build` 时传入 `release_tag`，可直接验证已发布的 ZIP、NSIS 和便携 EXE，无需重新构建。

### Pi 1.0.2 原版 SDK

不应用 WebUI 的 SDK 补丁，恢复行为遵循 pi 1.0.2。每个对话创建原生 SettingsManager，生效配置未声明 defaultTools 时仅通过内存覆盖启用 `["+codemode", "+tool_search"]`；reload/信任变化后重新应用。已有原生选择（含空数组和禁用项）保持权威，不自动删除旧版已写入的值。MCP 使用原生 mcp.json，不配置外部服务器。

### Wiki 文件与 PDF

Wiki 的 PDF.js 依赖和 `wiki-pdf-worker` 随服务打包。PDF 解析复用桌面 Node 子进程环境，具体限制见 [Wiki 架构](architecture-wiki.md)。沙箱 preload 新增固定 `openWikiFile` 方法：主进程使用 clientId/cwd/path 向本机服务验证当前文件，再通过系统默认应用打开；渲染进程不直接传任意可执行路径。

Extensions 包管理的 `extensions-worker` 与服务端一起编译打包，在 Electron 下使用 Node 子进程执行原生包管理。固定 `openExtensionPath` IPC 按服务器验证过的包 ID 在文件管理器中显示路径；不执行渲染进程传入的任意文件。

服务端 Wiki 解析使用 `unified` 与 `remark-parse`，必须列入生产依赖。打包启动检查要求这两个模块解析到产物自身目录，禁止借用仓库上层 node_modules；仅清空 NODE_PATH 不会禁止 Node 向父目录查找模块。
