# 附件、图片与文件处理

> 覆盖附件三种模式、图片问答、视觉桥、文件上传/下载/预览协议。

## 附件三种模式

`ClientMessage.prompt.attachments[].mode` 决定附件如何发送给模型：

| mode | 含义 | 服务端处理 |
| --- | --- | --- |
| `inline` | 内联全文 | ≤ `PI_WEB_INLINE_FILE_MAX`（默认 12KB）内联，超出自动降级为 reference |
| `reference` | 仅路径 | 发 `<file path="..." size="..."/>`，模型按需用 read 工具读 |
| `lines` | 选中行 | 发 `<file path="..." lines="2-3">```选中行```</file>`，只读该范围（读取上限 2MB，超限降级 reference） |

附件作为独立 custom message（`prompt-delivery.ts` 在 SDK 预检通过后入队的 file asides）发送，渲染成可折叠卡片。客户端 `stripFileWrapper` 的正则要兼容 `lines="..."` 属性。

**消息序列化缓存按 `role:timestamp` 为 key——同一 prompt 的多个 aside 同毫秒创建会碰撞，必须靠内容指纹（`contentFingerprint`）区分，否则只有第一个渲染（已修，勿回退）。**

## 图片问答（无工作区路径）

粘贴（Ctrl+V）/ 拖入输入框（**整个窗口都是拖放目标**，issue #19：`.app` 根节点接文件 dragover/drop + 全屏 `.app-drop-overlay` 高亮；输入条与编辑器自身 handler stopPropagation 保优先级）/ 🖼 上传的图片带 `attachments[].imageData`（base64）+ `mimeType` + `name` 发送——服务端直接作为 image content 附加，不走文件路径（`path` 忽略）。浏览器端（`web/src/image-paste.ts`）先把图片等比缩到 ≤1568px、按需转 PNG/JPEG，保证 payload 在服务端 2MB 上限内（`MAX_PASTED_IMAGE_BYTES`）。当前模型不支持识图（`model.vision`）时前端提示警告。

## 视觉桥

当**当前对话模型不支持识图**（DeepSeek/GLM 等 `input` 只有 `text`）时，`buildAttachmentMessages` 不再把图片直接作为 image content 发送（会被忽略），而是交给一个**已配置的视觉模型**转写成文字证据再喂给主模型（`server/vision-bridge.ts`）：

- **零配置自动发现**：`findVisionModels` 扫描 `ModelRuntime` 所有 **`hasConfiguredAuth`** 的 provider，找出 `input` 含 `"image"` 的模型（qwen-vl、GLM-4V、Gemini…）——复用 models.json/auth.json 里已有的凭据，不新增任何配置。⚠️ 必须过滤未配置的 SDK 内置 provider（如 amazon-bedrock 自带 Nova 视觉模型但无 auth，不滤会调用失败）。
- **转写**：`transcribeImages` 用 `runtime.completeSimple` 把整批图（多图合并一次调用）发给视觉模型，提示词要求证据优先——逐字 OCR、版面布局、图表坐标/图例、实体，读不清明说「读不清」不编造（沿用 modlens 的 evidence-not-imagination 契约）。默认 90s 超时（`PI_WEB_VISION_TIMEOUT_MS`），maxTokens 4000 防爆上下文。
- **结果形态**：附件卡片 content 变为 `[text(<vision-bridge>包装), image(缩略图)]`，`details.mode` = `"bridged"`（前端 AttachmentCard 显示「👁 已转写」标签 + 展开看缩略图与转写文字；`stripFileWrapper` 同时剥 `<vision-bridge>` 包装）。notice 提示转写开始/完成/失败（失败回退原样发送）。
- **文件列表引用图片同样触发**：`buildAttachmentMessages` 预处理阶段除 `imageData` 外，还把**路径指向图片的附件**（扩展名 ∈ IMAGE_EXT 且非 SVG，`sniffImageMime` 魔数嗅探确认，≤5MB `MAX_PATH_IMAGE_BYTES`）读成 base64——纯文本模型走视觉桥（bridged 卡片带 `path`），视觉模型直接作为 image content 发送（不再让模型用 read 工具读二进制乱码）；SVG 保持普通文件（模型读源码）。
- **缓存**：`visionBridgeCache` 按批次 hash（name + base64 前 48 字符）缓存转写文本——编辑重问重发相同图片不再重复耗视觉 token。
- **无视觉模型时**：warning notice 提示「未找到可用的视觉模型」+ 图片原样发送。

