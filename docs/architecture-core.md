# 核心架构

## 原生上下文边界

会话由 pi 1.0.2 原版 SDK 创建。WebUI 只桥接用户输入、原生事件和界面交互；不追加宿主系统提示词，不注册自定义代理工具，不覆盖原生 bash，不注入终端状态消息。原生配置文件、技能、用户扩展和官方 MCP/Codemode/tool_search 由 pi 加载。WebUI 设置支持显示偏好、界面插件可见性及原生配置管理；Extensions 管理用户明确选择的包，不添加宿主工具或提示词。系统提示词页编辑用户选择的原生 SYSTEM/APPEND/上下文文件，空闲时原生 reload，下一次请求由 SDK 应用变化；来源、文件校验与运行中保存见 [系统提示词架构](architecture-system-prompt.md)。新会话、切换、恢复和重载共用同一个原生运行时工厂。历史 transcript 不会改写。

> 改代码前必读。本文档覆盖快照驱动、协议单源、安全边界、多对话并发等全局架构决策。

## 快照驱动

Pi 1.0 工具结果的 `nestedCalls` 投影为独立子调用记录（参数、状态、耗时与错误），不会伪造成顶层助手调用。工具返回的 image 块作为图片保留；工具执行增量和结束事件传递 `parentToolCallId`。虚拟模型快照保留用户选择的 `model` 并附带 SDK `session.routedModel`，模型控件显示实际路由。

模型编辑器只修改聊天模型和表单拥有的字段；保存时保留 image/classifier 条目、operations、headers、采样及其他未知字段。不同 operation 可以使用相同模型 ID。已保存的密钥不回传表单，留空表示保留服务器上的密钥。`model-config-preservation-test.mjs` 覆盖实际读写路径。

账号登录由 `server/provider-auth.ts` 桥接公开 `ModelRuntime.login/logout`。浏览器仅收到授权 URL、设备码或请求提示，凭据由 SDK 保存；响应同时匹配 requestId/promptId，取消和 dispose 中断待处理请求。OpenAI ChatGPT 登录的稳定设备 ID 来自 SDK SettingsManager。模拟 OAuth 回归不证明真实账号授权成功；浏览器回归验证授权码提交、取消及中英文展示。

- **服务端是唯一事实源**：每次 SDK 事件后节流 60ms 推快照（`UiState`），浏览器只按快照渲染。重连只需重发 `get_state`。
- **增量快照（协议 v2）**：持久化消息内容不可变 + 对象引用稳定，`emitSnapshotNow` 用 O(n) 指针等同性遍历检测追加式增长——能追加则发 `snapshot_delta`（轻字段 + `appended` 尾部，baseRev 链），中途变更/截断/切会话/强制 resync 回落全量 `snapshot`。前端 reducer 按 rev 链合并，缺口触发防抖 `get_state`；背压下 delta 与 snapshot 同样可丢弃，丢包靠 rev 链断裂自愈。`get_state` 恒返全量。回归：`snapshot-delta-test`。**测试适配**：等「动作后快照」的测试必须同时接受 snapshot_delta（参照 conv-cwd/vision-bridge 的 rev 链合并写法）；连接后的首个快照恒为全量。
- **WS permessage-deflate**：WebSocketServer 开启压缩（threshold 16KB），大会话多 MB snapshot 线上传输降数倍；小消息（notice/心跳）不压省 CPU。
- `/reload` 使用带 `conversationId`、`requestId` 的 `reload_status` 事件发送运行中及完成状态，包含资源数量、名称、耗时和加载诊断；前端按请求更新同一条对话事件，不通过通用 notice 浮层。事件保存在当前标签页的 sessionStorage，刷新后仍可查看，不写入 Agent 上下文。
- **多标签页序列化共享**：emit 把同一消息对象发给客户端的所有 socket，index.ts 用 WeakMap 按对象身份缓存 stringify 结果——N 个标签页共享一次序列化，新 snapshot 即新对象自动失效。
- 序列化时**对象引用稳定**：`uiMessageCache` + 消息数组签名比对，消息没变就不重建数组，前端 `React.memo` 因此能跳过整条消息——**不要**破坏这个缓存（stable id、引用复用）。
- `UiState` 携带 `thinkingLevel`（当前生效）和 `availableThinkingLevels`（当前模型实际支持的级别，SDK 会把集合外的请求静默就近钳制——UI 只能启用这些，否则用户点"低/中"看起来"改不了"）。

