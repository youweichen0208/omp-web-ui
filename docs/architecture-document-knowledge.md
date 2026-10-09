# 文档转换与 OKF 知识整理

两个职责独立的内置原生 Pi inline extension 随服务端发布：`pi-harness-pdf-markdown` 与 `pi-harness-okf`。入口在 `nativeToolExtensions()`，实现分别位于 `server/document-conversion/` 与 `server/okf/`。转换器只负责忠实提取和来源定位；知识扩展只消费 Markdown／标准化证据包，不能导入转换器或 Python runtime。二者共享 `server/document-bundle.ts` 数据契约与 `server/document-extension-settings.ts` 设置存储，不互相调用。历史资源 ID 和设置键 `pdfEnabled` 保留以兼容已有关闭选择，现在代表全部文档转换。它们不属于根 `extensions/` 的 CLI 资源，也不伪装成 Extensions 包列表中的 npm 包。

## 使用与模型边界

```text
/pdf-md setup
/pdf-md cancel
/pdf-md doctor
/pdf-md convert ./raw/技术说明.pdf
/pdf-md setup chm
/pdf-md doctor chm
/pdf-md convert ./raw/开发手册.chm
/pdf-md settings
/documents convert ./raw/replication.cc
/okf ingest ./converted，输出到 ./knowledge
/okf review <jobId> [conceptId ...]
/okf status
/okf resume
/okf settings
```

自然语言也可以要求 Agent 调用这些能力。`document_to_markdown`、`pdf_to_markdown`、`chm_to_markdown`、`okf_ingest`、`okf_candidates`、`okf_publish` 经原生 tool_search 按需发现，支持 Codemode。转换和导入返回结构化结果，助手最终回复工作区相对 Markdown 链接，点击进入现有 Wiki。通用命令为 `/documents`，旧 `/pdf-md` 完全兼容；`/documents settings off` 停用全部转换工具，`/okf settings off` 独立停用知识整理，二者默认开启。工具说明让当前 Agent 按任务先转换再整理，不是扩展之间自动触发，也不会未经请求生成 Wiki。

解析使用本机 OCR、版面和代码识别模型。知识候选提取、含义核对、去重和冲突分析使用当前可见 Pi 会话及其选定模型，相关资料会作为该会话上下文发送到该模型端点。扩展不另建后台 Agent，不接入 OpenViking，不改原生 bash 或自动续跑策略。状态和文档进度分别持久化；`agent_settled` 仍是会话本轮结束依据，停止模型不等于导入完成。用户明确恢复后继续未完成工作。

服务实例级配置保存在 `<dataDir>/document-extensions.json`：`pdfEnabled`、`okfEnabled` 默认 true，`pythonPath` 和 `runtimePath` 为可选绝对路径。设置命令复用扩展 UI，保存后通过现有 `/reload` 或新会话更新工具发现；每次执行重新检查开关，因此停用立即阻止旧会话继续调用。当前宿主未绑定 SDK command context 的 reload action，扩展不声称调用 `ctx.reload()` 已重载。损坏的已有配置报错，不用默认值覆盖。开启扩展不会下载模型。

## 本机转换

默认候选为 Python 3.12、Docling 2.136.0 和 CPU 中文解析配置，固定 RapidOCR 3.9.1、Transformers 5.19.0；RapidOCR 3.10.0 已移除该 Docling 版本依赖的接口。setup 单独创建隔离环境、安装依赖并下载模型；记录实际依赖版本与模型指纹。普通转换开启离线模式并检查资源，缺失时返回诊断，不联网回退。macOS Intel 的当前依赖组合未经资格验证，自动安装明确拒绝；其他平台是否 ready 由实际自检决定，不能把官方兼容列表当作本项目的测试结果。

PDF 使用版面与阅读顺序识别、中英文 OCR、表格和代码处理；DOCX/PPTX/XLSX 直接走对应后端，MD/TXT 只规范编码和换行。简单表格采用 GFM；复杂表格保存结构数据及图像依据，代码保留原文和定位。Excel 公式不重算，缓存值与公式分别记录，缺少缓存不能生成数值。转换成功不证明内容准确，疑点通过警告和 partial 状态报告。

