# AGENTS.md — pi-harness 项目指南

> 本文件是给 AI 编码助手（pi / Claude Code / Cursor 等）看的高层项目说明书。
> 详细文档按主题分拆在 `docs/` 目录下。
> 修改本文件后，在 pi 中运行 `/reload` 生效。

## 1. 项目是什么

pi-harness 是 pi 编码智能体（`@earendil-works/pi-coding-agent` SDK）的 Web 聊天界面：
浏览器里对话、查看文件树、附加文件、内置终端（xterm.js + node-pty）、模型管理、
声音提醒、中英文切换。一条命令可跑（`pi-harness`），可 Docker / systemd / launchd /
Windows 计划任务部署。

-   仓库（公开）：`git@github.com:youweichen0208/pi-harness.git`
-   npm 包：`@youweichen/pi-harness`（发布者 npm 账号 `youweichen`；当前项目独立维护）
-   Node 要求：**\>= 22.19.0**（pi SDK 的 dist 使用了 `import … with { type: "json" }` 语法）
-   版本：`package.json` 与 `package-lock.json` 两处同步维护。

## 2. 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node + Express（静态 + `/api/health`）+ `ws`（`/ws` WebSocket 协议） |
| 前端 | React 18 + Vite 6 + react-markdown + highlight.js + xterm.js |
| 智能体 | `@earendil-works/pi-coding-agent` SDK（进程内，读 `~/.pi/agent` 配置） |
| 终端 | node-pty（服务端 PTY）+ `@xterm/xterm`（浏览器渲染，经 terminal bridge 转发） |
| 样式 | 单文件 `web/src/styles.css`（浅色/深色/跟随系统，CSS 变量） |

SDK 与 pi-ai 精确锁定 1.0.4，不应用本项目的 SDK 补丁。Codemode 与工具搜索使用原生 defaultTools 默认开启，已有原生配置优先。
系统提示词：修改分段来源、原生文件编辑或重载时，读取 `docs/architecture-system-prompt.md`。
Extensions：修改包安装、启停、更新、作用域迁移、目录浏览或单文件编辑时，读取 `docs/architecture-extensions.md`。
Codemode 卡片与 MCP/Codemode 设置遵循 15a/15b 设计；状态、项目覆盖、费用及输出限制读取 `docs/architecture-plugins.md`。

SDK 生命周期：以 `agent_settled` 判定整个任务结束，`agent_end` 只表示一次循环结束。修改队列、纠正、压缩/重试状态、扩展 UI 对话隔离或工具完整输出下载前读 `docs/architecture-core.md`；修改桌面扩展子进程或打包前读 `docs/deployment.md`。

## 3. 目录结构

