# 附件、图片与文件处理

> 覆盖附件三种模式、图片问答、视觉桥、文件上传/下载/预览协议。

## 附件三种模式

`ClientMessage.prompt.attachments[].mode` 决定附件如何发送给模型：

| mode | 含义 | 服务端处理 |
| --- | --- | --- |
| `inline` | 内联全文 | ≤ `PI_WEB_INLINE_FILE_MAX`（默认 12KB）内联，超出自动降级为 reference |
| `reference` | 仅路径 | 发 `<file path="..." size="..."/>`，模型按需用 read 工具读 |
| `lines` | 选中行 | 发 `<file path="..." lines="2-3">```选中行```</file>`，只读该范围（读取上限 2MB，超限降级 reference） |

新附件与问题合并为一条原生用户输入，图片通过 SDK images 参数发送。历史独立 custom file 卡片仍可渲染和编辑恢复；其 `stripFileWrapper` 正则兼容 `lines="..."` 属性。

**消息序列化缓存按 `role:timestamp` 为 key——同一 prompt 的多个 aside 同毫秒创建会碰撞，必须靠内容指纹（`contentFingerprint`）区分，否则只有第一个渲染（已修，勿回退）。**

## 图片问答（无工作区路径）

粘贴（Ctrl+V）/ 拖入输入框（**整个窗口都是拖放目标**，issue #19：`.app` 根节点接文件 dragover/drop + 全屏 `.app-drop-overlay` 高亮；输入条与编辑器自身 handler stopPropagation 保优先级）/ 🖼 上传的图片带 `attachments[].imageData`（base64）+ `mimeType` + `name` 发送——服务端直接作为 image content 附加，不走文件路径（`path` 忽略）。浏览器端（`web/src/image-paste.ts`）先把图片等比缩到 ≤1568px、按需转 PNG/JPEG，保证 payload 在服务端 2MB 上限内（`MAX_PASTED_IMAGE_BYTES`）。当前模型不支持识图（`model.vision`）时前端提示警告。

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

文件列表、全局搜索与工具文件卡片共用 App 的打开入口；`.md` / `.markdown` 自动进入 Wiki 文档界面（见 `architecture-wiki.md`），其余文件继续右栏预览。下述 Markdown 画布说明仅适用于直接使用 `FilePreviewContent` 的场景。文件内容替换右栏列表，`FilePreviewContent` 是内容组件，`FilePreview` 保留可选弹窗外壳。单次只挂载一个文件，按 cwd + path 标识；文件树按路径缓存已展开目录、保留滚动位置；串行读取节点，Git 状态独立查询。列表隐藏时保留展开状态并停止轮询和 watcher 刷新。文本默认在带行号/语法高亮的编辑器中修改；Markdown 默认在渲染预览画布中可直接编辑，顶部可切「预览／源码」；两个模式共用一份草稿。图片/视频走媒体预览，二进制和截断文本只读。

文档打开后默认占剩余宽度的 45%，对话占 55%；拖动可见分隔条调整并保存比例，双击恢复默认；文件树宽度单独存于 localStorage。769–1200px 自动收起项目栏，≤768px 使用文档抽屉。Chat/终端/Git 切换或隐藏抽屉保留同一个编辑器实例；编辑器没有主动刷新和尺寸测量循环。快捷键仅处理文件区域内的 Cmd/Ctrl+S。

草稿只在匹配 cwd、path、requestId 的成功响应后更新保存基线。保存期间编辑器只读，断线/15 秒超时/错误保留草稿并取消待执行导航；冲突提供重新加载和二次确认覆盖。返回列表、另开文件和项目导航经过“保存后继续／放弃修改／取消”保护；保存后继续等待服务端成功。浏览器 beforeunload 提醒未保存修改，Electron 通过 will-prevent-unload 弹原生确认；普通关闭到托盘继续保留草稿。

代码编辑由 `CodeFileEditor` 的原生 textarea 承担输入、选区、IME 与撤销，惯性滚动同步到不可交互的高亮层。高亮层和输入层共用字体、行高、换行宽度与滚动条留白，不测量隐藏编辑器。文件标题、保存状态、预览／源码切换、Git 改动、显式引用和更多操作共占一行；已修改 Git 文件可在此打开差异视图。编辑草稿期间磁盘文件变化时显示重新加载／对比提示，保留用户草稿。

