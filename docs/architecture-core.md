# 核心架构

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
- **quiesce 准入控制**（`AgentService.quiesce/unquiesce`）：进入排空后**拒绝一切新工作**——新 prompt（native slash 命令例外，纯配置无 token）、new_chat、edit_message fork、switch_session、goal wizard；存量运行继续跑完。已知 clientId 仍可 attach 看存量（发 notice 提示），**全新客户端 attach 抛 `QuiesceRejectedError` → index.ts 以 4403 关 WS**，浏览器重连循环在 unquiesce 后自动恢复。
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

服务端 `onEvent` 监听 `tool_execution_start/end`（AI 调工具路径，注意区别于 `bash_execution_update`——那是 `!cmd`/终端直接执行路径专属）。`tool_execution_end` 触发时立即推 `tool_status`（toolCallId/toolName/isError/exitCode/durationMs），**先于** toolResult 快照落盘——浏览器 tool 卡片随即从「执行中」切到「已结束 · 等模型 · 耗时」，一眼区分「命令还在跑」vs「命令完了在等模型响应」。bash 工具的 details 不带 exitCode（成功时返回 truncation 信息，失败时错误文本含 `Command exited with code N`），服务端从错误文本正则提取；`tool_execution_start` 时刻记在 `conv.toolStartTimes`（按对话隔离）算真实执行耗时。前端 `toolStatuses` Map 在 toolResult 落盘（snapshot prune）后清除，回落到权威的 toolResult 状态。

### 模型／工具静默状态（`agent_silence`）

服务端在运行中连续 3 分钟没有 SDK 事件时，按 `conversationId` 推送 `agent_silence`，并根据正在执行的工具区分模型等待和工具运行。任意后续 SDK 事件会发送 `active` 清除状态；重连时重放仍有效的静默状态。浏览器把它放在输入框上方的状态行，同步输入框和底栏，并持续更新时间。浏览器只为纯文本、无工具调用的模型静默轮次提供自动重试；服务端再核对当前对话及工具记录，先完成中断再重新发送，以免重复执行工具副作用。WebSocket 心跳只表示浏览器与本机服务连接正常，不代表模型接口已响应。

### 当前任务进度（`taskProgress`）

服务端只在当前用户轮次至少调用一次工具后，从权威 transcript 推断当前任务；纯聊天没有任务卡。相邻工具调用组成步骤，工具结果决定完成或失败；流式回复期间工具已完成但模型尚未继续时保留“正在分析请求”步骤。短句“继续”等沿用上一条实际任务请求作标题。任务耗时从用户消息时间算到 `agent_settled`；恢复历史时用消息时间回退。`taskProgress` 随全量和增量快照传递，ID 来源于原消息 ID，切换对话不会串进度。前端将连续步骤合并为语义阶段；只有一个阶段时直接列出文件和命令，多个阶段时显示阶段列表，原始步骤展开区只保留短摘要与工具记录，不展示整段助手回复。完成结果卡只取本轮记录里实际出现的提交、测试和改动数值。文件栏不再显示“本次对话涉及”区域。

任务清单由随包固定版本的 `@juicesharp/rpiv-todo` 原生扩展提供。`server/todo-extension.ts` 通过资源加载器追加包入口，保留上游 `todo` 工具、`/todos` 命令和会话恢复；替换引导词以遵循用户与 skill 的澄清/等待流程，禁用 TUI overlay 和快捷键，由 Web 任务区统一展示。重复安装的同包扩展只保留首份。`task_plan` 不再注册，旧 transcript 的计划解析仍保留。

`server/todo-progress.ts` 从 SessionManager 当前分支读取 `todo` 工具结果的 `details.tasks`，按分支末端缓存，跨轮次及压缩后仍可恢复。任务状态以成功快照为准，`details.error` 的拒绝更新不改变状态；一轮结束不会自动完成未完成项，界面显示“等待继续”。`/new` 更换 SDK 会话，任务随之清空。`clear` 开始新的清单并隔离重复使用的数字 ID。步骤的执行记录按工具调用顺序关联，保留文件和命令入口。上游负责修改与校验，本地只读投影，不维护第二份可修改清单。

