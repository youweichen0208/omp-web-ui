# 资源生命周期静态审查

日期：2026-10-06；范围：当前升级后的 Web/Electron 源码。本文以静态审查为主；消息缓存另有受控动态复现，不修改实现。最终 RSS/heap/DOM/延迟、三轮重复和 30 分钟增长数据见 [主报告](pi-native-resource-review.md)。行号是本轮代码定位，后续修改应按函数名查找。

## 优先处理的结构性问题

| 优先级 / 类别 | 代码证据与触发条件 | 现有界限与实际含义 | 建议 |
| --- | --- | --- | --- |
| 高 / 无界保留，兼有断线恢复设计取舍 | `server/agent-service.ts:845` detachSink 仅移除 sink，最后断线只 unwatchDir；`:3435` detach 不删除 clients；`:3394` 每个新 clientId 加入 clients；释放在 disposeAll/服务退出 | 同 clientId 重连复用 runtime 是正确设计；不断产生新标签页 clientId 后关闭，旧 ClientSession、会话、资源 loader、MCP/扩展、定时器仍可达。没有发现全局客户端数量/字节预算或空闲 TTL。**可达对象保留不是 GC 泄漏证明，但断线数量增长不会自行降回初始运行集。** | 为无 sink 且没有运行、PTY、未处理交互的客户端设置宽限期/LRU；保留原生 session 文件，重连恢复；活跃会话不强退 |
| 高 / 跨项目上限缺口 | `server/agent-service.ts:2241` 上限 8 按 cwd 计算；`:2323` displaceActive 在所属项目未达 8 时保留 idle runtime；`:2997` 首访项目新建并加入 convs | 8 是每项目限制，不是每客户端/服务限制。访问 N 个项目至少可保留 N 个 runtime；前端缓存 3 项目不限制服务端。项目显示列表的 20/30 条也不是 runtime 回收 | 先定义全局活跃/休眠状态，暂停未运行会话资源并有界回收；跨项目按总字节及总数 LRU，不能仅限制侧栏条目 |
| 高 / 大会话缓存逐出策略冲突 | `server/agent-service.ts:144` UI_MESSAGE_CACHE_CAP=4096；`:1206` 插入后淘汰最早条目；`:1233` currentMessages 每次从第一条遍历全部 transcript；`:1354` 增量快照依赖对象身份 | 当可序列化独立 cache key 超过 4096，上一轮尾部缓存可在下一轮从头扫描时逐个被淘汰，形成持续 miss；lastMessagesArray 仍保留完整消息，因此 cap 也不是整个 UI 消息图的硬上限。新对象使 delta 身份检查失败，可能退回 full snapshot。**受控 host 的动态复现已确认：4100条时第二次自动快照仍为full，4100个对象引用全部改变；64/4096条则仍为delta。实际网络频率/耗时另看基准。** | 与当前 transcript 投影对象共用身份，避免扫描时逐出同一工作集；历史按需分页或按 message revision 增量更新。新增 >4096 的「两次无变化快照仍 delta」回归 |
| 高 / DOM 仍随轮数增长，非完整列表虚拟化 | `web/src/components/MessageList.tsx:47` KEEP_RECENT=15；`:728` 旧消息走 CollapsedGroup 并在 LazyMount 前返回；`collapsed-groups.ts:70` 不同 role 拆组；`CollapsedGroup.tsx:121` 每组创建按钮/文本/图标节点 | 旧 Markdown 已降为轻摘要，但交替 user/assistant 的 N 条历史仍有 O(N) 摘要节点、React 元素和导航索引。LazyMount 只管完整消息，不管全部旧摘要。不能将大会话初次成本描述为「20k 条全量 Markdown」，也不能把摘要当恒定 DOM | 摘要与完整消息统一放入按视口的列表窗口；保留全量文本搜索索引，搜索命中后按需挂载；直接定位按累计高度映射 |
| 中 / 可确定的无界日志容器 | `electron/main.mjs:125` serverOut 初始化；`:128`/`:133` 每个 stdout/stderr chunk 持续拼接，启动完成后监听器仍保留；读取错误只 slice(-500/-800) | 截取发生在报错展示，不限制已存字符串。生命周期内日志总量决定占用，频繁扩展日志可使 Electron 主进程持续增长。**未在本次静态审查注入海量日志，因此没有分配速率或 OOM 实测。** | 捕获阶段即限制尾部字符/字节或使用环形缓冲；如需全文，写有轮转限制的文件；启动成功后移除专用 readiness 监听器 |
| 中 / 附件草稿总量无预算 | `web/src/App.tsx:232` attachmentDrafts 按 conversationId Map；`:236` 切换即存数组；`:717` 单文件限 20 MiB；`:730` readAsDataURL 后保留 base64；ChatInput.tsx:122 另有纯文本草稿 Map | 单文件限制不等于单草稿/所有草稿限制。多个文件、多会话可一直驻留，base64 额外膨胀；切回才删除 Map 项，活动附件仍在 state。未见随服务端会话退休的统一草稿回收；不能悄悄丢用户草稿来省内存 | 提供总大小提示，持久化 Blob/IndexedDB 或上传暂存引用；显式清理已关闭会话并给恢复入口，保留离开保护 |
| 中 / 已展开历史存在脱离 DOM 的引用保留风险 | `MessageList.tsx:323` attachEl 仅处理非 null ref；`:328` 清理只看消息 ID 是否还在 state.messages；`:728` 折叠时由 LazyMount 改成 CollapsedGroup | 用户展开旧消息后再折叠，旧 wrapper 的 ref(null) 被忽略；消息 ID 仍在历史，elsRef 可继续持有已从 DOM 移除的 wrapper，直到重新展开替换或会话组件卸载。不是首次只读摘要增长的唯一解释，**尚未独立动态取 heap retaining path** | 为每条消息保存带 ID 的稳定 ref，ref(null) 定点删除；清理 isConnected=false 的旧节点，并验证 sweep 不再测量脱离 DOM 的引用 |