### `message_delta` 实时增量通道

`message_update` 事件 → 只对**活动对话**推 `message_delta`（`conversationId` + 每对话单调 `seq` + `messageId = stream-<ts>`（与 `serializeStreamingMessage` 的稳定 id 一致）+ 实时 usage + 剥离 `partial` 后的 thinking/text delta）。它**不经 snapshot 通道**——`send()` 背压只丢 snapshot，增量永远可达，大会话不再因背压停更。前端 `applyMessageDelta`（`web/src/message-delta.ts` 纯函数、不可变——StrictMode 双调 reducer 会把原地 mutation 加倍）patch `streamingMessage` + `stats.tokens`；seq 缺口触发防抖 `get_state` 重同步；snapshot 权威收敛。

输入框用量入口使用 SDK `getSessionStats()` 的当前上下文总量、窗口大小和累计 token 用量；每条 assistant 消息仍序列化其模型返回的 `input/cacheRead/cacheWrite/output`。弹窗只显示上下文窗口总量与缓存命中率，后者按 `cacheRead / (input + cacheRead + cacheWrite)` 计算。模型接口不返回「系统提示、工具、对话、附件」四类上下文精确值；`server/context-breakdown.ts` 保留归一化估算供协议数据使用，界面不展示分类估算。缓存数据不能推断服务商缓存失效的具体原因。

同时：delta 活跃期（1.5s 内有增量）snapshot 降为**事件驱动检查点**——agent_settled / tool_execution_end 立即 flush，其余事件走 2s 兜底定时器（增量负责流畅度、快照只做边界校准）。单测：`tests/unit/message-delta.test.ts`。

### `tool_delta` 同协议

SDK `tool_execution_update.partialResult` 是累计输出快照，服务端发送 `replace: true`，前端替换当前工具输出（包括空快照），避免重复拼接。`bash_execution_update` 才是真正的增量，保持追加。两条路径均保留浏览器输出长度上限。协议版本 22 要求旧前端刷新。

也带 `conversationId` + `seq`，与 message_delta 共享同一每对话单调序列（`conv.deltaSeq`）；前端按对话 Map 追踪 seq，仅活动对话缺口触发重同步（后台对话切回时 snapshot 收敛）。

### 协议版本协商

`hello` 可带 `protocolVersion`，`ready.serverVersion` 回带运行中 pi-web-ui 包的版本（不是 pi SDK 的 `VERSION`，底栏也显示此值）；前端比对协议不一致时显示持久刷新横幅（应用原地更新后「界面新的/WS 旧的」混跑防护）。常量在 server/ 与 web/ 各一份 protocol-version.ts，`check:protocol` 校验两份一致——改协议时必须同步 bump。

## 协议单源（types.ts 是 re-export shim，不再手工同步）

`server/protocol.ts` 是唯一事实源；`web/src/types.ts` 用 `export type * from "../../server/protocol"` 全量再导出（纯类型，构建时擦除），前端本地类型（FileListing/ToolStatus）附在 shim 下方；FileContent 直接从 ServerMessage 提取。

新增/修改任何消息：只改 `protocol.ts`，然后在 `server/index.ts` 的 `dispatch` switch 和 `web/src/use-chat.ts` 的 `onmessage` switch 各加一个分支。注意 protocol.ts 必须保持**纯类型导出**（不能加 const/function 等运行时代码，否则破坏 type-only 前提）；`npm run check:protocol` 守护这两个不变量。

## 安全边界

