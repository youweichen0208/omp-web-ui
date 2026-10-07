# 原生 plan 扩展

`server/plan/` 是 pi 1.0.4 可替换 inline extension，名称 `pi-harness-plan`。它不进入 CLI 自动发现目录，也不修改 SDK、原生 bash 或自动续跑策略。默认开启，尊重已保存的布尔开关（包括关闭）；缺失或无效配置使用默认值。服务实例的 `<dataDir>/plan-settings.json` 保存唯一全局 `enabled` 偏好。

## 工具与持久化

`plan` 使用 `model-only`、`sequential`、`defaultActive: false`。启用后提供简短 promptSnippet 和规则，尊重用户、skill 的等待与授权要求。`annotations` 声明 `readOnlyHint: true`、`openWorldHint: false`：只返回用于会话记录的计划快照，不修改外部资源。未声明幂等；权限扩展仍自行决定确认策略。

create/update 都提交完整状态：title、status、steps、currentStepId（无当前项时明确 null）、completedStepIds、completionCriteria，可选 changeSummary。标题最多 80 字符，步骤 1–16 个，步骤 ID 最多 64 字符且唯一，详情最多 500 字符，完成标准和变更说明最多 240 字符。完成 ID 必须唯一且属于步骤；当前项不能已完成。completed/cancelled/failed 不保留当前项，completed 要求全部步骤完成。

create 生成新 planId，revision=1。update 另传 planId 和 expectedRevision，只能更新当前分支最新且 active 的计划。冲突抛错并返回原因、正确操作和完整可编辑状态；没有计划或计划结束时提示 create。错误不会写入有效状态。工具描述和 steps 字段明确要求 update（包括完成）也提交完整步骤，不能当成部分更新。

唯一事实源为当前 `getBranch()` 中成功工具结果的 `details.planSnapshot`（schemaVersion=3）。恢复时保留 entryId 和 toolCallId。成功正文只报告身份、版本和结果；调用方先取得 create 返回的身份，再发 update。create 替换 active 计划时，在新快照 changes 内原子记录旧 planId、revision 和取消原因；旧条目保持不变，切回旧分支仍可继续它。

## 压缩背景

仅工具已激活且最新计划 active 时考虑恢复。最新成功结果及其配对完整参数都在模型上下文中可见时不重复补入，旧版本或错误结果不能抑制恢复。本轮最近一次 plan 结果失败时，即使成功调用仍在上下文中，也补入当前有效计划和纠错说明，覆盖 SDK 参数校验在 execute 前拒绝调用的情况；不自动重试、不自动补字段、不授权继续执行。`context` 钩子临时插入完整可编辑状态，放在最近压缩摘要后；没有摘要时放在最新用户请求前。

背景要求模型判断与当前请求的相关性：相关实施先 update，无关多步骤任务 create，普通问答无需计划。历史计划不授权继续执行。背景不写入 JSONL；增删背景可能改变提示词缓存。

## 宿主生命周期

注册完成后先检查工具来源，以 `<inline:pi-harness-plan>` 注册，不占用 SDK 的 builtin 命名空间；来源检查兼容旧的 `builtin:pi-harness-plan`。第三方同名工具覆盖时显示 conflict，不修改该工具的激活状态，也不提供原生恢复背景。默认工具集不追加 `+plan`。

创建、恢复、reload、树导航、只读恢复以及 agent_settled 共用协调函数。空闲且可写时仅在期望与实际不一致时调用 setActiveToolsByName；运行中或只读的会话显示 pending。当前只读会话也可保存全局偏好，恢复可写后再应用工具激活变更。全局切换保存后广播全部客户端的快照，不触发 reload。prompt 在实际投递前再次协调，快照构建只读取计划开关状态。

树导航后的协调不能省略：SDK 1.0.4 会从历史工具声明恢复激活集合，包括已关闭的 plan。协议 v40 的 UiState.planSettings 提供 enabled、available、effective、pending 和不可用原因；set_plan_enabled 带当前 conversationId。

## 展示投影

序列化仅按工具名 plan 和 schema 白名单投影；失败、无效和未知版本按普通工具卡展示。第三方 todo 专用投影已移除，历史 task_plan 继续只读兼容。

右栏以 assistant 内调用顺序配对成功结果重放。新用户请求使 active 计划区块进入“此前未完成计划 · 等待确认”；确认前任务整体使用当前请求的标题，运行时保持 running，结束后未完成计划进入 waiting。本轮成功 create/update 后才把之后的工具 ID 归给 currentStepId。此前工具仍在本轮执行记录中，右栏单独显示“本轮执行记录 · 未归入计划”，不追溯归入旧计划。历史轮次已确认的工具归属保持不变。失败更新不移动步骤。本轮最近一次计划调用失败且尚未被成功调用修正时，运行中保持 running，任务结束后显示 failed，不能因其他命令成功而显示完成；之后成功更新清除该错误。settled 不完成步骤，未结束计划等待继续；取消与执行失败保留状态。终态保留至下一条用户请求，已知新计划不会回退复活历史 task_plan。

聊天按当前 conversationId 内的 planId 合并卡片；成功更新保留变化行和键盘可操作的查看入口，错误保持普通卡。替换取消记录保留在新卡，旧卡显示取消；历史分支仍从其自身 transcript 还原。右栏保留当前步骤、详情和完成标准。

## 回归

- `tests/unit/plan.test.ts`：校验、冲突纠错、变化与替换、白名单、分支恢复、上下文可见性、工具归属、等待与终态、卡片身份。
- `tests/plan-sdk-test.mjs`：真实 SDK + 本地模拟模型，Codemode on/only、连续更新独立落盘、失败纠正、原生压缩条目恢复、关闭/reload/双向分支导航、无扩展读取历史、第三方同名工具。
- `tests/plan-settings-test.mjs`：隔离服务，多客户端全局开关、后台 settled 延迟、reload/导航、只读延后应用、发送前协调与只读快照、重连和服务重启。
- `tests/plan-chat-browser-test.mjs`：Web/macOS/Windows 壳、中文/英文、窄窗口、变化跳转与折叠历史、错误卡、替换隔离和等待确认。

本阶段不提供独立包、CLI 专用渲染或快捷发送按钮。