原生 PDF 代码只在可见字形、等宽字体、字符内容与坐标网格均可核对时重建空格和换行，保留核对依据。扫描代码、字符映射差异、不规则行距或多行字符串等无法证明保真的情况标为 partial，不把模型生成的缩进当成原文。

每份转换产出 `document.md`、`structure.json`、`source-map.json`、图片资产、原件快照 `original/source.<ext>`、交接清单 `bundle.json` 及内部转换 manifest。交接清单的 kind 为 `pi-harness-normalized-document`、version 为 1，记录来源 ID、原路径、格式、原件哈希、Git 版本、解析版本、状态、警告和交付文件哈希。原路径只是来源说明，消费者不会按该字段访问外部文件。整个目录可移动和归档。PDF 页码、Excel 单元格、幻灯片编号与规范化文本行号保持不同含义。缓存以原始内容、解析版本和配置为键；人工修改过的输出拒绝覆盖。

常见源码文件生成带语言的代码块，保留原始行号、文件路径、Git commit／branch。未提交或被忽略的文件标记为工作树快照，不冒充提交内容。当前 Agent 使用原生文件工具选择仓库内相关文件；不盲目把整个仓库拼成一篇文档。文本、Markdown 和源码转换不需要 Python。

Python 文件是服务端运行资源，`build:server` 在 tsc 后复制到 dist；Electron afterPack 检查入口存在。应用包不包含 Python、模型或本机资料。转换由独立子进程处理，取消、超时和服务退出只终止所属进程，不影响用户其他服务；环境安装可在发起安装的会话用 `/pdf-md cancel` 取消。单份 PDF 默认写入 `converted/`，与 OKF 知识目录独立。

### CHM 编译帮助文档

`chm_to_markdown` 和 `/documents convert <CHM 路径>` 复用转换器的输出保护、缓存、取消及来源指纹；结果以证据包交给 OKF，OKF 不直接解析 CHM。CHM 直接读取 HTML，不经过 PDF 或 OCR，不执行脚本、不访问外部资源。