- **默认只绑 loopback**（`PI_WEB_HOST`，默认 `127.0.0.1`）：本地个人工具不暴露到网络；局域网/容器需显式 `PI_WEB_HOST=0.0.0.0`（docker-compose.yml 已内置，Docker 端口映射才能工作）。
- **WS 升级做 Origin/Host 同权威校验**（`server/index.ts` 的 `originAllowed`，`WebSocketServer({ noServer: true })` + 手动 `handleUpgrade`）：Origin 存在时其 hostname+**有效端口**必须与请求 Host 一致（浏览器里 `example-host:8445` 与 `example-host:9443` 是不同源）；非浏览器客户端（无 Origin）放行；`PI_WEB_ALLOW_ORIGINS` 白名单绕过（dev:server 已内置 `http://localhost:5173,http://127.0.0.1:5173`，反代场景自配）；`PI_WEB_ALLOW_HOSTS` 可选严格 hostname 白名单。**不要**加回「本地任意端口放行」——那正是提案要修的洞。
- **quiesce 准入控制**（`AgentService.quiesce/unquiesce`）：进入排空后**拒绝一切新工作**——新 prompt（native slash 命令例外，纯配置无 token）、new_chat、edit_message fork、switch_session；存量运行继续跑完。已知 clientId 仍可 attach 看存量（发 notice 提示），**全新客户端 attach 抛 `QuiesceRejectedError` → index.ts 以 4403 关 WS**，浏览器重连循环在 unquiesce 后自动恢复。
- **控制 socket**（`server/control-socket.ts`）：CLI 的 `server status|quiesce|unquiesce` 经本地 mode-0600 unix socket / Windows 命名管道（`\\.\pipe\pi-web-ui-<port>`）与运行中进程通信，`status` 报告真实 socket 数（`noteSocketOpen/Close`，index.ts 维护）、active/pending 计数、quiesce 状态；无鉴权 HTTP 端点。
- **provider headers 不下发浏览器**（`models_config` 不再携带 `headers` 字段，可能含 Authorization/API key）：`saveModelConfig` 保存时若 config 无 headers 则保留旧值（`prevHeaders`）。`UiProviderConfig.headers` 已从 protocol.ts / types.ts 删除，前端没有任何地方编辑 headers（仅 apiKey 经独立消息 `set_provider_api_key` 走浏览器）。
- **dev 兼容**：vite :5173 代理 /ws 到 :8788 时 Origin(:5173) ≠ Host(:8788)，靠 `PI_WEB_ALLOW_ORIGINS`（dev:server 内置）放行，勿删。

## 主题

只有一套固定主题，写死在 `web/src/styles.css`（浅色底 + Inter/IBM Plex Mono 自带字体 + 深色代码/终端区块），没有主题选择、切换事件、`/api/themes` 路由或用户自定义主题目录。`web/src/theme.ts` 现在只保留 `buildTermTheme()`（把 `--term-*` CSS 变量转成 xterm 调色板）供 `TermXterm.tsx` 在终端初始化时读取，以及一个未使用的 `THEME_CHANGE_EVENT` 常量占位。

## 多对话并发

- 每客户端 `convs: Map<convId, Conversation>`，**每个对话一个独立 `AgentSessionRuntime`**：`new_chat` 新建 runtime + 新 session 文件（旧对话继续在后台跑，不中断）；`switch_conversation` 只换 `activeId`（不碰其他 runtime）；`runtime`/`session` 访问器指向当前活动对话。**对话按项目归属**：`conv.cwd` 即所属项目，每个项目各自的活动对话互不干扰。
- **`set_cwd` 不再重建当前对话**——改为切到目标项目自己的对话（该项目最近活动的那个；没有则新建一个并恢复该项目最近的持久会话）。
- **「运行的对话」列表生命周期**（每个对话 `listed` / `promptedSinceActive` / `lastActiveAt` 三字段）：
  - 入列：活动对话**正在流式输出时**被挤到后台（new_chat / switch_conversation / set_cwd）→ `listed=true`；
  - 留在列表：后台跑完不移出（用户可能还没看结果）；
  - 移出：打开它（切为活动）→ 没有继续对话（期间没发过 prompt）→ 切走时 `displaceActive()` 返回它，`removeConversation` 释放 runtime（会话已持久化，历史列表仍可恢复）。