### 设置面板可指定模型/开关/提示词

`SettingsModal` 视觉桥区块，走 `set_settings` + `UiSettingsState`，存 client-state.json 按客户端持久化：

1. **开关** `visionBridgeEnabled`（默认开；关掉后图片原样发送 + warning notice「视觉桥已在设置中关闭」）
2. **转写模型** `visionBridgeModel`（"provider/id"，默认 null=自动选第一个；服务端 `buildAttachmentMessages` 里 `resolveReviewModel` 解析并校验 `getModel().input` 含 image，无效则回退自动发现）
3. **转写提示词** `visionBridgePromptMode`（"append"/"replace"，语义同 promptMode）+ `visionBridgePrompt`（自定义文本，空 = 内置默认）——经 `buildVisionBridgePrompt`（vision-bridge.ts 导出）组装后传给 `transcribeImages` 的 `systemPrompt`；append 在默认提示词后追加，replace 整体替换（空文本仍回退默认）；**提示词纳入批次缓存键**——改提示词后同图重发不再命中旧转写缓存

`settings_state` 带 `visionModels`（`collectVisionModels()` = `findVisionModels` 结果）供下拉选择；预设（preset）**不包含**视觉桥偏好（`SettingsPreset extends Omit<ClientSettings, "visionBridge…">`，apply 时保留当前值）；`setSettings` 里视觉桥字段变更**不触发** `applyRuntimeSettings()`（无需 reload，下次 prompt 即生效）。

**两个 replace 输入框都会预填"原本的提示词"**（settings_state 带 `defaultSystemPrompt` + `visionBridgeDefaultPrompt`）：切换替换模式时空输入框自动填入内置默认文本供直接修改，内容与默认一致时保存为空（= 使用默认），切回 append 不会出现重复追加。

## 文件对话（无工作区路径）

拖入输入框 / 📎 上传的任意文件带 `attachments[].fileData`（base64）发送——服务端写入全局目录 `~/.pi-web/uploads/<clientId>/`（**不放项目内**，`MAX_UPLOAD_BYTES` 20MB 上限），小文本（≤ `PI_WEB_INLINE_FILE_MAX` 且嗅探为文本）直接内联，其余以**绝对路径** reference 附加（read 工具支持绝对路径）。前端分流（`isRasterImage`）：**只有栅格图片**（png/jpeg/gif/webp/bmp/avif…）走 imageData 管线；**SVG 等矢量格式排除**——createImageBitmap 解码 SVG 会失败，SVG 作为普通文件附加让模型读源码更有用，其余文件走 fileData。

## 文件预览协议

- 客户端发 `{ type: "read_file", path, cwd?, requestId? }` → 服务端回 `file_content`（含 cwd、requestId、文本原始字节的 SHA-256 version，以及内容/类型/大小）。失败回 `file_result`（operation: read）。
- 保存发 `write_file`（path、text、cwd、requestId、expectedVersion；明确覆盖时 force: true），成功/失败均回 `file_result`（operation: write、cwd、path、requestId、ok；成功含新 version，冲突含 conflict）。服务端校验工作区、路径、文本类型和大小，比较磁盘当前版本后写入；版本比较到写入之间无 await，以串行处理本进程中的保存。与外部进程之间不提供文件系统事务锁。
- 写入保留原有 UTF-8 和 2MB 内容上限；磁盘文件超过读取上限或为二进制时拒绝编辑。工作区切换期间读写返回明确失败。协议版本同步至 v13。
- 只读文件前 **512KB**（`MAX_PREVIEW_BYTES`）；**内容嗅探决定文本还是二进制**：无 NUL、控制字符占比 < 2% 即按文本预览（`looksLikeText`）——未知/无扩展名文件（jsonl、.log.1 等）也能打开；**文本解码带 GBK 回退**（`decodeText`：严格 UTF-8 失败 → GBK → latin1，预览/内联附件/行附件都用它），Windows 老中文文件不再乱码；二进制返回 `binary: true`，`text` 为前 4KB 的**十六进制视图**（`hexDump`，前端 `.fp-hex` 渲染，可下载完整文件）。路径经 `resolve + relative` 校验，`..` 越界直接拒。
- **媒体预览走 HTTP**：image/video 经 `/api/file?clientId=…&path=…` 流式返回（`sendFile` 支持 Range），路径按**该客户端的会话 cwd**（打开的项目）解析，而非服务启动目录——两者可能不一致；`clientId` 缺失或会话不存在时回退到服务启动 `CWD`。路径校验统一走 `workspacePath()`（agent-service 导出）。
- 行号语义：**尾随换行不产生空行**（`countLines` 已修正），前后端 split 逻辑必须一致。