`/pdf-md setup chm` 按需准备独立 Python 3.12 环境，安装固定版本的 [pylibmspack](https://github.com/bwhitn/pylibmspack) 与 [Markdownify](https://github.com/matthewwithanm/python-markdownify)，全部依赖锁定在 `python/chm/requirements.txt`；无需下载模型。环境默认位于 `<dataDir>/runtimes/chm-html-v1/`，配置 `runtimePath` 时位于其 `chm-html-v1/` 子目录；`pythonPath` 仍作为创建环境的 Python 路径。`/pdf-md doctor chm` 验证依赖版本并运行合成 CHM 离线自检。缺少环境时返回 setup 提示，不自动安装。CHM 资源放在独立子目录，不使既有 Docling 模型资格失效。

输出含整本 `document.md`、`topics/*.md` 章节文件、`assets/` 图片、`structure.json` 及 `source-map.json`。优先按 `.hhc` 目录顺序排列，未列入目录的 HTML 也保留；缺少可读目录时按成员路径排序并标 partial。章节间的链接按归档内路径解析，保留可映射的标题片段；命名锚点无法映射时退到章节并告警。标准 Markdown 阅读器可使用标题片段，当前 Wiki 打开对应章节文件。

HTML 声明及 CHM 语言信息用于中文／旧编码解码。`pre` 代码保留缩进、空行和反引号，简单表格使用 GFM；合并或嵌套表格保留结构并标 partial。图片复制为相对资产；远端图片、跨 CHM 链接、丢失资源、活动嵌入内容和不确定编码明确告警，不静默声称完整转换。HTML 中的脚本与样式不进入正文。来源定位用 `member` 表示 CHM 内的 HTML 路径，行号表示规范化章节 Markdown 的行，而非 PDF 页码。

CHM 原始文件仍受 100 MiB 输入限制；归档最多 10000 个成员、512 MiB 声明解压总量、单成员 20 MiB、HTML／目录文本及最终整本 Markdown 各 64 MiB。读取成员至有界内存，生成文件使用哈希名称；不把归档路径直接解压到文件系统。异常路径和大小写冲突的成员拒绝转换。完整章节与图片随 OKF evidence 一起归档和缓存，人工修改任一生成文件后拒绝覆盖。

## 可移交资料与 OKF

默认知识根为当前工作区的 `knowledge/`，可以指定其他工作区内目录：

```text
knowledge/
  manifest.json
  evidence/       # 全部已登记原文件的不可变版本、规范化结果和资产
  wiki/           # 唯一的 OKF bundle 根
    index.md
    log.md
    concepts/
    references/
    drafts/
  reports/
```

原文件保持只读。整个知识根一起移动才是包含证据的交付单元，单独复制 wiki 不保证外部证据链接有效。引用采用相对路径；清除可重建缓存不能清除交付目录里的证据。生成文件、来源版本和依赖关系在 manifest 中登记；运行检查点保存在应用数据目录。

WebUI 上传的 Markdown 可按明确的单文件路径直接导入，其他格式先转换为证据包。递归扫描不会遍历应用运行数据或整个上传目录。

OKF 只接受 `.md`／`.markdown`、证据包目录或其 `bundle.json`／`document.md`；直接传 PDF、CHM、Office 或源码会提示先转换。扫描证据包时只登记一次，不重复摄入 topics。普通 Markdown 的本地图片一并归档；证据包完整复制原件、章节和资产，检查全部文件哈希后复用页码、CHM member、源码行号等证据块，不再次解析原件。候选 `sourceHash` 是 Markdown 与归档依赖共同组成的来源版本；输入 Markdown 字节指纹为 `documentHash`。图片或其他依赖变化也必须重新核对。

manifest 的固定标识为 `kind: "pi-harness-knowledge"`、`version: 1`、`evidenceDirectory: "evidence"`。Wiki 仅对这种声明根的 evidence 跳过后台全文索引与撤销快照，普通同名目录不受影响。显式目录浏览和文件打开继续可用，证据快照在 Wiki 中只读；明确的相对文件链接允许打开未索引证据，仍经服务端真实路径校验。

格式依据固定为 [Google OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md)。wiki 中除各层 `index.md`、`log.md` 外的 Markdown 都是 concept，具有合法 frontmatter 和非空 `type`。Reference、草稿也遵循此规则，普通 raw/normalized Markdown 放 bundle 外。根索引保留 `okf_version: "0.2"`，索引和日志确定性生成。

## 候选、核对与发布

1. 扫描明确范围，保存来源 ID、内容指纹和原始快照。符号链接不得扩展登记范围，输出目录不得递归作为输入。
2. 逐份摄入 Markdown／已验证的证据包并保存检查点，不调用原格式解析器。错误保留在任务中。
3. Agent 提交候选陈述、概念身份、适用范围、证据块与摘录；`basis` 区分 fact／inference／hypothesis／outdated，`section` 可记录故障现象、条件、根因、验证、方案、规避、限制与未确认事项，`staleAfter` 为复审时间戳。无可用知识时明确提交空候选。
4. Agent 比较本批候选与既有概念，说明支持程度、比较对象及冲突。复制件可以复用解析，不算独立佐证；不同主体、时间或适用版本不简单合并。
5. 发布工具检查来源版本、实际引用、核对覆盖、输出归属和目标文件指纹，再生成知识、引用页、索引及报告。

单批最多 1000 个文件、总计 2 GiB（含本地图片），单个原文件最多 100 MiB，文本最多 16 MiB。任务、manifest 和事务日志也有大小限制，超限会明确报错并保留已保存状态；大量候选应分批或使用独立知识目录。工具返回有界摘要与分页指针，完整正文和审核记录通过返回的文件路径读取。

所有自动生成的知识概念均为 draft，包括有原文直接支持且 Agent 认为无冲突的结论。`/okf review <jobId> [conceptId ...]` 展示所选页面和阻塞问题，要求用户填写实际复核者与已经执行的验证，再通过确认对话框批准。它不是模型工具，取消不写入。非事实候选、缺失分类、未决冲突、不完整批次、过期复审日期和变化／修改过的证据均阻止 stable。引用页的 stable 只表示完整证据记录，不代表技术结论。hash 与摘录检查只证明引用及版本存在。未完成完整资料范围处理时不能报告“已完成全范围交叉验证”。

明确标记 `unsupported` 的候选表示已否决，不作为新知识或草稿发布；报告列出排除的候选与理由，完整陈述和审阅理由保存在同目录的 JSON 报告及私有作业记录中。若最新审阅撤回某个既有概念的全部支持，该概念保留旧证据并降为 draft，等待后续处理。

OKF 的 `status` 与 `verified` 不同。自动生成写实际生成者与时间，不填写 verified；人工批准后记录 `human:<identity>`、时间和复核说明，保存独立审计报告并更新索引。批准前重新检查页面、实时来源、原件快照、依赖、引用页和证据块，并核对展示时的指纹；变化后必须重新复核。verified 记录实际复核事件，不宣称自动证明技术结论。重新生成的概念回到 draft，来源刷新失效时清除当前 verified，历史复核报告保留。导入正文是资料，不能把其中提示当成执行命令。

知识目录是可 Git 管理的普通文件。复核后使用现有 SCM 查看 diff，由用户决定提交／推送；扩展不自动提交 Git，不部署 OpenViking 或额外知识库服务。目前复用 Pi 会话，没有额外接入 Hermes。

显式刷新发现源变化或删除时使相关知识待核对，保留旧证据；权限或读取错误不等于删除。新证据发生矛盾时保留双方。目标页被手工修改则保留原页，将本次变更作为草稿提案。写入经知识根互斥、版本预检及原子文件操作；中途失败保留可恢复状态，不把部分发布报告为全部成功。

目录刷新与明确选中的已登记单文件均可识别删除；只有已登记单文件的 `ENOENT` 按缺失来源处理。陌生不存在路径、权限错误或其他扫描失败会中止整批扫描，保留之前的知识状态。

Wiki 整次撤销不能只回滚知识 manifest 而保留已归档证据，遇到这种请求会在写入前整体拒绝。导入修订通过新一轮 ingest 或整个知识目录的版本管理处理；普通知识页的单文件编辑与撤销仍使用原有机制。

## 验证

单测覆盖来源指纹、候选引用、发布门槛、重复导入、源变化、人工修改、路径限制与恢复。`document-extensions-sdk-test.mjs` 通过真实 SDK 和本地模拟模型验证发现、Codemode、禁用、重载及命令，无真实模型费用。Wiki 单测覆盖 evidence 索引排除及明确路径打开，打包单测验证 Python 资源缺失会阻止打包。

真实解析质量须另用固定 PDF/Office 样本运行本机环境，对照阅读顺序、关键单元格、代码和定位；模拟解析器通过不能作为 Docling 质量结论。真实资料、运行记录和模型输出不加入代码仓库；解析在本机执行，语义整理按当前 Pi 模型端点处理。平台与质量验证结果以实际运行记录为准。

构建后可运行 `node tests/document-evidence-browser-test.mjs` 检查证据链接与只读展示；真实解析回归为 `PI_WEB_DATA_DIR=/绝对路径/隔离测试目录 node tests/document-conversion-real-test.mjs`，需先准备该目录下的解析环境。真实回归不下载模型、不调用聊天模型，不进入常规 CI。资格记录绑定 Python 解析脚本、夹具、依赖版本和模型指纹；资源变化会使原资格失效。

CHM 回归：使用独立环境运行 `python tests/document-chm-test.py`；CI 的 macOS、Windows、Linux 三平台均配置该离线测试。完整链路使用 `PI_CHM_TEST_RUNTIME=<包含 chm-html-v1/venv 的父目录> node tests/document-chm-integration-test.mjs`，验证转换、缓存、章节来源、OKF 发布、归档与人工修改保护。无需模型调用。额外的第三方真实压缩 CHM 样本仅在临时目录中验证，不随包或仓库分发。

2026-10-09 已在 macOS arm64 的隔离 Python 3.12 环境通过完整离线资格检查：中文扫描表格、原生短代码、含空行的长代码、字符映射歧义（必须 partial）和 DOCX/XLSX/PPTX 共 7 个合成样例。同组样例也通过 TypeScript 服务、真实 Python worker、输出目录交换与缓存复用的完整链路，核对表格行列、代码缩进、页码和相对图片引用；缺少公式缓存的 XLSX、合并单元格的 DOCX 均正确报告 partial。`tests/document-native-code-test.py` 另覆盖坐标网格、隐藏文字、比例字体和多行字符串等边界。该结果证明当前组合与保真检查可运行，不代表真实公司资料均能无误识别；Windows、Linux 和 Intel macOS 尚未实机验证。
