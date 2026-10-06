# Pi 1.0.4 原生能力审查

审查日期：2026-10-06。基线：精确锁定的 `@earendil-works/pi-coding-agent` / `pi-ai` 1.0.4；本地 macOS arm64、Node v26.0.0。本文是 [原生能力与资源审查](pi-native-resource-review.md) 的能力附录，不替代主报告的最终测试结果、资源数值和平台限制。

## 结论与证据口径

日常聊天的原生语义主要由 SDK 承担：会话工厂没有添加代理工具或宿主系统提示词，保留默认工具配置、扩展加载、原生队列和持久化。Web 与 Electron 使用同一服务端实现，因此主要适配行为一致。**不能据此认定所有原生能力都完整等价于 TUI，也不能认定所有异常恢复都可靠。** 本次动态复现了强停重建的会话归属错误、reload 结果归属错误和多入口 reload 并发；这些都是原有宿主行为，不是 1.0.4 引入的回归。

矩阵中的「完整」表示在列出的适用范围内，代码存在完整转发路径；不意味着每家服务商、每个插件或所有失败时序均经过实测。「部分」表示存在明确缺口或限制；「缺失」表示适用于 Web 的能力没有实现；「不适用」表示 TUI/独立工具包职责不属于本应用；「未验证」表示证据不足。SDK 自动继承是实现归属，和动态验证是两回事。

本附录独立运行的动态证据为 [native-reproductions.json](review-data/native-reproductions.json)，复现入口为 [pi-native-review-repro.mjs](../tests/pi-native-review-repro.mjs)；上游修复证据为 [pi-104-upstream-fixes.json](review-data/pi-104-upstream-fixes.json)，入口为 [pi-104-upstream-fixes-test.mjs](../tests/pi-104-upstream-fixes-test.mjs)。主执行线程另已确认 423 个单测和 46 个 smoke 通过，以及 system-prompt、current-file、session-tree、extension-ui、codemode-mcp、native-features 浏览器回归、Electron state/links 回归通过；最终数量和命令以主报告原始日志为准。矩阵未列入这些已执行集合的测试不能自动视为本次通过。所有本次复现均无真实模型或账号调用。

## 官方契约来源

- [SDK 公共接口](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/sdk.md)：创建会话、输入、队列、事件和资源加载。
- [AgentSession 实现](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/agent-session.ts)：prompt、agent_settled、reload、会话操作和生命周期的实际实现。
- [系统提示词构建器](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/system-prompt.ts)：selectedTools / hiddenTools、规则、技能和系统段落。
- [模板实现](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/prompt-templates.ts)：参数替换与展开顺序。
- [扩展 API](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/extensions.md)、[原生包](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/packages.md)、[设置](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/settings.md)：扩展 hooks、UI、命令、发现和配置。
- [MCP](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/mcp.md)、[连接实现](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/extensions/mcp/runtime.ts)、[Codemode](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/codemode.md)：发现、工具可见性、连接关闭、脚本执行与图片。
- [模型](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/models.md)、[认证](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/providers.md)：模型注册、类型、认证与路由。
- [1.0.4 发布记录](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/CHANGELOG.md)：版本新增和修复，作为变化索引；行为判断仍以实现为准。

本地同时读取对应 npm 包的 `dist/core/agent-session.js`、`dist/extensions/mcp/runtime.js`、Codemode worker 和官方 docs，避免只根据发布说明推断适配兼容。

## 覆盖矩阵

各行按「官方契约 → 服务端 → 协议/前端 → 测试」顺序列证据。所有 `ClientMessage` / `ServerMessage` 定义集中于 `server/protocol.ts`；前端 `types.ts` 只 re-export，未维护第二份协议。

