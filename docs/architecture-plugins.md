# 插件系统

> 可选界面组件，存放在 `<dataDir>/plugins/`。不装即不存在，attach 时热重扫。

## 形态

一个插件 = `<dataDir>/plugins/<id>/` 目录：

- `manifest.json`（name/version/description）
- `index.mjs` 服务端入口（可选，`export default { activate(host) → deactivate? }`）
- `client/entry.mjs` 视图入口（可选，`export default { mount(el, ctx) → cleanup? }`）

**不装即不存在**——目录不在就没有任何协议/UI 痕迹；attach 时重扫目录，新丢进来的插件无需重启服务即出现在顶栏视图 tab（import 每进程一次并缓存；删除目录 → 下次 attach 反激活）。

## 协议

| 方向 | 消息 | 作用 |
| --- | --- | --- |
| 上行 | `plugin_message` | 路由到该插件的 onMessage 处理器，回调第二参为 clientId；未知/非法 id 静默丢弃 |
| 上行 | `plugins_reload` | 服务端热重载：反激活全部→重扫激活→epoch+1→重推清单 |
| 下行 | `plugins` | attach 时推清单（plugins, epoch），epoch 用作前端 import 缓存击穿参数 `?e=` |
| 下行 | `plugin_data` | 默认广播给所有 socket，前端按 pluginId 扇出给已加载视图 |

## 宿主扩展点

| 方法 | 作用 |
| --- | --- |
| `host.notify(level, text)` | 发系统通知条（notice，前端 toast） |
| `host.sendTo(clientId, payload)` | 定向发给单个 socket |
| `host.onToolEvent(h)` | 订阅 SDK 工具执行事件（phase:start\|end, toolName, conversationId?, durationMs?, isError?） |
| `host.onAttach(h)` | 注册「新客户端接入」钩子（每次浏览器 attach，含 plugins_reload 后的重接入） |
| `host.route(method, path, handler)` | 挂载 HTTP 路由（`/plugins-api/:id/*`） |
| `host.fs` | 受限工作区文件访问（WorkspaceFS，路径锚定活 cwd 根，越界拒绝） |
| `host.getSettings()` | 读取声明式设置（manifest.settings schema） |
| `host.onSettingsChanged(h)` | 订阅设置变更 |
| `host.registerBackgroundTask(task)` | 注册插件常驻任务，并入顶栏「后台任务」面板 |
| `host.notifyCwd(cwd)` | 当主应用 set_cwd 成功后通知插件（幂等去重，异常隔离） |

### 宿主设施（plugin-facilities.ts）

| 设施 | 说明 |
| --- | --- |
| `storage` | `<pluginDir>/storage.json` 原子 KV |
| `secrets` | AES-256-GCM 加密机密，密钥 `<dataDir>/secrets.key`，拷机 fail closed |
| `ensureDeps` | npm 自动补装单飞 |

### 能力声明与强制（manifest.permissions）

## manifest 可选字段

- `icon`（emoji/单字符，顶栏 tab 替代通用拼图图标）
- `description`（tab 悬浮提示）
- `version`
- `apiVersion`（与 `PLUGIN_API_VERSION` 比较，> 则拒绝激活并提示升级）
- `permissions`（能力声明数组）
- `settings`（声明式设置 schema → ⚙ 面板自动渲染表单）

## 前端集成

App 按 chat.plugins 动态 import 各插件的 client bundle（`/* @vite-ignore */`），TopBar 为每个插件加一个 🧩 tab（激活失败的置灰）；插件不共享 React 实例，与主应用只有 ctx.send/onData 两条窄通道。

`syncPluginViews(plugins, epoch)` 统一同步注册表：清单消失/被禁用即卸载视图（调 cleanup）、epoch 变化清 failed 重拉 bundle。