Pi SDK 的 `agent_end` 是单次代理循环结束，后续扩展消息仍可能触发继续执行。宿主保存该事件的消息，在整个活动的 `agent_settled` 才结束任务计时、生成标题、触发目标审查并应用延迟设置；附件队列模式也在此时恢复。

`server/tool-call-recovery.ts` 处理模型把完整 `<invoke name="工具">` 写进正文却返回 `stop` 的情况。宿主在扩展事件处理之后识别候选，但不立即入队。运行时通过 `resourceLoaderOptions.extensionFactories` 注册官方 `agent_before_settle` 处理器，`bindSession` 只启用当前会话的纠正状态。边界在原生重试、压缩与扩展 `agent_end` 处理之后执行；已有边界条目、继续请求、真实消息队列和取消信号优先。原生队列已消费的新指令同样会使候选失效。解绑只停用纠正状态，保留其他扩展处理器；reload 会重新注册工厂。格式纠正不依赖 todo 是否存在、是否在当前轮设置 in_progress：任务清单是进度记录，不是工具协议恢复的前置条件。每个 SDK run 最多追加 3 次纠正提示，用户插队不会重置计数。一次纠正后，只有出现成功的原生工具结果，才能为后续新的格式错误再申请纠正；连续伪调用、单纯口头承诺、工具报错（包括 todo 的 details.error）不会补充机会。有排队消息或用户停止时让出执行权。提示要求模型遵守当前用户与 skill 的等待、确认和停止要求，由模型通过正式工具接口决定下一步，宿主绝不解析执行正文参数。

检测保留 Markdown 边界，排除围栏、缩进、行内代码、引用和列表中的示例；真正工具调用、错误、取消、普通等待回复均不触发。补充一种严格限定的继续场景：最近未解决的对话含可识别的伪调用，用户发出短句“继续”等明确继续指令，而模型只以短句承诺继续核实等工作并返回 stop，本轮没有真正调用过工具时，可请求一次纠正。该判断从当前分支 transcript 读取，恢复历史后同样有效；不跨越其他用户指令、扩展消息、真实工具结果、成功恢复或取消记录。不会仅凭未完成 todo 或任意普通文本启动新一轮。识别范围有意限定，不能保证所有模型输出都能被纠正。

纠正状态作为带结构化 `details` 的 custom message 持久化，前端按语言渲染。目标工具成功返回才标记“工具已恢复”（不代表参数语义正确或整个任务完成）；连续无进展的伪调用记录失败，单纯口头说继续记录未确认，停止记录已停止。正式工具已调用但执行报错或超时单独记录 `tool-error`，提示先核实操作是否生效；随后出现成功的工具结果可为新的伪调用重新申请纠正，但不会直接重放超时命令。达到整轮 3 次上限记录 `exhausted`，最后的正文调用保持未执行。未自动继续的提示通过 `reason` 区分已有排队消息和新指令打断；旧版没有 reason 的记录使用历史说明，不误报为当前有排队消息。相同毫秒的 custom 消息缓存同时区分字符串正文、customType、display 与 details，避免覆盖扩展消息。回归 `tests/tool-call-recovery-test.mjs` 用本地模拟模型驱动真实 SDK 和原生 todo，覆盖无 todo、首个伪调用、历史恢复后的继续、真实 bash 超时后检查成功再纠正、连续工具失败、整轮预算、等待确认、新话题、重复失败、扩展排队、用户插队及取消；端口占用直接失败，连接前验证测试子进程 PID。

`tests/tool-call-recovery-boundary-test.mjs` 补充真实 SDK 的异步准备边界：迟到的用户插队、follow-up、扩展消息、原停止 hook、解绑及工具禁用。超时回归还检查已产生的文件副作用未被宿主重复执行；这不保证真实模型不会自行重复命令，执行前核实状态仍由模型负责。