| 能力 | 状态 | SDK 自动继承 / 宿主适配与前端 | 测试证据与动态边界 |
| --- | --- | --- | --- |
| prompt / 原生输入 hooks | 完整 | 原生 `session.prompt`；`agent-service.ts:1906` → `prompt-delivery.ts` → `prompt_result`、ChatInput | `steer-queue-smoke.mjs`、`native-session-commands-test.mjs`；真实厂商接口未枚举 |
| steer / followUp / queue mode | 完整 | `streamingBehavior` 原生调度；不重写用户 queue modes；`queue_update` 投影为两条队列 | `steer-queue-smoke.mjs`、`unit/prompt-delivery.test.ts` |
| 队列撤回与图片 | 完整 | SDK `clearQueue`；宿主按 session 补记图片，撤回响应带 conversationId/requestId，前端 ACK 与草稿恢复 | `prompt-delivery.ts`、`agent-service.ts:1411`、`use-chat.ts:1180`；队列夹具覆盖 |
| 一次循环与整轮结束 | 完整 | `agent_end` 仅保存 lastRunMessages；`agent_settled` 结算任务/刷新历史/清理恢复状态 | `agent-service.ts:1049`；恢复测试及原生工具测试。特殊脚本异常见下文 |
| 正常停止 | 完整 | `session.abort` 原生停止；浏览器有按对话记录的断线停止意图；后台服务另行管理 | `recovery-service-test.mjs`；不等价于强制恢复保证 |
| 强停恢复 | 部分 | 宿主超时后 dispose/recreate；当前路径使用最近会话文件、默认活动会话绑定 | **动态缺陷 N1**；真实服务类/SDK，直接进入恢复函数，无挂死模型 |
| 自动重试/压缩/摘要重试 | 完整 | SDK 控制执行；宿主按 operationId 投影 recovery，取消调用原生 abort*；运行设置仅会话内存覆盖 | `recovery-service-test.mjs`、`extension-ui-test.mjs`；不同真实服务商错误分类未枚举 |
| 静默提示与手动重试 | 部分 | 宿主 watchdog；仅当前会话、无本轮工具副作用且用户文本相同才重发；无自动额外模型调用 | `agent-service.ts:2016`；长时间真实网络挂起未测 |
| 断线重连 | 完整 | SDK 会话留在服务端，snapshot/get_state 收敛；前端 seq/rev 检查，不重建模型运行 | `snapshot-delta-test.mjs`、`extension-ui-test.mjs`；无限离线资源保留另见资源报告 |
| 新建/恢复/会话持久化 | 完整 | 原生 runtime.newSession、SessionManager；Web new_chat 使用独立 runtime | `native-session-commands-test.mjs`、`switch-session-background-test.mjs`；强停例外见 N1 |
| 树过滤/分支/摘要/label | 完整 | `session-tree-controller.ts` 委托 SDK；协议 TreeRequest/响应绑定会话和请求；SessionTree UI | `session-tree-test.mjs`、`unit/session-tree.test.ts` |
| 编辑重问/派生 | 完整 | 默认同文件原生分支；显式派生另存；附件冻结来自真实条目，草稿恢复有请求归属 | `session-tree-test.mjs`、`current-file-protocol-test.mjs`、浏览器专项 |
| 多项目/后台会话隔离 | 部分 | 每 conversation 一个 runtime；cwd 切换串行准备与提交；同客户端共享 ModelRuntime | 日常路径有 `conv-cwd-test.mjs` 等；强停及 reload 例外 N1/N2 |
| 配置优先级/项目信任 | 完整 | SettingsManager/ResourceLoader 原生读写；MCP 项目信任与提示词实际加载状态分别处理 | `native-tool-defaults.test.ts`、`system-prompt-test.mjs`、`extensions-test.mjs`；不能用 MCP 信任标记代替 prompt 来源 |
| 系统提示词全文/hiddenTools | 完整 | 调用原生 builder，重构全文必须等于 public getter；不可匹配即只读；1.0.4 规则来源按可见工具过滤 | `system-prompt-view.ts:19`；提示词单测/协议测试；`pi-104-prompt-contract-test.mjs` 已动态通过 on/only/on getter、真实模型请求、hidden rules 和 skills |
| SYSTEM/APPEND/上下文编辑 | 完整 | 来源清单、版本校验、原子保存；保存后空闲 reload，失败阻止下一次 prompt；前端离开保护 | `system-prompt-files.ts` / routes → SystemPromptPanel；`system-prompt-test.mjs --browser`；多入口 reload 例外 N3 |
| skills 发现/筛选/启停 | 完整 | 原生包发现与 settings 过滤；不注册额外代理工具；运行时 reload 或新会话生效 | `skills-service.ts` / Extensions API → SettingsModal；`extensions-test.mjs` |
| 模板参数与附件 | 完整 | 1.0.4 内部 expandPromptTemplate 版本保护；先展开模板再附加文本，避免附件被当参数；扩展命令优先 | `native-prompt-template.ts`、`prompt-delivery.ts`；模板单测与 Node/Electron 原生工具测试 |
| packages 安装/更新/作用域 | 完整 | DefaultPackageManager + 独立 worker；版本冲突保护、原生过滤、手动 reload | `extensions-test.mjs`；联网 registry/Git 所有错误情形未枚举 |
| reload | 部分 | 原生 session.reload；Web 多入口；旧 UI dispose，新 runner beforeSessionStart 绑定 | 正常 reload 在现有测试中；**动态 N2/N3**：报告归属错、入口并发 |
| 默认工具 / bash | 完整 | 原生工厂；`makeRuntimeFactory` 无 tools/systemPrompt overrides；用户 defaultTools 优先，缺省增加 Codemode/tool_search | `agent-service.ts:720`、`native-tools.ts`；`native-tool-defaults.test.ts`、native tool 夹具 |
| Codemode / tool_search | 完整 | 官方 inline factories，可被用户扩展替换；运行与发现由 SDK；专用卡片、嵌套调用和费用投影 | `codemode-mcp-test.mjs`、`native-tools-desktop-test.mjs`；异常 built-in patch 专项见主报告 |
| MCP 配置/发现/调用 | 完整 | 原生 factory/command；宿主管理 JSON、保密字段、版本/信任；NativeMcpPanel 自动保存 | `codemode-mcp-test.mjs`、native tools 的 stdio/HTTP 本地夹具 |
| MCP 取消/连接中关闭 | 部分 | 1.0.4 原生 close() abort shutdown 并 await opening；宿主 runtime dispose 等待 session_shutdown | 本次真实 stdio 子进程停在 initialize；close 毫秒级返回前子进程已回收。未覆盖所有 HTTP/OAuth 取消阶段 |
| 工具图片/嵌套调用/历史恢复 | 完整 | SDK 存储内容；serialize 保留 image 与 bounded nestedCalls，parentToolCallId 经增量传递；ToolCallBlock/CodemodeCard | `native-tools-desktop-test.mjs`、`codemode-mcp-test.mjs`、native-result 单测；本次专项 read 真图片→image(result)→Web serializer→会话文件读回均通过，专项无浏览器断言 |
| 任意 structuredContent 展示 | 部分 | 原生 transcript 保留；Web 投影退出码、diff、路径和专用字段，不原样展开任意结构 | `serialize.ts:25`、`:166`；设计取舍，第三方工具专用结构 UI 未完整继承 |
| 完整输出/资源下载 | 完整 | 原生记录为来源，宿主限定真实文件和身份；下载与前端显示截断分开；跨分支/压缩历史可查 | `tool-output.ts`、`tool-output-test.mjs`；清单扫描 8 MiB 上限，不承诺发现扫描范围外标记 |
| 模型/thinking/虚拟路由 | 完整 | ModelRuntime/原生 setter；routedModel 单独显示；可选 thinking 档位由 SDK 给出 | `agent-service.ts`、ModelThinking；原生 mock/配置测试。未实际遍历所有虚拟路由与 provider |
| 模型配置保真 | 完整 | `model-config-merge.ts` 仅编辑聊天表单字段；保留 image/classifier、headers、operations、未知字段 | `model-config-preservation-test.mjs`、单测；浏览器不回传保存的密钥 |
| provider OAuth | 部分 | 官方 ModelRuntime.login/logout；URL/code/prompt 请求桥接，ID 关联、abort、10 分钟超时；凭据仍由 SDK 保存 | `provider-auth-test.mjs` 本地夹具；真实账号 OAuth 未验证，不能把模拟登录当真实互通 |
| token/费用/上下文统计 | 部分 | SDK stats/usage 自动继承，Codemode model API 有费用投影；分类 token 是估算，不作为精确 UI 指标 | native tool image model 费用夹具、序列化单测；真实账单、所有服务商缓存数据未对账 |
| 扩展 hooks/命令/消息 | 完整 | 原生 runner mode rpc；命令 preflight 保持原文及优先级；custom message 原生持久化，Web 通用展示 | `extension-ui-test.mjs`；TUI 自定义 renderer 不自动成为 React renderer |
| select/confirm/input/editor | 完整 | WebUIContext 每会话；UUID、类型校验、活动归属、超时/取消、重连重放、reload dispose | `webui-context.ts:190` → dialog/dialog_closed → Dialog；`extension-ui-test.mjs --browser` |
| widgets/status/title | 部分 | 文本桥接、ANSI 清除、会话隔离；widget factory 用 mock TUI，固定宽度 80，每秒轮询 | `webui-context.ts:88`；复杂布局、真实终端事件或 theme 绘制不等价 |
| 写入编辑器 / 读取草稿 | 部分 | setEditorText/pasteToEditor 发归属事件，前端消费一次；getEditorText 恒为 `""` | `webui-context.ts:257`、`use-chat.ts:1184`；浏览器编辑器专项，读取当前草稿明确未实现 |
| 自动补全 provider / 自定义编辑器 | 缺失 | addAutocompleteProvider/setEditorComponent no-op，getEditorComponent undefined | `webui-context.ts:260`；未发现 Web 等价实现 |
| TUI custom/footer/header/theme/terminal input | 不适用 | custom 立即 undefined，theme/header/footer/按键监听等 no-op；插件应提供 RPC fallback | `webui-context.ts:247`；这是 Web 支持边界，不能宣传任意 TUI 扩展即装即用 |
| CLI flags / 独立工具包 | 不适用 | Pi CLI 的 `--no-mcp` / `--tools` 通配符不是 pi-web-ui CLI 参数；通过原生配置控制 Web；独立部署工具不自动集成 | 不把 upstream CLI 新参数误记成 Web 新功能 |