## 有界但仍可能偏重的设计

| 模块 | 源码界限与触发 | 评价和建议 |
| --- | --- | --- |
| 首次惰性挂载 | `MessageList.tsx:239` hidden 默认空；`:310` layout effect 才 sweep；`:745` !hidden.has(id) 初始为 true | 初次完整消息、先前展开历史要先构造 DOM 再测量隐藏；能避免首次绘制远端内容，不消除构造成本。常规只最近 15 条全文，其余摘要。单条巨型消息或许多已展开历史仍有峰值。建议首帧用估算高度限定挂载范围，逐步校正 |
| 搜索、固定消息与会话高度缓存 | `MessageList.tsx:251` searchOpen 禁用 virtualOn；`:242` pinned 无数目限制；`:171` scrollPositions 最多 24 个会话 | 为搜索 DOM 高亮与跳转体验作的取舍；复杂历史搜索/累计固定可提升渲染成本，24 个高度/展开集合也随各自历史长度增长。建议数据级搜索，不通过取消窗口化实现全文命中 |
| 前端项目缓存 | `web/src/project-cache.ts:5` 最多 3 项目、32 MiB，按 JSON.stringify(value).length×2 估算；LRU 淘汰 | 有界且不作为 delta 基底，设计正确。估算不是 V8 heap 实际值；stringify 为同步临时分配，超预算项也须先完整序列化。建议增量估算，避免切换时额外大会话字符串 |
| Wiki 索引 | `server/wiki-service.ts:10` 单文件 2 MiB、单次文本源字节 64 MiB；`:108` 20,000 项、32 层；`:89` 缓存最多 8 项目 | 按输入字节的 8×64 MiB 不是严格 heap 上限；还存 JS 字符串、entries、references、backlinks，扫描新结果时旧 cache 同时在内存。按项目的 in-flight 合并有效，但不同 cwd 扫描无全局并发限制。建议全局字节预算和工作队列；别把 8 项目乘数省略 |
| Wiki 缓存老化 | `wiki-service.ts:71` 30 秒后返回旧值并后台扫描；`:89` 淘汰 Map 首项，无读取提升；`:50` generations 递增 Map 无删除 | 属过期刷新 + 插入顺序淘汰，不是严格访问 LRU。大量项目有少量 generations 元数据常驻；相比正文较小。建议明确策略、清理不再引用的 generation，按字节追踪正文 |
| Wiki 撤销历史 | `wiki-service.ts:56` 最多 100 次、`:60` 目标 128 MiB 引用 blobs；`:207` before/after 快照各最多64 MiB；`:247` diff 再解码/拆行 | 持久化保留有界，最新记录允许保留；单轮记录仍有 before+after、文本和行 Set 瞬时复制，不应等同空闲索引成本。建议对大文件流式 hash/diff、按文件释放暂存；标记截断已存在 |
| PDF | `server/wiki-pdf.ts:7` 全局最多 2 worker、8 秒超时；cache 最多 16 文件；`wiki-pdf-worker.ts:9` 最多200页、每页100,000字符；Wiki 搜索最多8个≤20MiB PDF | 工作者隔离/超时正确。16个完整 page 数组可很大，按个数有界不代表轻量；16×200×100k 是最多3.2亿个缓存字符的宽松逻辑上界，不是实测占用。建议按总提取字节回收、搜索片段或按页懒读 |
| SQLite | `server/sqlite-preview.ts:12` 全局最多2个隔离工作者；请求退出清理，查询分页由 sqlite-query 执行 | 功能不常驻打开全部数据库；仍应分别测单个复杂查询、分页和取消，不把主进程空闲内存当全进程峰值 |
| 终端服务端 | `server/terminals.ts:169` 每 manager 16 live、32 history、每项200,000字符；`:697` 截尾；`:677` pendingOut 在短窗口合并 | 单 manager 有界，但 manager 每 conversation 一个，可被客户端/项目增长放大。输出合并期间 pendingOut 无硬字节阈值；高吞吐/事件循环阻塞时短峰值不由历史上限约束。建议全局 PTY 预算与合并队列阈值，保持精确进程清理 |
| 终端浏览器 | `TermXterm.tsx:61` scrollback8000；`use-chat.ts:340` 无 writer buffer 超200k后改为整个新 chunk | xterm 行数有界；bridge 并非严格200k字符上限：单个 chunk 更大时照单保存，且满时丢整个旧缓存。生产服务器 chunk 通常小，此为静态极端风险。建议取尾 slice(-MAX_TERM_BUFFER)、按终端退休清理键，测隐藏终端持续输出 |

