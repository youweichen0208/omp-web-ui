# OMP 运行时

修改运行时、队列、工具、模型配置或打包时先读本文。版本以 package.json 的精确依赖为准。

## 进程与职责

Node/Electron 负责 HTTP、WebSocket、PTY、文件和 SSH。每个会话由一个内置 Bun 子进程运行 Oh My Pi，Node 不加载 OMP 的运行时代码。`server/omp/` 是宿主接口；`omp-worker/` 是 Bun 入口。

- `session.mjs` 调用 OMP 公开的 `createAgentSession` 与 `runRpcMode`，无需预先配置模型即可进入首次设置。
- stdin/stdout 使用 OMP RPC v2；工具回调与交互响应采用官方协议。继承的 Node IPC 通道使用 JSON 序列化，承担初始化、历史投影、应用自定义消息和工具开关，不监听网络。管理消息仍经过分块和大小校验；避免 Windows 下将双向管道同时交给 fs.ReadStream/WriteStream 导致响应停滞。
- Bun 二进制从本包依赖解析，不能依赖用户 PATH。插件管理需要的 `bun` 名称由应用配置目录中的 runtime-bin 提供。
- RPC 有启动/请求超时、帧大小限制、分块校验、UTF-8 增量解码；进程失败拒绝挂起请求，关闭时先终止再强制退出。
- `compat.mjs` 修正固定 OMP 版本中 ratchet/prelude 的 Bun 模块解析冲突，以及 Windows 跨盘配置根目录的 join/resolve 差异。升级依赖时验证是否仍需要该补丁，禁止修改用户或 node_modules 中的源文件。

## 会话边界

OMP 是执行与持久化的唯一事实源。宿主不修改 Agent 私有字段、不重写原生 bash/todo、不安装旧 Pi 的停止 hook。每个 Web 对话拥有独立子进程，项目切换复用对应对话。

`agent_end` 只说明一次模型运行让出执行权。异步子代理可能继续工作；任务结束、目标审查、自动标题以 `session_settled` 为准。独立调研/审查任务等待 `prompt_result`，若其 `sessionSettled` 为 false，继续等待 `session_settled`。取消由 OMP 中止整个运行；命令卡片的停止按钮具有同样语义。

消息完成事件通过管理管道携带递增 revision，历史快照同步读取消息与 revision。宿主丢弃已包含在快照中的追加，防止事件与快照交错时重复显示。UI 序列化仍保持消息 ID、内容缓存和快照 rev 链。

思考耗时在 Bun 工作进程收到原生思考事件时测量，随完成消息传回并持久化。宿主事件队列或两条通道的延迟不能改变已完成的测量结果。

附件使用一条原生用户提交：问题、文件上下文和图像原子排队。`prompt-content.ts` 只将原始用户记录投影为 Web 附件卡，不维护第二份执行队列。steer、follow-up、压缩、分支、历史恢复均交给 OMP。视觉桥缩略图存入原生 custom entry，仅用于 UI 投影；主模型只收到转写文本。Web 管理视觉桥开关，并禁用 OMP 的重复附件转写，以免关闭后仍调用视觉模型。

原生 MCP、LSP、技能、扩展与子代理由 OMP 发现和执行。Web UI 模式允许 MCP 延迟发现，避免首次打开等待远端服务器。终端开关只修改指定宿主工具，保留已启用的原生/动态工具。SSH 会话使用严格工具白名单，仅开放 remote_command/read/write；禁用本地工具、MCP、LSP、扩展及技能发现。

## 配置与凭据

新配置目录为 `~/.omp/agent`（`OMP_WEB_AGENT_DIR` 可覆盖），Web 状态为 `~/.omp-web`，桌面状态为 `~/.omp-web-desktop`。不导入或改写 `~/.pi` 和旧应用状态。工作进程不继承旧 profile 与 XDG 数据重定向，避免显式隔离目录意外读到别处的状态。

- OMP 配置使用 config.yml、models.yml（兼容已有 models.yaml），会话使用原生 sessions 目录及索引。
- 内置服务商 API key/OAuth 由 OMP SQLite 凭据存储管理。自定义服务商遵循 models.yml 原生 schema；密钥写入该文件，文件权限 0600。无需认证的本地模型显式设置 `auth: none`。
- Node 用短生命周期 Bun 管理进程读写配置、列模型、处理凭据、生成标题和视觉转写。凭据通过 stdin 私有管道传递，不进入 argv；模型目录和浏览器配置响应剥离 API key 与 headers。
- 保存模型先写候选 YAML，经原生 ModelRegistry 校验后原子替换。空白密钥输入保留已存值；清除内置 API key 不删除 OAuth 登录。

## Todo 与界面

OMP 原生 todo 管理 phases/tasks；状态包括 pending、in_progress、completed、abandoned、blocked。`todo-progress.ts` 读取成功工具结果以及原生 user_todo_edit 分支记录。phase/content 生成仅供展示的稳定 ID；内容重命名相当于新展示项。

`init` 建立新清单身份，空清单重置展示；失败或 view 不伪造完成。聊天继续使用合并清单、变化行和定位高亮，阻塞项显示 blocker，右栏展示完整当前清单。旧格式解析只用于展示，不再加载 rpiv-todo。

官方 UI RPC 通过 WebUIContext 转为通知、状态、widgets 和可取消对话框；editor 支持多行预填。多个对话框按 ID 排队，取消只移除对应请求。set_editor_text 按 conversationId 填充草稿。原生子代理的生命周期与进度随所属会话快照展示。

## 构建与验证

npm 包和桌面包必须包含 dist、web/dist、omp-worker、OMP 的源资源及当前平台 Bun/native 可选依赖。禁止对整个依赖树执行 Electron rebuild：仅对 node-pty 重建，OMP 原生依赖运行在 Bun 中。

基础验证：typecheck、build、unit、协议冒烟。`omp-runtime-test.mjs` 验证真实 RPC；`omp-session-test.mjs` 用本地模拟 API 验证两种工具注册、原生 todo、附件、凭据和恢复；`mcp-bridge-test.mjs` 验证原生 MCP。

`packaged-server-start-test.mjs` 使用打包后的 Electron 与 Bun 执行同一会话集成测试，再验证 SQLite worker、HTTP 页面。测试不得回退到仓库依赖；macOS、Windows、Linux 分别在原生 runner 上验证后才能发布。