## 已验证问题与建议

### N1 — 高：强停重建串入同项目另一会话

位置：`server/agent-service.ts:2128`（forceResetConversation）、`:2145`（continueRecent）、`:2154`（bindSession 无参数）。

触发：同一 cwd 有 A/B 两个会话，B 最近写入；A 的停止进入 force-reset。恢复函数没有按 A 原 sessionFile 打开，而是 `SessionManager.continueRecent(conv.cwd)`。若 A 在后台，函数末尾 `bindSession()` 默认取活动 B；A 的旧订阅此前已被取消，新的 A runtime 未重新订阅。

动态证据：隔离真实 ClientSession 创建 A/B，原生 SessionManager 持久化不同 marker，直接调用 A 的恢复路径。结果 A.sessionFile 等于 B.sessionFile，且 A.unsubscribe 为 undefined。测试没有模拟一整次真实 provider 挂死，因此证明的是恢复方法的缺陷，不是厂商 abort 失败概率；未证明发生了历史文件损坏。潜在后果包括用户看到错误历史、后续写入同一文件、后台结果无法正确更新。

建议：在 dispose 前捕获确切 session manager/file 身份；正常会话原文件恢复，无文件时复制当前原生 entries；始终 bindSession(conv)。增加恢复世代或单飞保护，并核对恢复完成时 conv 仍被当前客户端持有。此修复应独立于 SDK 升级实施。