- 上限 `MAX_OPEN_CONVERSATIONS = 8` **按项目计**，超出时 new_chat 发 warning notice。
- 所有对话共享**一个 ModelRuntime**（首个对话创建时播种，`makeRuntimeFactory` 传入复用）——顶栏换模型对全部对话生效。**消息序列化缓存（msgIds/uiMessageCache/签名）按对话隔离**：两个对话可能产生相同的 (role, timestamp) 键，共享会串号。
- `snapshot` 带 `conversationId`；`conversations`（ServerMessage）推当前活动对话及当前项目已入列的后台对话。新对话尚未落盘时，活动项仍可在左栏显示；`switch_conversation`（ClientMessage）只在同项目内切换。
- `switch_session`（恢复持久会话）会为目标会话创建独立 runtime，再按上述生命周期把当前对话移到后台；若目标会话已在运行列表中则直接复用其 conversation，绝不因打开历史记录中断当前生成。回归测试：`tests/switch-session-background-test.mjs`。`edit_message` 在**当前**对话内 fork；`dispose` 遍历销毁全部对话；attachSink 重连时补推 conversations。
- 前端：左栏「运行的对话」区（≥1 个时显示，活跃高亮、流式绿点），MessageList 以 conversationId 为 key 强制切换重挂载。
- `/new` 直接调用 SDK `runtime.newSession()`：生成新的 SDK 会话 ID 和文件路径，旧会话历史与标题保留，可手动恢复；新会话的消息、上下文、用量和任务从空状态开始。Web 只复用 conversationId、终端并同步模型与思考档位，不复用旧会话文件、不自建重置分支、不扣减 SDK 统计基数。“新对话”按钮创建独立 runtime，允许原对话在后台继续。`/compact` 直接调用 SDK `session.compact(args || undefined)`，压缩规则与摘要由 SDK 负责。`conversations.activeId` 先于新快照到达时，消息、用量和任务进度只展示与活动对话 ID 匹配的快照；等待期间禁止发送，并安排 `get_state` 补取快照。回归：`tests/new-chat-context-test.mjs`（mock 模型 + 浏览器延迟快照，零 token）；`tests/native-session-commands-test.mjs` 复用无浏览器模式进入 CI，校验新会话身份、旧历史保留、取消、重复新建及重新打开。

## 其他桥接

### 工具结束实时状态（`tool_status`）

服务端 `onEvent` 监听 `tool_execution_start/end`（AI 调工具路径，注意区别于 `bash_execution_update`——那是 `!cmd`/终端直接执行路径专属）。`tool_execution_end` 触发时立即推 `tool_status`（toolCallId/toolName/isError/exitCode/durationMs），**先于** toolResult 快照落盘——浏览器 tool 卡片随即从「执行中」切到「已结束 · 等模型 · 耗时」，一眼区分「命令还在跑」vs「命令完了在等模型响应」。退出码统一优先读取 `structuredContent.exit_code`（含 0），其次是旧 `details.exitCode`，仅旧错误结果回退文本正则；`tool_execution_start` 时刻记在 `conv.toolStartTimes`（按对话隔离）算真实执行耗时。前端 `toolStatuses` Map 在 toolResult 落盘（snapshot prune）后清除，回落到权威的 toolResult 状态。

### 模型／工具静默状态（`agent_silence`）

服务端在运行中连续 3 分钟没有 SDK 事件时，按 `conversationId` 推送 `agent_silence`，并根据正在执行的工具区分模型等待和工具运行。任意后续 SDK 事件会发送 `active` 清除状态；重连时重放仍有效的静默状态。浏览器把它放在输入框上方的状态行，同步输入框和底栏，并持续更新时间。浏览器只为纯文本、无工具调用的模型静默轮次提供用户点击的手动重试；宿主不自动重发。前后端排除原生压缩和重试阶段，服务端核对当前用户轮次及工具记录，中断后再次检查归属才发送。WebSocket 心跳只表示浏览器与本机服务连接正常，不代表模型接口已响应。

### 当前任务进度（`taskProgress`）

服务端只在当前用户轮次至少调用一次工具后，从权威 transcript 推断当前任务；纯聊天没有任务卡。相邻工具调用组成步骤，工具结果决定完成或失败；流式回复期间工具已完成但模型尚未继续时保留“正在分析请求”步骤。短句“继续”等沿用上一条实际任务请求作标题。任务耗时从用户消息时间算到 `agent_settled`；恢复历史时用消息时间回退。`taskProgress` 随全量和增量快照传递，ID 来源于原消息 ID，切换对话不会串进度。前端将连续步骤合并为语义阶段；只有一个阶段时直接列出文件和命令，多个阶段时显示阶段列表，原始步骤展开区只保留短摘要与工具记录，不展示整段助手回复。完成结果卡只取本轮记录里实际出现的提交、测试和改动数值。文件栏不再显示“本次对话涉及”区域。