```
pi-harness/
├── server/                     # 后端（Node ESM，编译到 dist/server/）
│   ├── index.ts                # 入口：express 静态 + /ws 端点、消息分发、心跳、优雅停机
│   ├── app-version.ts          # 运行中 pi-harness 包版本（区别于 pi SDK VERSION）
│   ├── protocol.ts             # ★ 唯一事实源：wire 协议类型（client↔server 消息）
│   ├── agent-service.ts        # 核心：ClientSession（每客户端一个会话组，可并行多个对话）+ AgentService
│   ├── serialize.ts            # SDK 消息 → UiMessage 序列化
│   ├── text-sniff.ts           # 文件预览纯函数（previewKind/looksLikeText/decodeText/sniffImageMime/hexDump/countLines）
│   ├── process-utils.ts        # 进程工具：snapshotListeningPorts/killPidTree/lookupProcessName
│   ├── client-state.ts         # ClientStateStore：<dataDir>/client-state.json 持久化
│   ├── uploads.ts              # 文件对话上传 + 保留期清理
│   ├── bg-servers.ts           # 后台任务跟踪（bash 前后端口快照 diff + 存活刷新）
│   ├── component-updates.ts    # pi Agent / 扩展版本检查、来源校验与包更新
│   ├── system-prompt-view.ts / system-prompt-files.ts / system-prompt-routes.ts # 原生提示词分段、文件编辑与 reload
│   ├── session-reload.ts         # 提示词、设置、MCP 与斜杠命令共用的按会话重载队列
│   ├── settings-service.ts     # 界面偏好与原生资源只读视图（扩展命名见 extension-display.ts）
│   ├── task-progress.ts        # 从当前轮次工具记录推断任务进度与显式计划
│   ├── plan/                   # 可选原生 plan 扩展、全局开关与分支快照投影；见 docs/architecture-plan.md
│   ├── slash-commands.ts       # 斜杠命令（NATIVE_COMMANDS 内置命令拦截执行 + 目录推送）
│   ├── model-admin.ts          # 模型/服务商配置管理
│   ├── model-config-merge.ts   # 聊天模型表单合并；保留 typed models 和未知字段
│   ├── native-mcp-config.ts    # 原生 MCP 配置版本校验与敏感值；修改时读 docs/architecture-plugins.md
│   ├── provider-auth.ts        # 官方 OAuth 登录桥；凭据由 SDK 保存，不下发浏览器
│   ├── native-tools.ts         # 原生 MCP/codemode/tool_search factories；见 docs/architecture-plugins.md
│   ├── attachments.ts          # 附件构建（inline/reference/lines/imageData/fileData）
│   ├── webui-context.ts        # 扩展 UI 桥（WebUIContext：widgets/statuses/dialog → 浏览器）
│   ├── plugins.ts              # 可选界面组件插件（扫描 <dataDir>/plugins/<id>/）
│   ├── files-service.ts        # 文件服务（readDirForUI/readFile/searchFiles/watcher）
│   ├── sqlite-preview.ts       # SQLite 只读预览调度（sqlite-worker/query：隔离进程与分页查询）
│   ├── scm.ts                  # SCM 只读 git 查询（execFile git status/branches/history/filediff/commit）
│   ├── patch-node-pty.ts       # node-pty × Node --watch 兼容自愈补丁
│   ├── ensure-bash.ts          # Windows 轻量 bash 兜底（busybox-w32）
│   ├── control-socket.ts       # 本地控制 socket（status / quiesce / unquiesce）
│   ├── terminals.ts            # TerminalManager（PTY 管理 + 增量输出/按键工具）
│   ├── node-agent.ts           # SSH exec 上的原生 pi RPC 会话、消息流与扩展确认
│   ├── node-sources.ts         # Xshell / SSH config 元数据解析
│   └── node-workbench.ts       # 内置 SSH 节点：来源同步/凭据/确认/PTY/SFTP/手动终端和文件操作
├── web/                        # 前端（React + Vite，编译到 web/dist/）
│   ├── vite.config.ts          # dev 端口 5173，/ws 代理到后端
│   ├── src/
│   │   ├── App.tsx             # 顶层布局
│   │   ├── use-chat.ts         # ★ useChat()：WebSocket 连接管理、reducer 状态机、终端 bridge
│   │   ├── use-workspace-scm.ts # 顶栏与文件栏共用 Git 改动状态，按请求 ID 和 cwd 校验归属
│   │   ├── types.ts            # ★ wire 协议 re-export shim（`export type * from "../../server/protocol"`）
│   │   ├── i18n.tsx            # ★ 中英文案（zh 默认），新增 key 必须两处都加
│   │   ├── styles.css          # ★ 全部样式（按组件分区，带注释分隔线）；应用外观与独立代码配色
│   │   ├── theme.ts            # CSS 变量 → xterm 终端调色板桥接（THEME_CHANGE_EVENT + buildTermTheme）
│   │   ├── sounds.ts           # WebAudio 提示音
│   │   ├── download.ts         # 下载（fetch→blob，绕开 Chrome Safe Browsing）
│   │   ├── message-delta.ts    # message_delta 增量 patch 纯函数，有单测
│   │   ├── lazy-window.ts      # 消息列表惰性窗口化纯函数，有单测
│   │   ├── search-text.ts      # 会话内搜索索引纯函数，有单测
│   │   ├── skill-block.ts      # parseSkillBlock：<skill> 块解析，有单测
│   │   ├── auth-token.ts       # PI_WEB_TOKEN 口令注入，有单测
│   │   ├── image-paste.ts      # 粘贴图片等比缩放 ≤1568px + PNG/JPEG 转码
│   │   ├── uuid.ts             # randomUuid（crypto 兜底），有单测
│   │   ├── protocol-version.ts # 协议版本常量
│   │   ├── main.tsx            # 入口：initAuthToken
│   │   └── components/         # 见下
│   └── dist/                   # 构建产物（gitignore，但打进 npm 包）
├── bin/pi-harness.mjs          # CLI：前台启动 / server install|uninstall|start|stop|restart|status
├── deploy/                     # 部署示例：launchd plist / systemd unit / Windows 任务 XML
├── tests/                      # 全部测试脚本（自包含：独立端口 ≥8900 + 临时 data-dir）
│   ├── run-smoke.mjs           # 零 token 协议冒烟聚合跑器
│   ├── unit/                   # vitest 纯函数单测
│   ├── *-test.mjs              # 手写 Playwright E2E / WS 协议测试
│   └── scratch/                # 一次性调试脚本（gitignore，不入库）
├── scripts/check-protocol-sync.mjs  # 守护 types.ts shim 单源机制 + protocol.ts 纯类型约束
├── .github/workflows/ci.yml    # CI：lockfile 检查 → 安装 → 协议同步 → typecheck → build → vitest → 冒烟
├── extensions/                 # npm CLI 扩展：webui.ts（/webui 启动浏览器；Desktop 不打包）
├── electron/                   # Electron 桌面版壳子（main.mjs 主进程 + 沙箱兼容的 preload.cjs），本地构建，不进 npm 包
├── electron-builder.yml        # Electron 打包配置（mac dmg/zip、win nsis/portable、linux AppImage/deb）
├── build/                      # electron-builder 用的图标源文件（icon.png 1024x1024 + icon.ico）
├── dev/                        # 本地开发辅助（不入 npm 包）
├── Dockerfile / docker-compose.yml
├── docs/                       # 详细文档（本文件的分拆）
│   ├── architecture-core.md    # 核心架构：快照驱动、协议单源、安全边界、多对话并发
│   ├── architecture-attachments.md  # 附件、图片、文件上传/预览/下载
│   ├── architecture-terminal.md    # 终端架构：PTY 管理、SCM 查询
│   ├── architecture-plugins.md     # 插件系统：形态、协议、宿主扩展点、MCP 桥
│   ├── development.md          # 开发工作流、CI、编码约定、测试规范
│   ├── release.md              # 发布流程（GitHub + npm）
│   ├── deployment.md           # 部署（CLI / Docker）
│   └── env-vars.md             # 环境变量参考
├── tsconfig.server.json / tsconfig.extensions.json / tsconfig.tests.json / web/tsconfig.json
```