### 右栏编辑与草稿保护

文件列表与全局搜索共用 App 的打开入口。文件内容替换右栏列表，`FilePreviewContent` 是内容组件，`FilePreview` 保留可选弹窗外壳。单次只挂载一个文件，按 cwd + path 标识；文件树按路径缓存已展开目录、保留滚动位置；串行读取节点，Git 状态独立查询。列表隐藏时保留展开状态并停止轮询和 watcher 刷新。文本默认在带行号/语法高亮的编辑器中修改；Markdown 默认在渲染预览画布中可直接编辑，顶部可切「预览／源码」；两个模式共用一份草稿。图片/视频走媒体预览，二进制和截断文本只读。

文档打开后默认占剩余宽度的 45%，对话占 55%；拖动可见分隔条调整并保存比例，双击恢复默认；文件树宽度单独存于 localStorage。769–1200px 自动收起项目栏，≤768px 使用文档抽屉。Chat/终端/Git 切换或隐藏抽屉保留同一个编辑器实例；编辑器没有主动刷新和尺寸测量循环。快捷键仅处理文件区域内的 Cmd/Ctrl+S。

草稿只在匹配 cwd、path、requestId 的成功响应后更新保存基线。保存期间编辑器只读，断线/15 秒超时/错误保留草稿并取消待执行导航；冲突提供重新加载和二次确认覆盖。返回列表、另开文件和项目导航经过“保存后继续／放弃修改／取消”保护；保存后继续等待服务端成功。浏览器 beforeunload 提醒未保存修改，Electron 通过 will-prevent-unload 弹原生确认；普通关闭到托盘继续保留草稿。

代码编辑由 `CodeFileEditor` 的原生 textarea 承担输入、选区、IME 与撤销，惯性滚动同步到不可交互的高亮层。高亮层和输入层共用字体、行高、换行宽度与滚动条留白，不测量隐藏编辑器。文件标题、保存状态、预览／源码切换、Git 改动、显式引用和更多操作共占一行；已修改 Git 文件可在此打开差异视图。编辑草稿期间磁盘文件变化时显示重新加载／对比提示，保留用户草稿。