任务展示只读解析 transcript，不注册 todo 或 task_plan，不追加任务管理规则。用户通过 pi 原生配置加载的 todo 扩展可以继续显示；已有历史记录也保留只读展示。

### 工具挂死看门狗

每个 `tool_execution_start` 都会为 toolCallId arm 一个 `TOOL_WATCHDOG_TIMEOUT_MS`（默认 20 分钟，环境变量 `PI_WEB_TOOL_TIMEOUT_MS`（毫秒）覆盖）的 timer——超时仍在跑就 `session.abort()`（杀进程树）+ warning notice，`tool_execution_end` / `removeConversation` / `dispose` 都会清掉对应 timer。恢复重建 + 重绑会话（同一 conv 记录，UI 不掉线）；看门狗超时也走同一 `interruptRun`。**只停止运行，不碰后台服务**——那些由「后台任务」面板单独管理。

### 后台任务列表

bash 工具执行前后各拍一次监听快照（`snapshotListeningPorts`，Windows netstat / POSIX lsof），diff 出的新增 LISTENING 进程记入 `bgServers`（端口→pid→since→name，name 经 `lookupProcessName` tasklist/ps 尽力获取），启动后 notice 提示「可在顶栏「后台任务」里单独停止或全部关闭」；**列表按客户端持久**（ClientSession 字段，非对话级）——对话结束/切换/断线重连都不消失（attachSink 重推 `bg_servers`），只有任务被停或进程自行退出才移除（30s 定时器 `refreshBgServers` 重新对端口快照，port+pid 都匹配才算还活着，静默剔除死项）。

协议：`bg_servers`（ServerMessage，推送全量列表）/ `kill_background_server`（按端口停单个）/ `kill_background_servers`（全部关闭，`killAllBackgroundServers` 对每个 pid `killPidTree`，Windows `taskkill /F /T`）/ `list_bg_servers`（面板打开时请求刷新）；前端 `BgTasksModal`（每个任务行「停止」+ 底部「全部关闭」「刷新」，空列表有占位文案）。

### 扩展 UI 桥

每个 Conversation 独立拥有 `WebUIContext`。widgets/statuses/notice/dialog、关闭事件、临时标题和输入替换均携带 conversationId。浏览器只显示当前对话的状态和弹窗，后台请求显示项目/对话来源，点击后经既有 Wiki/文件草稿保护切换。标题不改持久会话名称。

弹窗 ID 使用 UUID。响应必须属于活动对话和当前 UI 上下文，且值符合请求类型；缺失归属、过期、重复、跨对话响应无效。协议 v35 要求旧页面刷新。select/confirm/input 支持 signal/timeout，confirm 取消返回 false，其他返回 undefined；提前 abort 不发弹窗，每个结束路径清理监听器/timer。editor 使用多行确认；custom 立即返回 undefined；getEditorText 返回空字符串。setEditorText/pasteToEditor 只替换所属对话草稿，不发送消息；浏览器按事件 ID 消费一次。

断线不解决服务端请求。重连重放仍有效的弹窗、widget、status 和标题；浏览器重建展示状态。reload、会话替换及 Wiki/普通对话释放时取消旧弹窗、释放 widget 并使旧上下文失效。原生 reload 使用公开 beforeSessionStart/runner.setUIContext 接口绑定新上下文。

### 原生恢复状态

`recovery` 快照分别保存 compaction、auto retry 和 summary retry 的生命周期、操作 ID、原因、次数、截止时间和最长 500 字符错误。摘要重试结束只清理其子状态；agent_settled 清理整轮状态。切换及重连从权威快照恢复，恢复期间不触发静默提示或宿主重发。

普通聊天和 Wiki 显示阶段与退避倒计时。取消携带 conversationId 和 operationId，仅匹配当前操作时调用原生 abortCompaction/abortRetry/abortBranchSummary。当前对话运行菜单的自动压缩和自动重试开关保存在每实例独立的内存映射中，由 SettingsManager 的 getCompactionEnabled/getRetryEnabled 在读取时优先应用（包括显式 false）；原生 setter、reload 和信任变化不会清除覆盖，getSettings() 仍返回原生配置，新对话重新继承原生配置；切换开关不取消正在执行的操作。