`web/src/components/` 速览：

| 组件 | 职责 |
| --- | --- |
| `FilePreview.tsx` | 右栏代码高亮编辑与媒体/SQLite 只读预览；Markdown 点击自动进入 Wiki；当前文件 chip 严格镜像预览面板，发送时携带编辑器快照（含未保存改动）；版本校验保存与离开保护（详见 docs/architecture-attachments.md） |
| `LeftPanel.tsx` | 全高项目栏：品牌、新对话、可折叠项目及会话、悬停更多菜单（重命名／删除）、连接／语言／设置；布局见 `docs/ui-design.md` |
| `RightPanel.tsx` / `TaskProgressPanel.tsx` | 可展开目录树、Git 改动标记、文件预览；当前任务进度由服务端 transcript 推断，右栏展示合并后的任务阶段和结果；布局见 `docs/ui-design.md` |
| `ChatInput.tsx` | 输入框 + 附件 chips（inline/reference/lines 三色）+ 当前文件 chip（镜像预览面板，发送取编辑器快照）；全窗口拖放目标；followUp 排队/steer 插队；斜杠命令选择器 |
| `Message.tsx` / `MessageList.tsx` / `WorkingStatus.tsx` | 消息渲染、流式等待标题与静默状态、tool 结果关联；编辑重问、惰性窗口化、问题导航；等待态切换与间距见 `docs/ui-design.md` |
| `PlanChecklist.tsx` | Web/桌面共用清单卡和变化行；修改计划更新合并、替换隔离或步骤跳转时，读取 `web/src/plan-presentation.ts`、`docs/architecture-plan.md` 和 `docs/ui-design.md` |
| `ToolCallBlock.tsx` / `BashGroup.tsx` / `EditWriteCard.tsx` / `ThinkingBlock.tsx` | 通用工具卡片、连续命令分组、编辑与写入的逐行 diff 卡片、思考块；修改命令合并/折叠/跳转时读取 `web/src/bash-groups.ts` 和 `docs/ui-design.md` 的 27a 规则；编辑卡片的数据整理在 `web/src/edit-write-presentation.ts`，交互规则见 `docs/ui-design.md` |
| `ChangesPanel.tsx` / `ChangeSummaryCard.tsx` | 35a 对话改动面板及每轮汇总；修改范围、定位、折叠、搜索或轮次统计前读取 `docs/chat-diff-design.md` 与 `docs/architecture-terminal.md`；本轮共用 `task-outputs.ts`，Git 范围走 `scm_diff`（协议 v41） |
| `TerminalPanel.tsx` / `TermXterm.tsx` | 终端视图 + xterm 实例桥接 |
| `SCMPanel.tsx` | 源代码管理（Git）视图：status/branch/diff；提交/推送/拉取/切换分支 |
| `TopBar.tsx` / `FooterBar.tsx` | 顶栏（项目／会话标题、后台任务、视图切换、文件栏开关）、状态栏（版本／分支／消息／工作目录）；模型与思考强度在 `ChatInput.tsx` 底部 |
| `Dialog.tsx` | 扩展 `ui.select/confirm/input` → 浏览器弹窗 |
| `ModelConfigModal.tsx` / `PiSetupModal.tsx` | models.json 管理 / 首次配置引导 |
| `SystemPromptPanel.tsx` | 原生提示词分段、全文复制、SYSTEM/APPEND/上下文文件编辑；见 `docs/architecture-system-prompt.md` |
| `SettingsModal.tsx` | 设置面板（原生提示词/技能/扩展/MCP/更新；更新页不显示 pi-harness 本身；默认打开原生提示词，各页使用设置 v2 带用途说明的分组列表，MCP 常用控件自动保存；见 docs/ui-design.md） |
| `BgTasksModal.tsx` | 后台任务弹窗：AI 启动的监听端口进程列表 |
| `ModelThinking.tsx` | 模型 + 思考强度下拉（模型下拉顶部有搜索过滤框；输入工具栏思考档位为带说明的三级菜单） |
| `GlobalSearchModal.tsx` | 全局搜索弹窗（Ctrl+K）：搜历史对话/最近项目/工作区文件名 |
| `PluginView.tsx` | 插件视图宿主：薄 React 壳 + 动态 import client bundle |
| `NativeMcpPanel.tsx` | 原生 MCP 与 Codemode 设置；修改作用域或信任时读 `docs/architecture-plugins.md` |
| `NodeWorkbench.tsx` / `node-terminal.tsx` | SSH 节点工作台：来源同步、详情/凭据、远端 Agent 与手动终端；修改时阅读 `docs/architecture-nodes.md` |
| `CollapsedMessage.tsx` / `LazyMount.tsx` | 消息折叠摘要行 / 消息级惰性挂载包装 |
| `SearchBar.tsx` | 会话内搜索栏（Ctrl+F，CSS Custom Highlight API 高亮） |
| `Markdown.tsx` / `Dropdown.tsx` / `copy-button.tsx` / `SoundSettings.tsx` | 通用件 |