Markdown 使用原生 contenteditable，`rich-markdown.tsx` 按语法树的源位置记录段落。未改变的段落按原字节保存，改动段落用 Turndown + GFM 转回 Markdown（表格对齐、任务框、代码围栏保留）；前置元数据、独立 HTML 块、脚注和引用定义显示保留原文的块，可切源码编辑。表格或段落里的行内 HTML（如 `<dataDir>`、`<id>`）以不可执行的原文片段保留，不使整个容器退回源码；`<br>` 显示为换行，编辑保存时保留。内容 DOM 只在打开或外部替换草稿时初始化，按键和保存不会重建光标所在 DOM。文本粘贴按纯文本插入，链接点击不跳转。截图粘贴走 `POST /api/markdown-image`：沿用鉴权和同源校验，要求匹配已连接客户端的工作区，切换中拒绝写入；最多 5 MB 的 PNG/JPEG/WebP/GIF，经内容嗅探和真实路径边界校验，唯一命名写入文档同目录 `.assets/`，不使用有保留期的聊天上传目录。上传成功才在光标处插入图片相对路径，失败显示错误，组件卸载取消请求并忽略迟到结果。渲染时相对路径映射到带 cwd 校验的媒体接口，保存时还原原路径，不写入 token 或 clientId；放弃草稿不自动删除已写入的图片。原生撤销、重做只作用于该文档。正文顶部单行显示文件路径、保存状态、预览／源码、引用、改动和更多文件操作；仅进入富文本编辑后显示 Markdown 格式栏，有未保存修改时标题栏显示保存按钮。Markdown 仅在非列表段落等文本块开头输入 `/` 时可筛选并插入标题、正文、代码块、高亮块、表格、列表、任务列表、引用和分隔线；方向键选择、Enter 插入、Escape 保留输入并关闭菜单，编号列表、项目符号列表、任务列表，以及正文中间（包括空格、标点或加粗片段之后）、代码块和链接内不触发，保留普通 `/` 字符。标题菜单提供 H1–H6，支持 `/h1`–`/h6`、`/bt1`–`/bt6` 和完整拼音；每个元素都支持中文、英文、拼音和首字母搜索，菜单右侧显示简写（正文 zw、代码块 dmk、高亮块 glk、表格 bg、列表 lb、编号 bh、任务 rw、引用 yy、分隔线 fgx）。选中文字后，格式栏可添加黄／绿／蓝／粉／紫背景或清除标记；代码和原文保护块不允许文字标记。标记通过原生 hiliteColor 编辑，保留撤销栈，以固定色值的 `<mark style="background-color: #…">…</mark>` 存入 Markdown，重新打开可继续改色／清除。渲染仅识别完整配对、固定格式和允许色值的 mark，不启用任意 HTML；不支持 HTML 的外部 Markdown 阅读器可能不显示颜色。选中表格单元格后显示局部行列操作，可在当前行下方加行、当前列右侧加列或删除当前行列；保留表头与至少一行一列。Tab/Shift+Tab 在单元格间移动，最后一格 Tab 自动加行，新增列继承相邻列对齐。代码块右上角可选择语言（含纯文本），语言元数据独立于正文撤销栈，切换更新高亮和保存的围栏语言；语言控件从序列化中剔除，不进入 Markdown。代码块编辑时通过 CSS Custom Highlight ranges 实时着色，不重写输入 DOM，保留光标、IME 和原生撤销栈；Enter 使用原生 insertLineBreak，序列化、复制及语言切换统一读取 BR 换行，避免浏览器拆成多个 code 后丢行。`/dmk` 和 `/daimakuai` 可匹配代码块。渲染编辑中的代码块保持原始行宽，长行横向滚动，不套用行内代码的边框；目录树的空格和换行保持原样。

回归：`tests/wiki-format-editor-test.mjs`（所有指令别名、H1–H6、文字标记／撤销／保存／重开／改色／清除）、`tests/unit/text-highlight.test.ts`（渲染与 HTML 边界）、`tests/wiki-code-editor-test.mjs`（新代码实时高亮、单行换行、连续空行、撤销重做及 `/dmk`）、`tests/rendered-file-edit-test.mjs`（加 `--electron` 跑桌面壳，覆盖代码高亮、Markdown 语义及未改段落保真）、`tests/unit/file-edit.test.ts`（版本与访问校验）、`tests/file-editor-protocol-test.mjs`（真实 WS，纳入 smoke）、`tests/file-editor-ui-test.mjs`（真实浏览器）、`tests/file-editor-electron-test.mjs`（桌面壳）。

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