### 原生工具结果与下载

serialize.ts 仅投影 edit 的 diff/firstChangedLine，以及 bash 的退出码、截断摘要和完整输出路径；diff 遵守 100,000 字符上限并标记截断。todo/codemode 保留专用投影，任意扩展字段和 structuredContent 中的完整输出正文不会透传。缓存按实际投影变化失效，消息数组按对象引用复用。

`/api/tool-output` 受通用口令鉴权，参数仅为 clientId/conversationId/toolCallId。服务端从该对话权威 transcript 查找 bash 引用，只打开工作区内普通文件或系统临时目录的原生 `pi-bash-<16 hex>.log`；验证真实路径与文件类型，拒绝符号链接逃逸。下载使用已验证的文件句柄；已清理/不可用返回 404。浏览器不提供文件路径。

`snapshot` 里 `streamingMessage` 是进行中的消息（60ms 粒度流式），`messages` 是已落盘的。

## 项目切换与展示缓存

`set_cwd` 可携带 `requestId`，服务端通过 `cwd_result` 明确确认成功或失败。界面手动切换还携带 `source: "ui"`，成功后只更新工作区状态；命令切换在目标会话的 transcript 中追加不进入模型上下文的 custom entry，快照通过 `cwdEvents` 传给前端并以居中事件显示，不弹成功通知。
同一 ClientSession 串行准备和提交项目切换；尚未开始的请求合并为最后一次选择，
被替代请求收到 `superseded`。目录校验、运行时创建和扩展绑定成功后才改变活动会话。
切换期间前后端均阻止会话操作；前端允许继续选择项目和请求权威快照。
成功提交优先推送全量快照及确认，再刷新项目相关目录。文件树由可见面板请求。

`use-chat` 的 reducer 始终保存权威状态，展示层临时覆盖目标项目的消息、历史和文件列表。
`project-cache.ts` 是内存 LRU：最多 3 个项目，以 JSON UTF-16 长度估算总预算 32MiB，
单项超预算不保留；刷新页面后重建。缓存不参与快照 rev 或消息增量校验。
只有匹配最新请求的确认及目标权威快照到达后，才恢复操作。失败显示重试入口。
断线撤销待确认展示，重连重新请求权威状态。

`sessions`、`files`、`file_content`、`scm_data`、`search_files_result` 携带捕获于请求开始时的
`cwd`，前端丢弃旧工作区结果。查询缓存复用进行中的扫描：项目 30 秒、历史 5 秒，
过期时先返回缓存并后台刷新；历史查询缓存上限 24 个项目、每项目 200 条摘要，项目列表只缓存路径/时间聚合，不保留 SDK 的全文检索字符串。项目按最近使用或对话活动时间排列；再次打开会移到前面，历史的首次添加时间只用于同一时间的排序。新建、删除、重命名会话及移除项目清除相关缓存。
文件扫描仅合并进行中的相同工作区/路径请求，不缓存文件内容。

聊天输入草稿和附件按会话隔离；文件编辑草稿按工作区/路径保护离开（见 architecture-attachments.md）。消息列表保留有限的滚动位置、折叠状态及窗口化高度数据，
不保留各项目的消息 DOM。终端、Git、插件宿主首次访问后才挂载；隐藏文件栏停止
轮询，隐藏 Chat 跳过消息列表更新，隐藏终端继续接收输出，仅在显示时适配尺寸。

回归：`tests/project-switch-test.mjs`（隔离真实服务及 Chrome，固定短/长会话、延迟确认、
缓存内容首帧、草稿与视图保留），`tests/project-switch-electron-test.mjs`（隔离桌面壳），
`tests/unit/project-cache.test.ts`（LRU、预算、扫描合并及失效）。

## Wiki 文档工作区

Wiki 复用当前工作区，使用原生内存会话，离开后释放，不写入聊天历史；返回普通聊天时创建普通原生会话。输入范围可查看，文件改动记录保存在界面数据目录。修改用户消息构建、任务结束记录或文件恢复时读 [Wiki 架构](architecture-wiki.md)。