## 原生代理边界

pi SDK 和 pi-ai 精确锁定 1.0.4，使用原版 SDK，不应用本项目的 SDK 补丁。会话加载 pi 原生配置、上下文文件、技能、扩展与官方 Codemode/tool_search/MCP。WebUI 不覆盖 bash，不自动续跑或发起额外模型调用；唯一例外：回复以“写成文本、未执行的工具调用”结尾时，请模型重新调用，界面显示为自动提醒事件（每条用户请求最多 1 次，见 `docs/architecture-core.md`「未执行的工具调用」）；原生 plan 扩展默认开启（保留已保存的关闭选择），启用时由扩展提供工具规则与条件性历史背景。修改工具、全局开关、压缩恢复或计划投影时读取 `docs/architecture-plan.md`。设置中的提示词支持原生文件编辑与空闲时 reload，技能支持原生发现、筛选和启停（见 docs/architecture-extensions.md）；Extensions 管理原生包声明及资源过滤规则，变更通过新会话或用户重载生效。界面偏好不改变模型上下文。SSH 工作台提供隔离的远端原生 pi RPC 会话与手动终端；修改启动、消息流、确认或断开清理时读取 `docs/architecture-nodes.md`。

## 4. 核心架构（摘要）

> 详细文档见 `docs/architecture-*.md`