### N2 — 中：reload 完成摘要属于错误会话

位置：`server/slash-commands.ts:264`、`:268`。

触发：A 发起 `/reload`，await 期间切换到 B。reload 本身捕获调用当时 A，但完成后再调用 host.getSession() 得到 B，随后把 B 的资源数量/名称写入仍携带 A conversationId 的 reload_status。

动态证据：真实 SlashCommandsService、可控 session host，暂停 A.reload 后切换 host 到 B；完成事件明确出现 `conversationId: A`、skills `[B-only]`。这是服务层确定性复现；没有声称完成浏览器时序复现或 A 的真正资源加载失败。

建议：函数入口捕获 session；诊断数据始终来自该 session，当前会话目录推送单独校验活动身份。

### N3 — 中：多个 reload 入口没有共同串行边界

位置：`server/system-prompt-files.ts:62`、`server/slash-commands.ts:264`、`server/agent-service.ts:508` / `:885`。

触发：保存提示词触发 queuePromptReload，与 `/reload` 或 MCP 设置更新重叠。提示词模块的 WeakMap promise 只管理自身；其他入口直接 session.reload。1.0.4 `AgentSession.reload` 本身会等待 shutdown/load hooks、替换 runner，但未见公共互斥。

动态证据：真实 queuePromptReload + SlashCommandsService，同一个可控 session.reload，同时在场调用峰值 2。**只验证了并发进入，没有动态验证真实 SDK 数据损坏、连接泄漏或提示词丢失。** 多次销毁/替换 WebUIContext 与 runner 相互覆盖属于静态后果风险。

建议：宿主统一 per-session reload 调度器，汇聚所有入口，检查 session.isIdle 而非仅 isStreaming，保存变更可合并；结果绑定调用发起的会话。动态验证同时保存/MCP/手动 reload、切换与 abort 后旧回调失效。

### N4 — 低：扩展 UI 对读取当前草稿没有实现

位置：`server/webui-context.ts:259`。

触发：原生扩展调用 ctx.ui.getEditorText() 读取用户尚未发送的草稿。返回值恒空；pasteToEditor 当前也复用替换操作，而不是浏览器光标处插入。

证据为静态代码，不声称特定插件已故障。建议清楚声明 RPC 支持矩阵；确有插件需求时增加异步草稿请求协议和版本/归属保护，不以同步伪值模拟完整能力。TUI 专有 custom/footer/theme 的 no-op 则属于平台取舍。

## 1.0.4 专项变化判定