每项使用 subject/description/status/blockedBy；首项 metadata.title 和 metadata.completionCriteria 对应整体标题与完成标准，修改项 metadata.changeSummary 用于变更说明。建议 3–7 个实际步骤，按任务调整；问答、小修改和澄清不强制建实施清单。正在执行任务保持一项 in_progress，等待用户回答不自动 completed。已完成项按上游状态机不能重开，追加后续项；开始不同任务时 clear。依赖关系用于显示等待项，执行许可仍由用户与 skill 决定。

没有 todo 的旧会话继续使用当前轮次工具阶段推断；旧 task_plan 完整提纲仍可展示。todo 的完整原始 details 不经消息序列化发送浏览器；右栏使用结构化 taskProgress，聊天使用 `UiMessage.todoSnapshot` 的精简投影（action/error、任务 id/subject/status，不含 metadata、params 或 description）。该字段为可选增量能力，旧结果缺失时保持普通工具行。协议版本 24 增加 waiting 状态与 todo 来源、清单标识和依赖字段。

`web/src/todo-presentation.ts` 按工具调用顺序投影聊天清单：跨 assistant/toolResult 消息边界合并连续成功更新，正文、其他工具、用户消息及失败/未结束调用切开更新段；思考块保留，但不切开清单更新段。首个非空快照建立展开卡片，卡片反映该清单最新的成功状态，之后每段只记录相对段首的变化，未变化的 list/get 隐藏。clear 冻结旧卡片并重置身份，新清单即使复用数字 ID 也使用新卡片。失败调用保留原始错误展示。右栏依旧使用服务端权威清单；前端仅做展示，不修改 transcript 或执行状态。`TodoChecklist` 的“查看”沿用 `pi:jump-tool`，携带变化项 ID；MessageList 先展开并固定历史消息，再定位、聚焦并短暂高亮具体任务项。回归：`todo-presentation.test.ts`、`todo-chat-browser-test.mjs`。

### 工具挂死看门狗

每个 `tool_execution_start` 都会为 toolCallId arm 一个 `TOOL_WATCHDOG_TIMEOUT_MS`（默认 20 分钟，环境变量 `PI_WEB_TOOL_TIMEOUT_MS`（毫秒）覆盖）的 timer——超时仍在跑就 `session.abort()`（杀进程树）+ warning notice，`tool_execution_end` / `removeConversation` / `dispose` 都会清掉对应 timer。恢复重建 + 重绑会话（同一 conv 记录，UI 不掉线）；看门狗超时也走同一 `interruptRun`。**只停止运行，不碰后台服务**——那些由「后台任务」面板单独管理。

### 后台任务列表

bash 工具执行前后各拍一次监听快照（`snapshotListeningPorts`，Windows netstat / POSIX lsof），diff 出的新增 LISTENING 进程记入 `bgServers`（端口→pid→since→name，name 经 `lookupProcessName` tasklist/ps 尽力获取），启动后 notice 提示「可在顶栏「后台任务」里单独停止或全部关闭」；**列表按客户端持久**（ClientSession 字段，非对话级）——对话结束/切换/断线重连都不消失（attachSink 重推 `bg_servers`），只有任务被停或进程自行退出才移除（30s 定时器 `refreshBgServers` 重新对端口快照，port+pid 都匹配才算还活着，静默剔除死项）。

协议：`bg_servers`（ServerMessage，推送全量列表）/ `kill_background_server`（按端口停单个）/ `kill_background_servers`（全部关闭，`killAllBackgroundServers` 对每个 pid `killPidTree`，Windows `taskkill /F /T`）/ `list_bg_servers`（面板打开时请求刷新）；前端 `BgTasksModal`（每个任务行「停止」+ 底部「全部关闭」「刷新」，空列表有占位文案）。

### 只停止 bash 命令（对话继续）

bash 工具卡片运行中显示「停止」→ 发 `{ type: "abort_bash" }` → `ClientSession.abortBash()`。服务端用 **killable bash 工具**（`makeKillableBashTool`，经 `customTools` 按 name 覆盖 SDK 内置 bash）：执行时把自己的 AbortController 注册进客户端级 `bashKills` 集合，abort 只杀这些 controller → bash 子进程进程树被杀（工具抛 "Command aborted"，被 agent-loop 捕获成工具错误结果）→ **agent run 与对话继续**；与 SDK `session.abortBash()`（只对扩展 `executeBash` 路径有效，agent 工具路径无效）不同，这里对对话中的 bash 工具调用真实生效。

