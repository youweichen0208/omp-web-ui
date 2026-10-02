# 内置子代理

修改子代理调度、完成判定、工具权限、结果回传或页面控制时，先阅读本文件。

## 入口与配置

未保存配置时默认开启；已有配置保留其启用状态。在顶栏「子代理」抽屉的设置中调整，也可从设置侧栏进入。设置的扩展列表固定显示「子代理 · 内置」，开关复用同一份服务级配置，设置按钮直接打开角色配置面板；该入口不注册为可卸载的 SDK 扩展。关闭只阻止新委派，已有任务继续运行并可单独停止。
`<dataDir>/subagents/config.json` 保存全服务配置，内置 analysis、development、review 三个模板。
角色可编辑名称、说明、提示词、模型、思考强度以及工具、技能和扩展允许列表。
模型不填时继承启动时的主模型；思考强度不填时继承主代理。
配置修改需要主代理空闲，并重载宿主会话；已排队或运行的任务保留启动快照。
扩展必须已加载在宿主会话中；原生能力用 `builtin:mcp`、`builtin:tool-search`、`builtin:codemode` 路径显式选择；宿主检查统一映射为 `<inline:名称>`，兼容 SDK 的 `builtin:` 路径。worker 将选中的原生工厂作为命名 inline 扩展加载，避免 `noExtensions` 屏蔽它们。
未找到指定模型、技能、扩展、工具或不能应用指定思考强度时失败，不替换为其他模型或能力。

开启时，宿主 resource loader 排除路径属于 pi-subagents 的扩展，关闭后恢复 SDK 原有加载行为。
不改用户全局配置。自定义包装扩展若没有可识别的 pi-subagents 路径，不会被自动识别，应由用户禁用。

## 运行与锁

`server/subagents.ts` 是服务级调度器，最多 4 个运行进程，每个父执行轮次最多创建 16 个任务，全服务最多保留 256 个未完成任务。轮次在 SDK `agent_start` 建立、`agent_settled` 结束，目标模式通过 `sendUserMessage` 自动续跑也使用新配额；中间 `agent_end` 不重置配额。
每个任务保存 clientId、conversationId、SDK 父 sessionId、父轮次、真实 cwd、角色和模型快照。
`web_subagent` 提供 spawn/status/wait/message/stop。spawn 立即返回；主代理需要依赖结果时调用 wait。单次 wait 最多 5 分钟，且不超过宿主工具看门狗期限的一半；到期返回真实 queued/running/stopping 状态，继续依赖结果时再次 wait，不停止父代理或子任务。工具返回仅含 id/status/role/result/error/usage；无 ID 的 status 最多列出本对话最近 32 条。
任务说明和明确选择的 background 是唯一复制的聊天背景，项目指令仍由 SDK 加载。
子代理通过 `process.execPath` fork `subagent-worker.js`；开发源码使用 tsx import，生产及 Electron 使用编译文件。
Electron 保留 `ELECTRON_RUN_AS_NODE=1`；不搜索 PATH 中的 pi 或 Node。
子代理创建独立 SDK SessionManager，不注册宿主终端、插件工具或委派工具。

状态为 queued/running/stopping/completed/failed/cancelled/interrupted。
`agent_end` 仅记录一次 SDK 循环结束；必须收到 `agent_settled`，并确认子进程退出且 IPC/stdio 通道关闭，才释放运行名额和写入锁。
worker 的最终结算只发送一次；agent_settled 已发出结果后，prompt 的迟到异常不再发送第二次 settled。worker 等待最终 IPC 发送完成才退出，避免大结果包丢失；宿主在 close 而非 exit 回调结算。工具返回与进程退出均不能单独证明任务成功。
默认超时 20 分钟，设置范围为 1 秒至 24 小时；排队不消耗执行超时。

写角色包含任何 read/grep/find/ls/code/web_subagent/todo/task_plan/tool_search 之外的工具时，按 realpath(cwd) 持有服务级写入锁。
宿主扩展的 tool_call 在执行前登记修改工具，tool_result 清理当前调用的登记，agent_settled 清理整轮登记。主代理首次修改后在本轮保有写入优先权，防止连续编辑中途被子任务抢锁；主动 wait 时让出优先权，但正在执行的修改工具仍须结束才可启动写子任务。
写子任务等待已有修改工具结束；锁占用期间其他宿主管理代理的修改工具被拒绝并说明任务 ID。排队摘要携带 queueReason：write_lock 表示等待修改工具、父轮次优先权或已有子任务写锁，capacity 表示等待全局运行名额；抽屉和聊天卡片对 write_lock 显示「等待项目写锁」。
只读角色允许并行。todo/task_plan/tool_search 及严格白名单中的 `git --no-optional-locks status` bash 调用可在写锁期间执行；包含重定向、命令组合、未知选项的 bash 仍视为修改工具。未知工具（包括终端、MCP 和自定义工具）保守视为修改工具。
锁仅匹配相同 realpath，父子目录不互斥；monorepo 根目录和子包需要使用同一项目目录才能共享锁。
该锁不是文件系统沙箱，不约束用户终端、外部进程或扩展自行执行的文件操作。

## 停止、保存与回传