1. **hiddenTools**：本地官方构建器过滤不可见工具的工具列表、内置规则和技能提示；宿主已按相同可见集合标注规则来源，并坚持全文等于公开 getter。不能仅修改版本字符串而保留旧来源算法。`forceSystemPrompt` 和不匹配时的只读降级仍有必要。
2. **Codemode read(image)**：上游将 read 的图片结果交还给脚本，并可通过 image() 形成原生结果；宿主 serialize 的 image 通道可以承接。本次动态读取真实 PNG，再 image(result)，核对原生结果、Web serializer、原会话文件读回均含图片。已另有通用图片浏览器回归；未把专项说成浏览器端直接执行 read-image 测试。
3. **连接中 MCP 关闭**：本地 1.0.4 `runtime.js:401` 先 abort shutdown、设 closed，再 await 当前 client 和 opening，随后等待认证落盘。Web 通过原生 runtime.dispose 的 session_shutdown 继承实现；没有另加旧版 MCP client。本次专用 stdio 子进程收到 initialize 后永不回复，配置 30 秒超时，close 在毫秒级返回且子进程已回收；验证的是原生连接类，不覆盖真实 OAuth/HTTP 各阶段。
4. **Codemode built-in patch**：本地 worker 在脚本前递归冻结 built-ins。本次通过本地模型发出 `Array.prototype.toJSON = () => { throw ... }` 脚本；正常工具结果落盘，tool_execution_end 与 agent_settled 均到达，随后同会话 read-image 仍能执行，未出现挂起。
5. **MCP 原生 OAuth 注册**：原生修复可以继承，但未用真实 OAuth 服务登录；本地 provider OAuth 测试也不覆盖 MCP authorization server 的真实注册政策。
6. **Bedrock 与 TUI 高亮**：1.0.4 对 Bedrock HTTP/2 stalled stream 的原生重试分类修复自动继承，但本轮没有真实 Bedrock 网络故障验证；TUI 多行语法高亮修复不等同 Web 的 highlight.js 渲染发生变化。
7. **原生恢复与工具集合**：SDK 在恢复时根据原生 loadout/发现决定 MCP 工具暴露。宿主不能强行把某个历史版本的已发现集合写回或改 SDK 来满足旧测试；须通过公开 tool_search 重新发现并对照独立 1.0.4。

## Web 与 Electron 的适用性

两者共同使用本报告审查的 server/protocol/React 路径。`electron/agent-runtime-env.mjs` 设置 ELECTRON_RUN_AS_NODE，原生工具 worker 与 package loader 使用随包 SDK；模板通过 getPackageDir 定位，提示词 builder 通过 require.resolve 搜索路径定位。因此 Node 回归只证明 Node 环境；实际 Electron 二进制、asar 解包目录与平台原生依赖必须另外跑包产物测试。

`native-tools-desktop-test.mjs` 支持传入实际可执行文件和应用根，覆盖原生 MCP stdio/HTTP、Codemode worker、嵌套调用、image-model 费用、reload 与恢复发现。它使用本地模型 HTTP 和 MCP 夹具，不证明真实账号授权，也不证明其他操作系统打包成功。Windows/Linux 实机结果以发布 CI 为准。

## 后续优先级

| 顺序 | 工作 | 收益 | 成本与兼容风险 |
| --- | --- | --- | --- |
| 1 | 修复 N1 会话精确恢复、重绑与恢复单飞 | 消除异常路径会话串用风险 | 中；必须覆盖普通/Wiki、后台切换、空会话和释放竞态 |
| 2 | 合并 reload 调度与 N2 身份捕获 | 配置加载可预测，避免扩展生命周期重叠 | 中；保留原生 shutdown/session_start 次序，不能伪造成功 |
| 3 | 将 1.0.4 特定上游修复夹具常驻兼容测试 | 下次升级能识别语义变化 | 低至中；不使用真实凭据，不把版本差异强制修补回旧行为 |
| 4 | 公布扩展 RPC/UI 支持矩阵 | 避免用户误以为任意 TUI 插件完整可用 | 低；仅文档及明确降级，确有需求再加草稿读取协议 |

复现命令：先 `npm run build`，再 `node tests/pi-native-review-repro.mjs docs/review-data/native-reproductions.json`。该脚本断言当前已知问题仍可复现，故意不加入验收 smoke；问题修复后应将断言转为正向回归。脚本只访问临时 agent/data/cwd，结束销毁真实 runtime 并删除临时目录。

上游修复专项：`node tests/pi-104-upstream-fixes-test.mjs docs/review-data/pi-104-upstream-fixes.json`。使用隔离 agent/cwd、内核分配且校验 ≥8900 的端口、本地 HTTP 模型和真实 stdio MCP；不访问个人凭据。原生 image() 与其他原生工具测试一样，可能产生 SDK 自身管理的系统临时图片文件。