Markdown 使用原生 contenteditable，`rich-markdown.tsx` 按语法树的源位置记录段落。未改变的段落按原字节保存，改动段落用 Turndown + GFM 转回 Markdown（表格对齐、任务框、代码围栏保留）；前置元数据、独立 HTML 块、脚注和引用定义显示保留原文的块，可切源码编辑。表格或段落里的行内 HTML（如 `<dataDir>`、`<id>`）以不可执行的原文片段保留，不使整个容器退回源码；`<br>` 显示为换行，编辑保存时保留。内容 DOM 只在打开或外部替换草稿时初始化，按键和保存不会重建光标所在 DOM。文本粘贴按纯文本插入，链接点击不跳转。截图粘贴走 `POST /api/markdown-image`：沿用鉴权和同源校验，要求匹配已连接客户端的工作区，切换中拒绝写入；最多 5 MB 的 PNG/JPEG/WebP/GIF，经内容嗅探和真实路径边界校验，唯一命名写入文档同目录 `.assets/`，不使用有保留期的聊天上传目录。上传成功才在光标处插入图片相对路径，失败显示错误，组件卸载取消请求并忽略迟到结果。渲染时相对路径映射到带 cwd 校验的媒体接口，保存时还原原路径，不写入 token 或 clientId；放弃草稿不自动删除已写入的图片。原生撤销、重做只作用于该文档。正文顶部单行显示文件路径、保存状态、预览／源码、引用、改动和更多文件操作；仅进入富文本编辑后显示 Markdown 格式栏，有未保存修改时标题栏显示保存按钮。Markdown 仅在非列表段落等文本块开头输入 `/` 时可筛选并插入标题、正文、代码块、高亮块、表格、列表、任务列表、引用和分隔线；方向键选择、Enter 插入、Escape 保留输入并关闭菜单，编号列表、项目符号列表、任务列表，以及正文中间（包括空格、标点或加粗片段之后）、代码块和链接内不触发，保留普通 `/` 字符。选中表格单元格后显示局部行列操作，可在当前行下方加行、当前列右侧加列或删除当前行列；保留表头与至少一行一列。Tab/Shift+Tab 在单元格间移动，最后一格 Tab 自动加行，新增列继承相邻列对齐。代码块右上角可选择语言（含纯文本），语言元数据独立于正文撤销栈，切换更新高亮和保存的围栏语言；语言控件从序列化中剔除，不进入 Markdown。渲染编辑中的代码块保持原始行宽，长行横向滚动，不套用行内代码的边框；目录树的空格和换行保持原样。

回归：`tests/rendered-file-edit-test.mjs`（加 `--electron` 跑桌面壳，覆盖代码高亮、Markdown 语义及未改段落保真）、`tests/unit/file-edit.test.ts`（版本与访问校验）、`tests/file-editor-protocol-test.mjs`（真实 WS，纳入 smoke）、`tests/file-editor-ui-test.mjs`（真实浏览器）、`tests/file-editor-electron-test.mjs`（桌面壳）。

### SQLite 只读预览

`.db/.sqlite/.sqlite3/.db3` 文件，以及头部为 `SQLite format 3\0` 的无扩展名文件进入 `SqlitePreview`；文件树保留 `.codegraph` 目录。WS 的 `file_content.kind = "sqlite"` 只传元数据，表数据走带鉴权、同源检查与 cwd/clientId/requestId 归属校验的 `GET /api/sqlite`。返回字段类型、主键标识、表/视图、建表 SQL 和分页数据。切表、切文件或项目期间取消旧请求，迟到结果不更新当前页面；不做定时刷新。

查询复用 Node 内置 `node:sqlite` 的只读连接（[最低支持版本 API](https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html)），不开扩展、不接受任意 SQL。路径按真实路径验证工作区边界，表名先匹配 sqlite_schema 再做标识符转义。数据库连接额外启用 query_only、关闭 trusted_schema。查询由短生命周期子进程执行，全局最多 2 个，8 秒硬超时终止；锁等待最多 200ms。不会创建/修改业务表，也不引入数据库依赖或迁移。

每页最多 50 行，多读一行判断下一页；有主键时按主键排序。最多 500 张表、64 列、每格 256 字符，BLOB 只读取长度，64 位整数转十进制字符串避免精度丢失。视图查询失败仍保留表选择器，损坏/加密/非 SQLite 文件显示错误。外部修改可能影响翻页结果，可手动刷新回到首页；WAL 库由 SQLite 读取已提交数据。数据库结构操作和 SQL 编辑不在此入口提供。

验证：`tests/unit/sqlite-preview.test.ts`、`tests/sqlite-preview-test.mjs`（加 `--electron` 复核桌面版），覆盖隐藏目录、分页、空/损坏库、特殊标识符、值类型、真实路径边界、只读内容校验、迟到响应与查询超时不阻塞服务。

### 下载

`web/src/download.ts`：不用 `<a download href>`（Chrome Safe Browsing 会拦截非 HTTPS 源的无信誉文件类型如 .zip/.exe），而是 fetch → blob 保存；>200MB 回退原生导航流式下载；失败 toast 显示服务端错误正文（`downloadFailed` i18n key）。