命令被中止时 SDK 会把**终止前已输出的内容拼接进工具错误结果**（AI 能看到输出 + "Command aborted"）；随后 `abortBash()` 再 `sendUserMessage` 注入「用户手动停止」提示，让 AI 明确知道是用户手动而非失败。

### 扩展 UI 桥

扩展的 `setWidget/setStatus/notify/select/confirm/input` → `widgets/statuses/notice/dialog` 消息；对话框经 `dialog_response` 回传，Esc 视为取消。

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

## 会话自动标题

新对话发送消息时先显示截断的临时标题；在 `agent_settled` 收到成功完成的用户问答后，使用当前会话模型概括首条用户需求和助手回答。单独的 `hello`／`你好` 等寒暄保留原题，不发起标题请求。生成标题须与首条用户消息同语言、至多 12 个字符；服务端再校验语言并裁剪长度，模型输出语言不符时用首条需求作回退。工具输出和思考内容不送入标题请求；输入两侧各限 4000 字符。命名请求绑定原会话，不随前台项目切换而改变归属。

`ConversationTitleJob` 每会话只允许一个并发请求，20 秒超时，失败或模型判定应延后时最多尝试三次；成功后停止自动更新。手动改名（包括清空名字）、会话移除、强制重置和客户端释放均取消并锁定命名任务。已有 `session_info` 的历史会话不会再次自动命名。正式标题沿用 SDK 的 `appendSessionInfo` 保存，不改变持久化格式；失败保留临时标题。标题请求是额外的短模型调用，不阻塞聊天。

删除历史会话时，非当前且无后台任务/终端的缓存运行时会先取消标题请求并释放，再删除会话文件、刷新历史和运行列表；缓存命中本身不代表会话正在使用。当前会话、流式生成、排队消息、目标审查、调研向导及保留终端仍受删除保护。回归：`left-panel-delete-test`、`switch-session-background-test`。

### 组件更新

`server/component-updates.ts` 汇总运行中的 pi Agent、内置 rpiv-todo、SDK 配置的 npm/Git 包和本地扩展。设置“组件更新”通过 `check_component_updates` 获取结果；npm 查询稳定 latest（5 分钟缓存、8 秒超时、最多 4 个并发），Git 只读比较当前分支远端提交。错误与未知版本独立显示，固定版本与本地源不自动升级。检查不会执行安装。

`update_component` 只接受服务端目录中的 ID，由 SDK 包管理器按原来源更新；内置依赖随应用发布，同包多安装范围需手动处理。更新前拒绝正在运行或排队的任务，期间暂停新任务准入；Git 目录有本地改动时拒绝覆盖。更新不热替换运行中模块，安装完成后提示重启应用生效。响应携带 requestId/cwd，浏览器丢弃旧请求，项目切换后不展示旧项目结果。协议版本 25。

## 生图工作台（Pi 1.0）

`server/image-service.ts` 使用客户端共享 ModelRuntime 查询 image 模型并 generateImages。记录和图片保存在 `<dataDir>/images/<id>/`，cwd 取真实路径；不会写入工作区。历史由用户主动删除。每客户端最多一个任务，全服务最多四个；断线与切项目保留原任务。取消丢弃迟到图片，启动把 running 记录改为 interrupted。独立费用取 SDK 实际 usage，不计入聊天费用。shutdown 发出取消信号。

`image_request` 包含 requestId/cwd 和 models/create/list/detail/cancel/delete 操作；`image_result` 只传元数据。受既有 token/Origin 校验的 `/api/generated-image` 读取记录中的固定图片路径。Web 工作台按 cwd 过滤回执，定期刷新历史；下载使用 fetch/blob，附加图片沿用聊天缩放链路。Codemode 工具结果保留 SDK image blocks，并提供预览和下载。