设置面板 ⚙ 有「界面插件」开关区（`set_settings.disabledPlugins`，持久化 client-state、纯 UI 隐藏不触发 runtime reload）+ **每行「更新/卸载」按钮**（更新需 CLI install 记录的来源 `.pi-source.json` → `UiPluginInfo.source`；两个操作都走可见终端 tab，退出后 App 观察器发 `plugins_reload` 热重载）。

## 静态服务

`GET /plugins/:id/client/*` 映射到插件目录的 client/ 子树（**只暴露这个子树**——manifest 与服务端 index.mjs 可能含凭据，绝不下载；id 校验 + resolve 前缀防穿越）。dev 模式 vite 已代理 /plugins。

## 真实插件

| 插件 | 目录 | 说明 |
| --- | --- | --- |
| demo-mailbox | `dev/plugins/demo-mailbox/` | 内存邮箱 demo，plugin-test 夹具 |
| webmail | `dev/plugins/webmail/` | 📬 网页邮箱，IMAP/SMTP 邮件管理 |
| vscode-editor | `dev/plugins/vscode-editor/` | 📝 编辑器 + SSH（原独立插件合并） |
| db-client | `dev/plugins/db-client/` | 🗄️ 数据库连接管理（mysql2/pg/mssql/sqlite/mongodb/redis） |

## 回归测试

| 测试文件 | 端口 | 说明 |
| --- | --- | --- |
| `plugin-test.mjs` | 8978 | 清单推送 / message 回环 / 静默丢弃 / 静态服务 / 路径穿越拒绝 |
| `plugin-http-test.mjs` | 8981 | host.route 全链路（GET/POST/404/500） |
| `plugin-bgtask-test.mjs` | 8982 | registerBackgroundTask 全链路 |
| `plugin-settings-test.mjs` | 8983 | 声明式设置 schema 校验/持久化/回显 |
| `plugin-cwd-test.mjs` | 8989 | set_cwd→notifyCwd→广播全链路 |
| `plugin-update-test.mjs` | — | install/check-updates/rollback 全链路 |
| `ssh-plugin-test.mjs` | 8964 | SSH 远程文件/终端全链路（mock SSH 服务端） |
| `db-client-test.mjs` | 8968 | SQLite 全链路协议冒烟 |
| 单测 `plugin-facilities.test.ts` | — | storage/secrets/deps/apiVersion 门控 |
| 单测 `plugin-settings.test.ts` | — | schema 解析/校验/持久化 |
| 单测 `plugin-updater.test.ts` | — | 备份/回滚/prune/资源解析 |

## 原生 MCP 管理

设置页「原生 MCP」编辑 `<agentDir>/mcp.json` 或 `<cwd>/.pi/mcp.json`，保留未知字段，按文件 SHA-256 校验版本后原子保存。headers、env、secret/token 字段以掩码下发；原掩码保留，替换字符串或删除字段修改/清除。项目 provider auth 被拒绝；项目保存不授予信任，「信任当前项目」调用官方 ProjectTrustStore，并在 reload 时更新 SettingsManager 信任状态。

配置变化对所有已加载会话应用：空闲会话立即 reload，运行会话按 conversationId 延迟到 agent_settled。连接状态、登录、退出、重连执行 sourceInfo 属于 builtin:mcp 的官方命令；替换命令明确不可用。OAuth 链接以 HTTP(S) 链接显示，回调输入/取消走扩展 dialog；重连重放待答 dialog。旧桥保持 data-dir/mcp.json 独立配置。

界面插件只提供 Web 展示及用户交互，不向代理注册工具、斜杠命令或提示词。代理扩展和 MCP 由 pi 原生配置加载。

### Pi 1.0.1 MCP / Codemode 工作台

设置页「MCP 与 Codemode」直接维护原生配置，连接状态按需要处理的项目优先排序。全球/项目范围分别使用自己的文件版本；新增、导入、启停、暴露方式、单工具覆盖和高级 JSON 都先进入草稿，再明确保存。导入支持 Claude/Cursor、VS Code 和 OpenCode JSON，拒绝重名覆盖及未转换的 `${input:...}`。Codex TOML 需要先转换为 `mcpServers` JSON。

