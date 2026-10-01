# Pi 0.99.0–0.99.2 桌面适配审计

## 当前实现进度

下文是开始适配前的审计基线。0.8.7-dev.2 已加入原生工具 factories、模型配置保真、结构化终端 bash、嵌套调用实时/历史和图片展示、官方 OAuth 桥与登录界面，以及虚拟模型路由显示。已通过真实 PTY、本地 stdio/HTTP MCP Codemode、defaultTools reload、模拟 OAuth、实际配置编辑/刷新及中英文浏览器回归。macOS arm64 产物通过自带 Electron 运行时的启动、SQLite、登录模块导入、原生 Codemode worker 和模拟 OAuth 检查。Windows/Linux 产物尚未验证；真实 ChatGPT 账号登录不在自动测试中执行。

审计基线：当前仓库代码、官方 Pi SDK 0.99.2，以及已安装的桌面 0.8.7-dev.1。日期：2026-10-01。审计包括静态研究、隔离配置读写和打包模块导入检查，没有读取用户凭据或调用模型。行号指审计时的文件位置；SDK 源码以随 npm 发布的 `dist` 与官方 SDK 示例为证据。

## 官方版本范围

- [v0.99.0](https://github.com/earendil-works/pi/releases/tag/v0.99.0)：新增原生 MCP/codemode、工具暴露与嵌套调用、虚拟模型、分类与图片生成，以及提示词提交 disposition。
- [v0.99.1](https://github.com/earendil-works/pi/releases/tag/v0.99.1)：新增 GPT-6.1 Sol，调整 Codex 默认模型，修复官方独立发行包的 ChatGPT 登录模块缺失。
- [v0.99.2](https://github.com/earendil-works/pi/releases/tag/v0.99.2)：调整 MCP 延迟连接和工具发现，扩展认证配置，支持 reload 激活新配置的默认工具，并修复 codemode 图片输入和工具命名等问题。

## 原生 MCP 与 codemode：需要显式适配

SDK 升级不等于 CLI 内置扩展自动进入桌面。官方 [SDK 示例 14](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/examples/sdk/14-codemode-mcp.ts) 明确要求 SDK 通过 resource loader 的 `extensionFactories` 加载 `createCodemodeExtension()`、`createToolSearchExtension()`、`createMcpExtension()`。本地同名文件第 1–40 行也说明 CLI 自动加载、SDK 显式加载的区别。

当前桌面宿主在 [agent-service.ts](../server/agent-service.ts#L972) 的 `resourceLoaderOptions.extensionFactories` 只增加内部纠正扩展，没有注册以上三个原生扩展。因此 native `mcp.json`、`/mcp`、codemode、tool_search 的完整工作流目前不能认定已接入。旧 [index.ts](../server/index.ts#L425) 仍创建 `McpBridge(DATA_DIR)`；[mcp-bridge.ts](../server/mcp-bridge.ts#L1) 使用 `<PI_WEB_DATA_DIR>/mcp.json` 的 `{servers:...}` 与仅 stdio 的自建协议。官方 [MCP 文档](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/mcp.md) 使用 agent 目录/受信项目的 `{mcpServers:...}`，支持 stdio、HTTP 与原生认证。两者不是同一个配置入口。

建议优先通过官方 factories 接入，并明确旧桥的共存或迁移策略，防止同一服务器连接两次。设置页中的原生配置、状态、启停、认证入口属于后续界面适配；基础工具能力应先接入。

需纠正一个潜在误判：原生 MCP 管理器不会在 RPC 模式强行打开 TUI。SDK `dist/extensions/mcp/index.js:973–1008` 根据 `ctx.mode === "tui"` 才启动 TUI，否则 `/mcp` 输出状态；桌面 [bindExtensions](../server/agent-service.ts#L1208) 采用 `mode: "rpc"`。`/mcp login` 使用 `ui.notify`、`ui.input` 与浏览器 opener（同 SDK 文件第 810–825 行），现有桥有这些能力。虽然 [webui-context.ts](../server/webui-context.ts#L250) 的 `custom()` 永远 pending 是一般性风险，但不能据此认定 RPC `/mcp` 一定挂死。

## defaultTools 与 reload：自动继承，仍应验证

官方 SDK `dist/core/sdk.js:144–148` 读取 `SettingsManager.getDefaultTools()` 决定初始工具集；`dist/core/agent-session.js:2873–2904` 在 reload 前后比较默认工具，仅追加新配置的工具，同时保留会话禁用状态。桌面使用 SDK reload（[slash-commands.ts](../server/slash-commands.ts#L267)），后续 [终端门控](../server/agent-service.ts#L2150) 在现有活跃集合上增删 terminal 工具，不会重置成四个固定工具。

结论：0.99.2 的默认工具 reload 规则基本自动继承。但 `+codemode` 只有在原生 codemode 已注册后才有实际意义。当前测试 [run-smoke.mjs](../tests/run-smoke.mjs#L44) 包括旧桥测试，不代表 native MCP/codemode 验证。接入后增加隔离配置 reload 回归与 packaged Electron sandbox worker 回归。

## ChatGPT 登录与新模型

[v0.99.0](https://github.com/earendil-works/pi/releases/tag/v0.99.0) 增加 OpenAI provider 的 ChatGPT 登录，[v0.99.1](https://github.com/earendil-works/pi/releases/tag/v0.99.1) 修复独立发行包缺少登录模块并新增 GPT-6.1 Sol。模型目录更新随 SDK 继承；是否可选仍取决于供应商认证与用户的自定义模型覆盖，升级不会强行更改已有会话的模型。

桌面 [ModelConfigModal.tsx](../web/src/components/ModelConfigModal.tsx#L236) 与 [协议](../server/protocol.ts#L420) 只提供 API key 操作，[slash-commands.ts](../server/slash-commands.ts#L46) 没有原生 `/login` 或 `/logout` 实现。CLI 交互命令不会自动成为 SDK 命令。因此已有终端登录凭据可以通过共享 agent 目录被 SDK 使用，但桌面内发起 ChatGPT 登录仍需适配。SDK `dist/core/model-runtime.d.ts:107` 已有公开 `login(providerId, type, interaction, options)`，应桥接官方认证回调与浏览器打开操作。

已用安装包自带的 Electron Node 运行时导入包内 `pi-ai/dist/auth/oauth/openai-chatgpt.js`，成功。此检查确认当前本机包没有对应的模块缺失，不代表真实 OAuth 登录流程已经完成。建议把此 lazy import 纳入打包回归。

## 嵌套工具调用：运行可继承，展示缺少父子关系

SDK `dist/core/nested-tool-calls.js:116,144,162` 发出带 `parentToolCallId` 的 start/update/end；`dist/core/agent-session.js:697` 把有界 `nestedCalls` 记录到父工具结果。官方 [扩展工具文档](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/extensions.md#tool-exposure) 解释新的工具暴露与执行接口。

桌面 [工具事件处理](../server/agent-service.ts#L1313) 会跟踪这些事件的 ID、运行耗时、看门狗和输出，但 wire 数据没有保存 parent ID；[serialize.ts](../server/serialize.ts#L136) 只序列化工具结果文本、错误与 todo，丢弃 `nestedCalls` 和 `structuredContent`。因此 codemode 的内部 bash/read/MCP 调用即使执行成功，也不能保证在消息卡片中显示其独立参数、父子结构与历史结果。通用卡片只看到父工具总输出。这属于需适配的可观测性问题，不能写成执行功能一定失效。

此外 toolResult 的图片被统一替换为 `[image result]`（同 serializer 第 137–139 行），SDK 的 codemode `image()` 验证修复会自动继承，但生成/返回图片的桌面展示仍有独立缺口。

## 自定义 bash 工具：启用 codemode 前统一结果契约

[agent-service.ts](../server/agent-service.ts#L196) 的 `makeKillableBashTool()` 从官方工具手工构造定义，没有复制 `outputSchema`、`promptSnippet` 与 `promptGuidelines`。官方 `dist/core/tools/bash.js:169–172,288–305` 提供这些字段及 `structuredContent`。当前一次性 bash 执行会保留原生返回的结构化结果，不能误判为所有 bash 结果都丢失；但 schema 与提示贡献没有保留。

[terminals.ts](../server/terminals.ts#L1207) 的终端接管实现返回文本和 `details.exitCode/output`，没有同等 `structuredContent` 或输出 schema，完成哨兵的非零退出码也没有返回 `isError: true`。启用 codemode 后，脚本对两种 bash 实现的输出/错误判定可能不同。应统一可编程返回值并覆盖终端接管开关、非零退出、截断和空输出；保留独立停止 bash 的现有行为。

## 虚拟模型：核心自动继承，路由透明度可选增强

官方 [虚拟模型文档](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/virtual-models.md) 区分用户选择与实际路由，SDK 负责路由、恢复与压缩。桌面模型列表调用 `ModelRuntime.getAvailable()`（[agent-service.ts](../server/agent-service.ts#L3396)），选择调用 `getModel()`（同文件第 3482 行），使用原生 AgentSession，理论上可选择扩展注册的虚拟模型，无需重写路由。

当前快照 [agent-service.ts](../server/agent-service.ts#L1605) 从 `state.model` 显示选中的模型，没有 `session.routedModel` 或实际思考档位；[serialize.ts](../server/serialize.ts#L122) 保留响应的实际 provider/model，却没有响应 `thinkingLevel`。因此可选增强是显示“虚拟选择 → 实际模型/档位”，帮助用户理解路由。当前总成本来自 SDK `getSessionStats()`（agent-service.ts:1617），自动包含 SDK 成本统计；按物理模型拆分成本的 UI 是可选增强。

## 图片生成与分类模型：SDK 可用，桌面入口属于可选功能

SDK `dist/core/model-runtime.js:299–303,540–560` 提供 typed model access、`generateImages()`、`classify()` 与原生认证。官方 [虚拟模型文档](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/virtual-models.md#route-requests) 说明路由扩展可以调用分类接口；官方 [llama.cpp 文档](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/llama-cpp.md#classification) 描述分类模型。

桌面现有模型下拉保持聊天用途合理，不应把 image/classifier 当聊天模型强行加入。SDK 内的扩展/路由使用这些能力可自动继承；产品级图片生成按钮、分类模型配置入口是可选需求，用户未明确需要时不必为升级新增。

模型编辑器有已复现的数据保真问题：[model-admin.ts](../server/model-admin.ts#L458) 读取模型列表时仅投影旧聊天字段；同文件第 805–828 行按这些字段重建并覆盖 provider，除 headers 外未保留其他模型/operation 元数据。在 mkdtemp 隔离目录中写入含 chat/image/classifier 条目的配置，调用真实 `ModelAdminService.listModelsConfig()`，再将返回值交给 `saveModelConfig()`：保存后的 image/classifier 条目均丢失 `type` 及其额外参数。模型 runtime 使用无网络替身，此实验验证宿主读写丢字段，不验证 SDK 模型配置 schema。应先保护原字段或限制表单编辑范围，再考虑新增生成/分类入口。

## 建议顺序与验证边界

1. 先保护模型配置读写，保留非聊天 operation 字段；这是已有编辑路径上的数据丢失。
2. 接入 native MCP/codemode/tool_search，统一 bash 结果契约，建立 Electron 实际 worker 和 stdio/HTTP 本地夹具回归；认证使用模拟服务，不访问用户凭据。
3. 补嵌套工具父子记录及图片工具结果展示；对工具事件使用独立 ID，避免把 nested result 假装成顶层模型工具调用。
4. 提供桌面内 ChatGPT 登录入口；虚拟模型路由显示、物理模型成本分解和图片生成专门 UI 按需求添加。

之前的桌面升级已适配 prompt disposition、`agent_before_settle`、`agent_settled` 与公开的 `session.systemPrompt`。发布页修复只代表 SDK/CLI 上游行为；本报告未新增 native MCP、图片生成、虚拟路由或 codemode Electron 端到端实测，“自动继承”是架构判断，不是这些新功能已验证的声明。TUI 的终端配色、滚轮和鼠标修复不要求 React 桌面照搬。