| 主题 | 文档 | 要点 |
| --- | --- | --- |
| **快照驱动** | `docs/architecture-core.md` | 服务端是唯一事实源，60ms 节流推快照；增量快照（snapshot_delta）；message_delta 实时增量通道不经 snapshot 通道；WS permessage-deflate 压缩；多标签页序列化共享；协议版本协商 |
| **项目切换缓存** | `docs/architecture-core.md` | 修改切换、缓存或异步归属时阅读：请求确认、权威状态与展示分离、3 项目/32MiB LRU、隐藏视图刷新策略；界面切换不弹成功通知，命令切换在目标会话保留事件 |
| **协议单源** | `docs/architecture-core.md` | `server/protocol.ts` 是唯一事实源；`web/src/types.ts` 是 `export type *` shim；新增消息只改 protocol.ts，两端 switch 各加分支 |
| **安全边界** | `docs/architecture-core.md` | 默认只绑 loopback；WS Origin/Host 同权威校验；quiesce 准入控制；控制 socket；provider headers 不下发浏览器 |
| **多对话并发** | `docs/architecture-core.md` | 每对话手动终端和文件操作SessionRuntime；对话按项目归属；set_cwd 切到目标项目对话；8 个上限/项目；共享同一个 ModelRuntime |
| **附件** | `docs/architecture-attachments.md` | 三种模式（inline/reference/lines）；图片问答（base64 + 缩放）；文件上传（fileData 落盘） |
| **文件预览** | `docs/architecture-attachments.md` | 修改右栏编辑、保存冲突或草稿离开保护时阅读；512KB 预览、媒体 HTTP Range、下载 |
| **终端** | `docs/architecture-terminal.md` | 每 Conversation 一个 TerminalManager；spawn 统一准入；按键编码纯函数；输出微批合并；node-pty × --watch 兼容自愈 |
| **SCM** | `docs/architecture-terminal.md` | 只读 git 查询走 execFile；未跟踪文件显示限量内容；git-dir watcher；写操作走可见终端 tab |
| **插件** | `docs/architecture-plugins.md` | <dataDir>/plugins/<id>/ 目录（manifest.json + index.mjs + client/entry.mjs）；attach 时热重扫；MCP 工具桥 |
| **SSH 节点** | `docs/architecture-nodes.md` | 修改 Xshell/SSH config 同步、凭据、执行确认或终端引用时阅读；本机 ssh2 与远端专用 Agent |
| **工具结束实时状态** | `docs/architecture-core.md` | tool_status 先于快照落盘，浏览器卡片立即从「执行中」→「已结束」 |
| **运行静默状态** | `docs/architecture-core.md` | 改模型无响应或长时间工具运行提示时，使用 conversationId 绑定的 agent_silence；恢复响应即清除，重试只适用于本轮未调用工具的纯文本请求 |
| **当前任务进度** | `docs/architecture-core.md`、`docs/ui-design.md` | 修改任务判定、提纲布局或计划触发时阅读：可选原生 `plan` 管理分支版本化计划，尊重用户／skill 的执行与等待规则；步骤按工具 ID 展开记录，暂停不自动完成，兼容历史 `task_plan`；历史任务列表尚未实现 |
| **后台任务列表** | `docs/architecture-core.md` | bash 前后端口快照 diff；按客户端持久；单停/全部关闭 |
| **扩展 UI 桥** | `docs/architecture-core.md` | setWidget/setStatus/notify/select/confirm/input → 浏览器消息；dialog_response 回传 |