停止父对话会取消该对话所有未完成子任务。停止子任务先请求 SDK abort，5 秒未退出则杀死其进程树。
只有确认退出才能解锁；排队任务可直接取消。取消后的迟到结果只保存在任务历史。
断开 WebSocket、切换项目不取消子任务；有子任务的父对话不能被缓存清理或删除。
关闭服务先停止所有子进程；启动时将持久化的未完成任务标为 interrupted，不自动恢复执行。
重新执行创建新 ID，并按当前配置启动。

`tasks/<id>.json` 异步、原子保存单个任务元数据、结果、用量及 agentDir，不再复制 task/background 到另一份 inputs。旧 `tasks.json` 在启动时迁移后删除。每个任务的 `<id>.jsonl` 异步保存消息、工具和指令记录，最多 16 MiB，达到限制时追加 record_limit 提示，最终结果仍单独保存。超长消息使用有效 JSON 的截断说明，不直接截断 JSON 字符串。
已交付及取消/中断的终态历史最多 200 条，保留 30 天；未交付的 completed/failed 结果在 30 天内不受 200 条上限影响，可使总历史数超过 200；交付确认保存成功后再按条数清理。所有终态任务超过 30 天都会清理，避免父会话已删除时永久保留无法回传的结果。启动与状态变化时清理超限元数据和日志，运行中任务不清理。
所有异步写入、日志追加和删除通过 enqueue 串行执行；队列尾部捕获并记录错误，返回给调用方的单次操作 Promise 保留失败结果。flush 只等待已排入队列的操作执行完毕，不继承历史操作的错误。
任务只等待自己首次保存的结果，成功后才启动 worker；保存失败时该任务立即 failed，不占未完成上限或写锁，spawn 工具收到本次保存失败，同时任务标记为已回传，避免再次补发失败消息。结果回传等待该任务自己的最新保存结果，失败时在后续 replay 重试；正常结果的 delivered 仅在其确认保存成功后设置。旧 tasks.json 只有全部任务迁移成功后才删除，任一迁移失败保留来源文件。
SDK 会话消息不放入主聊天快照。详情通过关联请求按 UTF-8 字节偏移异步读取，每页最多 100 条/512 KiB；nextOffset 是下次读取的字节位置，hasMore 表示当前文件还有内容，已追上末尾也保留游标以读取之后追加的记录。
协议 v27：状态版本递增，平时 subagent_delta 只推变化的摘要与删除 ID，重连和 list 发送权威列表。摘要不包含结果、背景或角色提示词；最终结果按需通过详情获取。浏览器按 requestId 保存独立回执，消费后清理，批量到达不互相覆盖。详情请求 10 秒无回执后允许重试；切换任务、刷新和重连时清理旧详情请求并从字节偏移 0 重读，通过 requestId 和请求偏移拒绝迟到回执，终态任务也可恢复丢失的详情请求。详情、控制响应包含 requestId/conversationId/taskId；宿主验证所有权。

结果按原 SDK 父 sessionId 定位，不使用当前活动对话。父代理空闲时追加 `web-subagent-result` custom message，不触发新轮次。
运行中的父代理在 agent_settled 后收到结果；主动 wait 的最终工具结果也是一次正式交付。
回传通过 transcript 中的 taskId 与任务 delivered 标记去重；先保存 transcript，再保存 delivered。去重同时识别已保存的最终 wait 工具结果（resultDelivered 标记）和 custom message；不在 SDK 尚未保存的 message_end 回调中提前确认交付。
父会话尚未打开时，在 30 天保留期内保留未交付结果，重新打开并绑定后重试。
子任务费用独立保存在 usage 中；缺少可用价格或用量时显示未知，不计入主代理费用。

## 回归

`node tests/subagent-persistence-test.mjs` 只依赖 Node 标准库和已编译的 dist/server/subagents.js；复现任务目录故障→恢复→新任务启动、flush 和 detail 恢复，不要求 Vitest/浏览器/模型可用。worker 启动后立即停止，不调用模型。

`node tests/builtin-subagents-test.mjs` 使用隔离本地 OpenAI 兼容模型驱动真实 SDK，无付费调用。
覆盖并行只读、追加指令、写锁及连续编辑优先权、排队取消、超时、原生能力、缺失模型、agent_end 多循环、强制终止、全局名额、轮次配额、自动续跑、重启记录及宿主结果归属；特别验证重复 wait 跨过宿主看门狗期限和最终 wait 不重复回传。
`tests/unit/subagent-regressions.test.ts` 另覆盖有界排队等待、停止原因、关闭守卫、目录失效、会话 rebind、紧凑结果、UTF-8 字节分页、写入/rename 失败后的恢复、交付确认失败和未交付历史保护。
`node tests/builtin-subagents-ui-test.mjs` 验证中英文抽屉、配置及真实状态驱动卡片；也模拟 Electron 窗口布局，覆盖详情丢包重试、快速切换后的迟到回执和写锁等待提示。
跨平台安装包验证仍须在对应平台执行；Node 本机测试不替代 Windows/Linux 安装包验证。

内置 `code` 工具通过授权 IPC 复用宿主项目语言服务，单任务最多 8 个未完成查询；Windows 冷工具链首次查询预算 180 秒，其他平台 30 秒，均支持取消并在 worker 关闭后清理宿主请求。
