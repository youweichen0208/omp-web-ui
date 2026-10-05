# 原生会话树

会话条目、label 和分支仍由 pi SDK 1.0.3 的 SessionManager 保存在原生 JSONL 中。WebUI 不建立树存储、不迁移旧的派生会话。协议版本 37。

## 投影与读取

`server/session-tree.ts` 从公开的 `getTree()` 派生有序列表、可见父节点、当前路径、分叉点和兄弟目标。按 CLI 选择器优先排列活动分支；五种过滤与多关键词搜索使用锁定版本的实际语义：`usage` 在所有模式隐藏；非当前 leaf 的无文本正常 assistant 消息在所有模式隐藏。消息搜索只使用 CLI 搜索的前 200 个内容字符；摘要搜索遵循 CLI 的区别处理。

过滤先于 5000 节点截断，预览去除 ANSI 与换行并限 120 字符。节点内容由 `tree_content` 按需读取，供摘要全文和复制使用。遍历采用显式栈，避免长路径递归溢出。

`buildSessionProjection().entries[].sourceEntry` 提供 UI 消息的 entryId，包括压缩摘要与分支摘要。保留现有 UI ID 和旧编辑请求的反查兜底。每次原生 revision 变化重新派生 label、siblings 和消息来源映射；只缓存这些展示元数据，不缓存或修改原生树。未变更的 UI 消息继续复用引用。revision 由 sessionId、条目数和 leafId 组成；label 覆盖和清除均追加原生条目，能够使 revision 失效。

快照携带树摘要，完整列表由 `tree_get` 按需读取；`tree_changed` 使已打开面板重新请求。后台变化更新会话摘要，重新连接依靠权威快照恢复 revision，不依赖通知必达。历史会话显示分叉点和 `parentSessionPath`。

## 写操作与生命周期

`SessionTreeController` 只接受活动对话的请求。全部回复携带 conversationId、reqId；客户端丢弃已离开对话与过期搜索请求。压缩或另一次树切换期间返回 busy，不排队。运行中必须显式同意中断：先 `clearQueue()`，再 `await session.abort()`（SDK 等待 idle/agent_settled），重新检查归属后调用 `navigateTree()`。

回收的 steering/followUp 文本与返回的 editorText 通过对话所属的草稿通道恢复，不自动发送。已有草稿时显示替换、追加和保留选项。user 和 custom_message 目标遵循原生退回父节点语义；当前 leaf 的原生 no-op 保持原样。

切换使用原生 `navigateTree`，保留 session_before_tree/session_tree 扩展回调及对应对话的扩展弹窗。仅生成摘要时进入 RecoveryStatus；无摘要切换不显示摘要状态或取消按钮。摘要取消调用 `abortBranchSummary()`。aborted 优先于 cancelled 判定（SDK 取消摘要时可同时返回两者）。失败、取消不把目标标成已选中。操作期间阻止更换活动对话；完成后恢复操作入口。纯切换不追加条目，因此不会把内存 leaf 单独保存到文件；跨端重开后的停留位置沿用 SDK 规则。

label 使用 `appendLabelChange`，允许运行中写入；不自行改写旧条目。此原生调用会推进 leaf 到 label 条目，标签本身不参与模型上下文。

编辑重问默认先原地导航到 user entry，再经既有附件和 prompt 管线发送新文本，原分支留在同一文件。编辑菜单可显式派生新会话；设置中的 `editResendNewSession` 保存于现有界面偏好，默认 false，不注入模型配置。`/tree` 打开树面板；`/fork` 打开用户消息选择；`/clone` 使用 `runtime.fork(leafId, {position: "at"})`；`/name` 使用原生 `setSessionName`。派生后的新 runtime 重新绑定扩展 UI、事件和树监视。

## 外部修改

监视当前会话文件所在目录，同时在写操作前核对文件状态。`SessionTailValidator` 记录已验证的 inode、文件长度和条目 ID。每次只从上次位置读取新增尾部，通过原生 `getEntry(id)` 核对；不全量读取历史。首次原生延迟 flush 校验会话头与全部首次落盘条目。截断、inode 变化、同长度内容变化、未知/重复条目或不完整追加均标记为外部修改。校验基于原生 append-only 约定，不扫描增长文件的既有前缀。正在运行时请求原生 abort；后续 prompt、树写操作、模型与思考变更及活动文件重命名被拒绝。树仍可只读查看。

“重新打开”直接调用捕获 runtime 的 `switchSession`，避免普通历史打开复用同一路径的旧 runtime。重绑成功才清除外部修改状态。文件监视在替换、移除和释放会话时关闭。

这不是文件锁：检测与其他进程的写入之间仍存在竞态，不能保证两个进程同时写入安全。CLI 与 WebUI 交替操作时应等待一方结束，再在另一方重新打开。

## 验证

- `tests/unit/session-tree.test.ts`：真实 CLI TreeSelectorComponent 的五种过滤与搜索逐项对比，多根、标签覆盖/清除、兄弟目标，以及 10000 节点过滤截断和 200ms 性能门槛。
- `tests/session-tree-test.mjs`：隔离端口和目录、真实 SDK 与本地模拟模型，验证原地编辑、摘要成功/失败/取消、扩展取消/弹窗、运行中取回队列、压缩守卫、外部写入及重新打开、原生派生与命令；`--browser` 验证面板、消息兄弟切换器、书签、全文与草稿保护。
- 新协议纳入 `check:protocol`；协议回归纳入完整冒烟。

历史列表的分叉数通过 `SessionBranchCounts` 异步只读解析原生文件并统计 parentId，按设备/inode/长度/mtime/ctime 缓存（最多 1000 项）。列表读取不调用 `SessionManager.open`，避免旧格式迁移或空文件初始化副作用。

编辑重问的非成功结果由 WebSocket 接收层统一发出对话所属 notice，不依赖树面板是否打开。`tests/unit/session-file-read.test.ts` 覆盖 5000 条、超过 11 MB 的尾部 I/O、大文件连续追加、异常外写、延迟首次落盘和旧/空文件只读读取。