附件与问题合并为单条原生 prompt，图片经 images 参数发送，保持原生 steer/followUp 及用户队列模式。扩展命令在附件读取前分类，命令执行成功只清除命令正文，附件留在输入框；失败保留正文和附件。`prompt_result` 按 requestId/conversationId 回传 commandExecuted 与 attachmentsConsumed，命令不产生等待用户消息回显。协议回归：`tests/current-file-protocol-test.mjs`（本地模拟模型）、`tests/unit/current-file.test.ts`；界面回归：`tests/current-file-ui-test.mjs`、`tests/file-open-ux-test.mjs`。

高亮块使用 `> [!NOTE]` 加引用正文保存为 Markdown，编辑器和只读 Markdown 渲染器共用标记转换；浅蓝底色仅属于显示样式。保存时不会写入 HTML 或编辑器属性，普通引用保持原样。回归：`tests/highlight-block-ui-test.mjs` 验证插入、编辑、保存重开与源码切换，`tests/unit/highlight-block.test.ts` 验证标记识别边界。

渲染 Markdown 编辑器顶部提供紧凑格式栏（撤销、重做、正文、H1/H2、粗体、斜体、列表、引用）；鼠标按下保留文档选区，操作复用现有编辑与保存路径，只读状态禁用按钮。Web 与 Electron 使用统一的本地 IBM Plex Sans／JetBrains Mono 字体、白色文档画布、暖灰导航和紫色操作色；文档正文 15px、行距 1.7，保留浅色代码块与高亮块。

Wiki 使用同一个富文本编辑器的专用编辑态：自动保存、H1–H3 紧凑菜单、选区浮条和两色标记，正文中空格后也可触发 `/`。普通文件预览仍使用本节的格式栏与块首菜单规则。详见 [Wiki 22a 编辑态](architecture-wiki.md#22a-编辑态与自动保存)。

### bash 完整输出

工具结果下载使用独立 `/api/tool-output`，浏览器只提供客户端/对话/工具调用 ID。受鉴权的服务端查找原生结果引用并校验普通文件及真实路径，允许工作区或 SDK 临时输出；清理后返回不可用。详细边界与测试见 architecture-core.md。

## 原生队列中的附件

协议 v39：文件上下文与问题合并为同一条原生用户消息，图片使用 images 参数。模板携带文本附件时，通过锁定 SDK 1.0.4 内部 prompt-templates 实现先展开用户命令，再附加原文，以 expandPromptTemplates:false 投递。此时扩展 input 钩子收到展开后的正文且仅调用一次；普通命令、无附件模板和技能沿用原入口。同名扩展命令优先。适配器加载失败直接拒绝发送，保留草稿。

`server/user-attachments.ts` 从原生完整正文派生末尾完整 `<file>`、`<folder>` 和编辑器快照块；围栏内示例、残缺和有歧义的块保持正文。questionText/userAttachments 仅用于展示，不改历史正文。附件预览最多 12000 字符，恢复引用为原生 entryId + index；服务端只在当前对话原生条目解析完整原文，分支切换前解析完成，拒绝伪造引用。内联文件、选中行和编辑器快照重发不读磁盘；引用块仍保留原生路径引用语义。旧独立 file 消息也从原文恢复，图片沿用原流程。解析后的冻结原文只存在本次请求，不建立会话私有存储。

回归：`tests/unit/user-attachments.test.ts`、`tests/unit/prompt-delivery.test.ts`、`tests/current-file-protocol-test.mjs --browser`。撤回仍返回原生队列全文和图片，通过既有草稿保护恢复。

### 附件围栏与模板空白兼容（0.99.7）

内联文件、选中行和文本上传共用动态反引号围栏：长度为正文最长连续反引号数加一，至少三个。解析仅接受与开头完全相同的结束围栏行及其后的 `</file>`；历史三反引号消息允许正文含内部代码围栏，通过唯一的“围栏 + 结束标签”恢复，但不跨越后续独立宿主块。多个结束位置、残缺或嵌套歧义保留原文。编辑器 JSON 快照格式保持不变，恢复仍读取原生冻结内容。

模板名按任意空白分隔，覆盖换行、Tab 和 CRLF；扩展命令继续按 SDK 的字面空格分隔并优先执行。模板先展开再追加附件，input 钩子只执行一次。SDK 版本或内部模块不兼容时仍拒绝发送并保留草稿，不回退为独立附件队列项。