**Windows 特例**：blob 锚点下载在 Windows 上仍可能被 Safe Browsing 静默拦截（无 JS 错误，表现为「点了没反应」）——Chromium 安全上下文（localhost/HTTPS）下优先用 `showSaveFilePicker` 直接写入用户选中的文件（绕过下载管线）；Windows 上保存名经 `sanitizeFileName` 清洗（`<>:"\|?*`、尾随点/空格、CON/COM1 等保留设备名）；取消保存对话框不算错误（`cancelled`，不弹 toast）。`download-test.mjs` 覆盖回归（已禁用 picker 以测 blob 路径）。
### 当前文件与编辑器快照

预览面板打开可编辑文件时，输入框上方自动出现「当前文件」chip——它是预览面板的**严格镜像**：始终只指向当前打开的文件，随其打开与关闭出现和消失，打开另一个文件即替换（不随历史累积）。切换或关闭预览时，当前对话及其他对话草稿中的手动整文件 inline/reference 附件一并清理；行号引用、文件夹引用和上传文件保留。chip 可按对话关闭，重新打开文件后恢复；截断、二进制等不可编辑文件不产生 chip。打开文件本身不会发送提问，需由用户输入并发送。标题栏「@引用」与「引用选中内容」是独立的手动附件，不与 chip 混用。

发送携带 chip 的消息时**先把未保存草稿落盘**（发送即保存）：磁盘 == 快照 == 模型的工作基准。快照（`PromptAttachment.editorSnapshot`：cwd、完整 text、dirty、version）在落盘成功后才取——dirty 为 false、version 为落盘后的新版本；落盘冲突（磁盘已被外部修改）不做"警告但照发"，而是复用编辑器的冲突 UI（重新加载／覆盖磁盘文件）阻止本次发送，输入内容保留。快照超过 512 KiB 在落盘前就阻止发送。同路径的整文件附件（inline/reference）被快照取代，行号引用保留。每条消息取发送时刻的最新草稿，历史消息的快照各自冻结。

服务端在构建任何附件前验证全部快照的工作区、真实路径边界、类型和大小；历史重问在 fork 前也验证。快照作为 file aside 传给 agent，明确来源、保存状态及优先分析要求，details 保存原快照供卡片和历史重问恢复。旧记录无此字段时保持原行为。prompt 的 requestId 与 prompt_result 在 SDK 预检通过后确认接收，校验失败或断线保留编辑中的问题及附件；仅自动标签不能触发发送。

SDK 的 nextTurn 缓冲不会随 steer/followUp 消费，因此附件在预检通过后进入对应队列；普通发送在 agent_start 时入队。带附件的运行临时使用 all 队列模式，让问题与文件卡一起消费，agent_end 恢复原模式。预检失败与仅执行扩展命令不留下下一轮文件快照。协议回归：`tests/current-file-protocol-test.mjs`（本地模拟模型，验证实际 SDK 请求）、`tests/unit/current-file.test.ts`；界面回归：`tests/current-file-ui-test.mjs`（chip 镜像、快照、取代与守卫）、`tests/file-open-ux-test.mjs`。

高亮块使用 `> [!NOTE]` 加引用正文保存为 Markdown，编辑器和只读 Markdown 渲染器共用标记转换；浅蓝底色仅属于显示样式。保存时不会写入 HTML 或编辑器属性，普通引用保持原样。回归：`tests/highlight-block-ui-test.mjs` 验证插入、编辑、保存重开与源码切换，`tests/unit/highlight-block.test.ts` 验证标记识别边界。

渲染 Markdown 编辑器顶部提供紧凑格式栏（撤销、重做、正文、H1/H2、粗体、斜体、列表、引用）；鼠标按下保留文档选区，操作复用现有编辑与保存路径，只读状态禁用按钮。Web 与 Electron 使用统一的本地 IBM Plex Sans／JetBrains Mono 字体、白色文档画布、暖灰导航和紫色操作色；文档正文 15px、行距 1.7，保留浅色代码块与高亮块。