## 快照与断线后的工作

- `server/index.ts:562` 在 JSON.stringify 前检查 snapshot 背压，是有效优化；阈值为 max(256 KiB, 最近完整快照估算×3)，丢弃后 250ms 重试。大单份快照的允许积压也相应变大，不能视为固定256KiB上限。WeakMap 共享 stringify 仅适用于相同消息对象的多个 sink。
- `server/agent-service.ts:1233` 仍为每次 checkpoint 扫完整当前消息并生成中间数组/签名；增量传输不意味着服务端 O(1) 更新。消息数大于4096时尤其要核对前述缓存回绕。
- message_delta、tool_delta 绕过 snapshot 节流用于即时反馈；终端输出也不走 snapshot 丢弃策略。高吞吐慢客户端下不能仅凭 snapshot 背压代码宣称所有 WS 输出有全局硬界限。
- `agent-service.ts:918` widget timer 遍历所有 retained conversation，`:927` stall timer 仍活跃；`bg-servers.ts:42` 每客户端后台存活 timer。detach 未停止这些 timer；运行保留是有意的，但没有 sink 时仍做 UI 序列化/轮询会增加闲置客户端边际成本。
- `detachSink:850` 只 unwatchDir，Git watcher 在 `files-service.ts:439` 建立、`:465` 释放；客户端断线后已建立的 Git watcher 会随 ClientSession 留存。`persistent:false` 只影响进程是否等待 watcher，不等于 watcher 已关闭。

## 优化顺序与验证建议

1. 先处理超4096条缓存抖动与摘要列表窗口化：直接针对长会话 CPU、DOM、传输和启动峰值；以5k/20k历史、无变化快照、流式与搜索分别验收。
2. 增加客户端/跨项目的休眠与回收边界：以30个新clientId断开、30项目往返、原ID重连验收；保护运行、PTY、弹窗和草稿，不能用关闭用户任务换低内存。
3. 立即限制 Electron 日志捕获尾部：代码成本低、行为兼容风险低；独立大量日志夹具后确认主进程留存稳定。
4. 按总字节治理附件、Wiki/PDF 与终端，继续使用现有原生 SDK 与实际持久化；区分空闲留存、自然峰值、强制GC后对象和用户主动保留数据。