Wiki：点击 `.md` / `.markdown` 自动进入文档工作台，顶栏无独立 Wiki 模式入口，点「对话」返回。修改阅读布局/本页目录、右侧对话面板/建议跳转、文档切换性能/正文独立读取、文档会话隔离/等待状态、索引状态、双链/标签索引、全文/PDF 搜索、请求改动记录、撤销重做或桌面默认应用打开时，读取 `docs/architecture-wiki.md`。34a 插入工具栏为 `WikiToolbar.tsx`（表格尺寸、代码语言及宽版）；具体排版见 `docs/wiki-doc-v2-design.md`。入口为 `WikiWorkbench.tsx` / `WikiReading.tsx` / `WikiChatPanel.tsx`、`wiki-routes.ts` 与 `wiki-service.ts`；提问复用原生 pi 会话。

会话树：修改树过滤/搜索、分支切换/摘要/label、编辑重问、派生会话、外部修改检测或返回文本的草稿保护时，读取 `docs/architecture-session-tree.md`。树状态由原生 SDK 管理，协议 v40，默认编辑重问留在同一会话文件。修改附件卡片、原生条目冻结恢复或模板附件时，读取 `docs/architecture-attachments.md`。

## 5. 开发工作流

> 详细文档见 `docs/development.md`

```bash
npm run dev          # 并行：node --watch 后端(:8788) + vite 前端(:5173)
npm run typecheck    # 双端 tsc --noEmit（提交前必跑）
npm run build        # build:web (vite) + build:server (tsc)
npm start            # 跑编译产物 dist/server/index.js（生产）
npm test             # 设计令牌检查 + vitest 纯函数单测
npm run test:smoke   # 零 token 协议冒烟聚合跑器
```

依赖安装前先运行 `npm run check:lockfile`，确保下载地址全部使用 HTTPS npm 官方源且与声明版本一致；安装验证流程见 `docs/development.md`。

**界面规则**：修改界面前读取 `docs/ui-design.md`，以其为准；颜色和圆角只能用 CSS 变量，例外见该文档。

**关键约定**：缩进用 Tab；i18n 走 `useT()`（zh/en 同时加）；样式全部在 `styles.css`；新增协议消息只改 `protocol.ts` 再两端 switch 加分支。

**测试规范**：端口隔离（≥8900）；data-dir 隔离（`mkdtempSync`）；精确清理自己进程；不允许 `pkill -f` 杀全局。

## 6. 发布流程

> 详细文档见 `docs/release.md`

```bash
# 升版本 → 自检构建 → git commit → git push → npm publish
npm run typecheck && npm run build
git add -A && git commit -m "feat(xxx): 描述"
git push origin develop
npm publish --access public
```

注意事项：版本号必须高于 npm registry；提交信息不要带 `Co-authored-by`；升级后需手动重启服务 `pi-harness server restart`；发布前检查示例文件不泄密。

桌面版发布是独立的一条线（跟 npm 发布不绑在一起）：打一个 `v*` tag push 上去，`.github/workflows/release-desktop.yml` 先创建草稿，在 mac/win/linux 真机 runner 上构建、执行打包产物回归，再上传附件；三个平台全部成功且附件齐全后才公开。使用 GitHub 自带的 `GITHUB_TOKEN`，带 `-` 的 beta tag 标记 prerelease。mac 只有 ad-hoc 签名、未公证：macOS 14 及更早右键「打开」，macOS 15 及以后需在「系统设置 → 隐私与安全性」点「仍要打开」；Windows 未签名，SmartScreen 点「更多信息 → 仍要运行」。正式签名需要修改 `electron-builder.yml`，仅加 Secrets 不会生效。手动单平台重建只更新附件，不单独公开草稿。
Windows job 的终端冒烟测试必须通过才能上传安装包；`AttachConsole failed` 清理竞态由 `server/patch-node-pty.ts` 处理，不能以 `continue-on-error` 跳过终端读写失败。