1.0.1 的项目覆盖允许 `.pi/mcp.json` 中只写 `enabled`、`exposure`、`toolExposure`，沿用同名全局服务器的连接和凭据。Web 服务按 SDK 的规则校验覆盖，不复制凭据、不隐式授予项目信任。项目范围中可以为当前运行的全局服务器新增启停覆盖。

官方 `/mcp` 在 RPC 模式输出连接状态，但会等待首次后台连接完成。Web 以每会话缓存、单飞查询适配此接口：配置立即返回，浏览器每 3 秒刷新；首次尚无状态时显示连接中，不阻塞输入。连接完成后使用官方状态，不从工具数量推断成功。完整原生诊断可展开；SDK 未提供结构化的额外 scope 状态，因此统一显示「需要登录」，不会猜测请求的权限。登录/退出/重连仍调用官方命令，远程 OAuth 回调与取消走原生 WebUI dialog。工具名称、annotations 和实际 exposure 来自 `session.getAllTools()`；单工具覆盖另写原生 `toolExposure`。

`codemode.mode`、`codemode.inlineBudget` 写入对应范围的 `settings.json`，保留未知字段并独立校验文件版本；界面显示当前会话实际生效值。`autoEnableCodemode` 写在 `mcp.json`，不代替 `defaultTools`，关闭自动启用不会关闭已经启用的工具。全部变更复用运行中会话的 `agent_settled` 延后 reload。`mcp.log` 按用户点击读取末尾 32,000 字符。

### 原生 Codemode 卡片

`server/codemode-presentation.ts` 对 SDK `CodemodeToolDetails` 做展示字段白名单：calls（含模型调用）、status、durationMs、cost、error、fullOutputPath。完成记录随 `UiMessage.codemode` 下发，执行中随 `tool_delta.codemode` 下发；不向模型加入任何消息。每张卡最多传输 256 条调用，保留实际总数并提示省略；默认展示最后 8 条，可展开其余已传输调用。旧 transcript 没有 details 时回退到 `nestedCalls`。

卡片提供调用／脚本／输出页签，费用仅汇总 SDK 实际报告的值；没有费用时不显示虚构的 $0。脚本错误保留输出及调用列表，并提示已执行调用不会撤销。1.0.1 在输出超过 16 Mi 字符或 100,000 项时失败；界面原样呈现 SDK 错误。`max_output_tokens` 导致文本截断时，仅展示 SDK 实际提供的 `fullOutputPath`，不假定每种失败都有完整输出文件。

图片保持原生结果的 data URL；「附加到下一条消息」使用现有图片附件路径，用户发送前不进入上下文。「保存到当前目录」走鉴权及同源保护的 `/api/codemode-image`，校验活动工作区与图片签名，以随机文件名、`wx` 创建，不覆盖已有文件；单张保存上限 6 MiB。保存是用户文件操作，不注册额外工具，也不把生成结果自动注入下一轮。图片超过此保存上限时仍可使用浏览器图片下载。

验证：`codemode-mcp-test.mjs`（9204/9205、隔离配置和工作区、本地 mock 模型）验证真实 SDK 状态、凭据掩码、CAS、项目覆盖、配置生效、实时调用、部分失败、输出限制和图片安全；加 `--browser` 校验实际卡片、图片操作及设置交互。`native-tools-desktop-test.mjs` 覆盖 Node/Electron 的原生工具执行，`native-features-browser-test.mjs` 覆盖历史回退及 OAuth 界面。相关纯函数测试在 `tests/unit/codemode-presentation.test.ts`。

原生 Pi 包与 standalone 扩展由设置 › Extensions 管理，接口、过滤恢复、作用域、目录与编辑规则见 [Extensions 架构](architecture-extensions.md)。这里的界面插件仍是独立的展示插件系统。