以上为可定位的静态结构与边界，不把预估字符上界换算成未经测量的 RSS，也不把首轮观测或未运行的故障时序列为最终已验证缺陷。

## 消息身份与附件恢复的补充静态核对

`serializeCached` 的 cache miss 不只是创建新对象。`server/agent-service.ts:1191` 对 user 消息递增 `userSeqByTs[timestamp]`；该计数在当前 conversation 生命周期中持续保留，未按每次 transcript 遍历重置。原本 `msgIds` 保存的稳定序号只用于 assistant 等消息，user 的 ID 使用这个可增长的按时间戳计数。因此超过缓存容量导致旧 user 再次 miss 时，UI ID 的 suffix 也会增长，即使原生消息没变。此项由源码及下述受控动态复现共同确认。

- `server/agent-service.ts:2739` 的旧 ID 回退解析，按原生 `buildContextEntries()` 当前路径中同时间戳的 user 顺序计数；不会把别的分支、压缩前条目或 custom file 卡片算成 user。同一 timestamp 的不同 user 首次序号 1/2 能正常对应；重序列化后变成3/4，而路径仍只有两条时解析不到。
- 现代编辑提交在 `web/src/components/Message.tsx:322` 带 `entryId`，`agent-service.ts:2780` 优先使用它。因此不能宣称所有当前编辑操作都因 ID suffix 变化而失败；缺少 entryId 的兼容请求、React key/展开/导航状态则仍可能受影响。
- `server/serialize.ts:275` contentFingerprint 只散列第一 text block 前512字符和完整长度；图片首块只用 base64 长度。**同 role、同 timestamp、同长度且前512字符相同的两个不同文本**，或同长度不同图片，可产生相同 cache key，而非仅理论哈希碰撞。同时间戳的完整不同条目可能因此共享原始 UiMessage/ID。当前 tree projection 按出现次序选择原生 entry，并 decorate 出 entryId，可保护部分原生引用归属，但不能恢复已经碰撞的原始图片/正文序列化内容或唯一 UI ID。
- 附件冻结本身使用 `server/user-attachments.ts:64` 的 `{entryId,index}`，从确切原生条目重新解析，并按传入数组顺序返回；不按 timestamp 猜源。`session-tree-controller.ts:102` 生成 attachment nativeRef；`question-attachments.ts:80` 先本 user 原生附件/图片，后面紧邻的 legacy custom file 卡片，遇到下一个 user/assistant/toolResult 即停止。因此相同时间戳本身不会把正常 nativeRef 附件重排。发生指纹碰撞时，UI key/内容层和原生引用层应分别验证，不能混为一谈。

已新增 [pi-message-cache-review-repro.mjs](../tests/pi-message-cache-review-repro.mjs)，已完成语法检查与动态执行。断言64/4096/4100条工作集的两次自动快照类型、对象身份、user/assistant ID变化、旧ID回退解析，以及同timestamp/同前缀不同附件的指纹碰撞和nativeRef正确顺序。使用真实 cache/projection/snapshot 方法及原生内存 SessionManager，替换轻状态/计时注解，未包含真实服务、tree decoration 或浏览器。运行命令：`node tests/pi-message-cache-review-repro.mjs docs/review-data/message-cache-reproductions.json`；这是已知问题审查脚本，不加入正常验收 smoke。


### 动态复现补充

Web 正式性能负载结束后已执行 `node tests/pi-message-cache-review-repro.mjs docs/review-data/message-cache-reproductions.json`，全部已知缺陷断言通过，见 [原始证据](review-data/message-cache-reproductions.json)。4100条重复自动快照中引用全部改变，两条相同timestamp用户消息的ID后缀从1/2变为3/4，旧timestamp回退解析失败；64与4096条保持引用及增量快照。另确认同timestamp、首512字符和长度相同的文本会共享缓存对象/UI ID；原生entryId附件路径仍保留正确顺序。边界是受控 ClientSession host 的真实序列化/快照方法，跳过轻状态及tree装饰；不能据此宣称所有浏览器编辑失效或SDK原始历史损坏。