## 7. 环境变量

> 完整列表见 `docs/env-vars.md`

| 变量 | 默认 | 一句话作用 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `PI_WEB_HOST` | `127.0.0.1` | 监听地址（默认只绑 loopback） |
| `PI_WEB_CWD` | `process.cwd()` | 智能体工作区 |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | 数据目录（client-state / uploads / plugins） |
| `PI_WEB_TOKEN` | 空 | 可选共享口令鉴权 |

## 8. 部署

> 详细文档见 `docs/deployment.md`

- **CLI 前台**：`pi-harness --port 9000 --cwd /path`
- **开机自启**：`pi-harness server install`（macOS→launchd / Linux→systemd / Windows→计划任务）
- **Docker**：`docker compose up -d`
- **桌面版（Electron）**：`npm run build && npm run dev:electron` 本地跑；`npm run build:electron:mac/:win/:linux` 出安装包（`release/`，未发布，需真机构建）。改窗口顶栏、preload 接口或窄窗口布局时看 `docs/deployment.md` 的桌面窗口外壳说明。

## 9. 常见坑

- **改了 `protocol.ts` 后忘了在两端 dispatch/onmessage switch 加分支** → 前端收到未知消息类型被 switch 静默丢弃，表现为"没反应"。先跑 `npm run typecheck`。
- **快照 60ms 节流**：调试时 `get_state` 可立即推一次（`cs.flushSnapshot()`）。
- **snapshot 发送背压**：`send()` 在序列化之前检查 `ws.bufferedAmount`，超过阈值时丢弃 snapshot（全量幂等且稍后必有更新）；丢弃时安排 250ms 重试 timer。
- **`hello` 前/会话未就绪时的命令**：`server/index.ts` 的 `pending` 队列会缓存并在 attach 后重放。
- **clientId 每标签页独立**（issue #10）：前端 `getClientId()` 存 sessionStorage（非 localStorage），同源多标签页是多个独立客户端。回归：`multi-tab-test.mjs`。
- **socket 半开**：服务端 10s 心跳，客户端 30s 无消息主动断开重连（指数退避 1s→10s）。
- **项目顺序**：左侧项目按 `lastUsed` 与最近对话活动排序，再次打开会移到前面；`firstAdded` 仅作时间相同的排序补充。
- **断线时停止**：浏览器保留当前对话的停止意图，重连拿到完整快照后仅在同一对话仍运行时补发；离线期间不继续显示模型计时。Electron 服务子进程意外退出后在原端口最多重启 3 次。
- **预览与附件行号**：`countLines` 不算尾随换行；前端 `split("\n")` 后也要 pop 掉末尾空串。
- **Windows 老中文文件乱码**：预览/内联附件/行附件统一走 `decodeText`（严格 UTF-8 失败 → GBK → latin1）。
- **Playwright 脚本**：headless shell 路径写死在本机，CI/换机需要改 `HEADLESS` 常量。

- **Electron `fork()` 必须显式带 `ipc`**：`child_process.fork()` 传自定义 `stdio` 数组时，不含 `'ipc'` 会直接抛 `ERR_CHILD_PROCESS_IPC_REQUIRED`（`electron/main.mjs` 里是 `stdio: ["ignore", "pipe", "pipe", "ipc"]`，别漏了最后一项）。
- **Electron 沙箱 preload 用 CommonJS**：`BrowserWindow` 默认沙箱不执行 preload 中的 ESM `import`；保持 `preload.cjs` 与 `require("electron")`，否则桌面标记与窗口控制接口均不会注入。
- **node-pty 没有 linux 预编译包**：`node_modules/node-pty/prebuilds/` 只有 darwin-arm64/x64 和 win32-arm64/x64，本项目目标平台是 mac/win 桌面机；在纯 Linux 环境（比如某些 CI/沙箱）直接跑 server 会在加载终端功能时崩，与 Electron 改动无关，是环境限制。

---
*结构/流程变更时同步更新本文件及相关 `docs/` 文档。修改后运行 `/reload` 生效。*
