# 发布流程

## 1.2.1 文档转换与桌面修复

从 develop 的 1.2.0 合入未发布改动，拆分文档转换和 OKF 知识蒸馏，增加 CHM、证据包与本地上下文评测。修复扩展 worker 生命周期及重复刷新、Windows 字体与布局、SSH/Agent 双栏、Wiki 模型选择（#46–#50）。SDK 1.0.4、协议 v41 不变。`verify-rendering.yml` 验证实际 Windows 100%/125% 和 macOS 打包版字体及截图；本机 macOS 补充原生 1440×900 窗口。npm 使用网页登录验证发布。

Windows 的 PowerShell 步骤通过 `| Out-Host` 等待 Electron GUI 可执行文件退出，再读取 `$LASTEXITCODE`；否则可能在测试仍运行时读取空值或旧退出码。1.2.1 首次发布的 worker 已输出 PASS，但宿主脚本提前判失败，修正发布脚本后单独重建 Windows；应用源码与 v1.2.1 标签保持一致。单平台重建通过后仍需核对三平台产物及 CI，再公开草稿。

> npm 发布者账号是 `youweichen`（`npm whoami` 验证），包名 `@youweichen/pi-harness`。当前项目独立维护，仓库为 `youweichen0208/pi-harness`。`dist/`、`web/dist/` 被 gitignore 不进 git，但 `package.json` 的 `files` 白名单会把它们打进 npm 包；`prepublishOnly` 会在发布前自动 `npm run build`。

## 1.2.0 文档转换与 OKF 知识整理

新增默认开启的原生 PDF 转 Markdown 与 OKF Wiki 扩展，支持本地解析、来源归档、Agent 候选核对、冲突草稿、增量恢复与人工编辑保护。合入最新 develop，SDK 1.0.4、协议 v41 不变。发布 npm latest 与三平台桌面 Release；说明见 `.github/release-notes/v1.2.0.md`。本地解析环境和模型单独 setup，macOS arm64 已完成真实离线资格验证。

## 1.1.0 节点 Agent 与工作区修复

合入最新 develop，交付 #31–#45：SSH 原生远端 Agent、文件创建、Wiki 面板与大文档性能、会话重启、Plan／扩展／拖放修复及工具卡片优化。SDK 1.0.4、协议 v41 不变。发布 npm latest 和三平台桌面 Release；说明见 `.github/release-notes/v1.1.0.md`。

## 1.0.0 首个正式版

从 origin/develop 发布，功能在 0.99.16 的基础上，补齐发布前审查：DNS rebinding、路径与符号链接、桌面口令与子进程口令隔离、口令 cookie 只发给已认证请求、防嵌入响应头、`clientId` 校验、`auth.json` 加锁与私有文件权限、WebSocket 异常消息容错、空闲会话回收、强制恢复打开原会话、长会话缓存与消息 ID 稳定、改动面板未跟踪文件与大差异、Wiki 段间距与大文档输入、Docker 数据持久化与默认只绑本机、SSH `TCP_NODELAY`、生产依赖漏洞清零、npm 包、命令、服务与应用标识统一改名为 pi-harness（不兼容旧包），并更正 macOS 15 与 Windows 首次打开说明。SDK 1.0.4、协议 v41。旧包 `@youweichen/pi-web-ui` 停在 0.9.0，新包从 1.0.0 开始；说明见 `.github/release-notes/v1.0.0.md`。

复审补齐 Linux 原生构建工具链、恢复销毁竞态、完整消息身份与历史摘要窗口化、跨入口 reload 串行、桌面日志上限和 CLI 配置目录继承；部署手册补充旧容器数据迁移。

## 0.99.16 Wiki 编辑与对话修复

从 origin/develop 发布，修复斜杠代码／表格菜单定位、新对话思考强度继承，以及 Wiki 索引导致保存和发送卡顿的问题。SDK 1.0.4、协议 v41 不变。发布 GitHub 源码与三平台桌面 Release；说明见 `.github/release-notes/v0.99.16.md`。

## 0.99.15 对话与代码改动（35a）

按第 23 个设计包实现独立代码改动面板、每轮成功文件汇总和历史命令折叠，支持本轮／整个分支／未提交、词级差异、文件定位、搜索与窄屏抽屉。包含 develop 上的 pi-harness 包名和命令更名。版本按本次要求从未发布的 1.0.0 准备状态调整为 0.99.15；SDK 1.0.4 不变，协议 v41。发布 GitHub 源码与三平台桌面 Release；说明见 `.github/release-notes/v0.99.15.md`。

## 0.99.14 Wiki 文档页 v2 与工具恢复状态

实现 34a Wiki 工具栏、表格/代码插入、Mermaid、本地衬线标题和宽版；实现 33a 工具异常统一状态、单次提醒与恢复卡片，修复自动提醒误确认历史计划。合入 develop 的 PR #22，保留 #21。SDK 1.0.4、协议 v40 不变。GitHub 桌面发布由三平台构建及产物回归完成后公开；说明见 `.github/release-notes/v0.99.14.md`。

## 0.99.13 主题令牌与 Wiki 样式修复

统一 Codemode、MCP、Extensions、Wiki 与输出状态配色，清理重复输入框样式和历史圆角；Wiki 输入框仅在聚焦且有内容时显示蓝色描边，代码配色统一跟随应用外观。新增全前端设计令牌检查并接入 npm test / CI。包含 develop 已合入的未执行工具调用恢复与认证锁等待修复。SDK 保持 1.0.4、协议保持 v40。本次发布 GitHub 源码和三平台桌面 Release，不发布 npm。发布说明见 `.github/release-notes/v0.99.13.md`。

## 0.99.12 界面统一与工具异常手动恢复

按第 19 版设计统一浅深色变量、等待状态与 Wiki 圆角；工具指令作为正文返回时支持手动重发原问题或换模型重发，保留附件与草稿，并在顶栏、右栏及当前计划步骤显示中断。同步设计规范与历史归档。SDK 保持 1.0.4、协议保持 v40。本次发布 GitHub 源码和三平台桌面 Release，不发布 npm。发布说明见 `.github/release-notes/v0.99.12.md`。

## 0.99.11 进度输出、等待状态与安全修复

从 origin/develop 发布，右栏改为进度／输出双分区，输出限定成功创建或修改的文件；同步第 17 版等待指示器、孤立协议标签过滤与未执行工具指令提示。包含 WebSocket 异常消息容错、页面嵌入与 clientId 防护、子进程 token 隔离及 SSH 终端延迟修复。SDK 保持 1.0.4、协议保持 v40。本次仅发布 GitHub 源码和 macOS／Windows／Linux 桌面 Release，不发布 npm。发布说明见 `.github/release-notes/v0.99.11.md`。

## 0.99.10 阅读层级、运行输入与安全修复

从 origin/develop 发布，包含 Wiki 文档画布、命令标题与连续重试合并、文件结果侧栏、28a 运行输入框及计划状态修复；原生 plan 默认开启并保留已保存偏好。同步 DNS rebinding、工作区路径、桌面 token、凭据文件并发写入与私有文件权限修复。SDK 保持 1.0.4、协议保持 v40。本次仅发布 GitHub 源码和 macOS／Windows／Linux 桌面 Release，不发布 npm。发布说明见 `.github/release-notes/v0.99.10.md`。

## 0.99.9 原生计划与工作区体验

新增默认关闭的原生 plan 扩展及全局开关，支持分支版本化、压缩背景恢复、聊天计划卡和右栏执行记录；修复历史待确认计划覆盖当前请求状态的问题，完善连续命令分组和工作区界面。SDK 保持 1.0.4，协议升至 40。本次发布 GitHub 源码与三平台桌面 Release，不发布 npm。说明见 `.github/release-notes/v0.99.9.md`。

## 0.99.8 Pi 1.0.4 与原生资源审查

SDK / pi-ai 及配套 Pi 依赖升级至 1.0.4，系统提示词适配 hiddenTools，模板适配器保持原生展开契约。新增上游 MCP 关闭、Codemode 结束状态及图片回归；协议保持 39。原生能力、既有异常恢复问题与资源基准见 [审查报告](pi-native-resource-review.md)。本次发布 GitHub 源码与三平台桌面 Release，不发布 npm。说明见 `.github/release-notes/v0.99.8.md`。

## 0.99.7 附件围栏与大输出下载修复

修复 Markdown 围栏导致附件卡片和编辑恢复失败、模板名后换行导致附件被二次解析、完整日志清单读取导致内存上涨或超过字符串上限。扫描仅限原生 MCP/Codemode，分块读取前 8 MiB，完整文本不截断。补充历史兼容和 SDK 升级契约检查。SDK 保持 1.0.3、协议保持 39；发布 GitHub 源码和三平台桌面 Release，不发布 npm。说明见 `.github/release-notes/v0.99.7.md`。

## 0.99.6 附件、输出下载与品牌对齐

修复模板附件与原生队列投递、扩展命令附件保留、会话尾部校验闪烁；新增原生消息附件卡片和冻结内容重问恢复、多文件工具输出清单与二进制下载。按第 13 版设计包统一蓝色品牌、方正圆角、无底板标志与 Wiki 快捷提问。SDK 保持 1.0.3，协议升至 39。本次发布 GitHub 源码与三平台桌面 Release，不发布 npm。说明见 `.github/release-notes/v0.99.6.md`。

## 0.99.5 会话校验与运行体验完善

会话文件基线与元数据核对改为异步分块，超长记录通过 worker 校验；新增全部待发消息撤回与草稿保护，尊重原生队列模式。完整工具输出下载覆盖压缩前历史及 MCP/Codemode，压缩状态显示原因及前后 token 数。SDK 保持 1.0.3，协议升至 38。本次发布 GitHub 源码与三平台桌面 Release；说明见 `.github/release-notes/v0.99.5.md`。

## 0.99.4 会话文件校验与列表性能修复

修复 touch 等元数据变化触发只读和中断的问题；首次绑定完整核对 SDK 内存与文件，避免绑定前外写漏检。正常追加继续只读新增尾部，历史列表以最多 8 路并发读取分叉数。SDK 保持 1.0.3，协议保持 37。本次发布 GitHub 源码与三平台桌面 Release；说明见 `.github/release-notes/v0.99.4.md`。

## 0.99.3 配色与会话文件读取修复

采用图标蓝主色、珊瑚色 Git 计数与黄色运行状态，统一圆角及 24px logo；运行开关移入思考菜单，长路径缩写。外部修改检测改为尾部增量校验，历史列表分叉统计采用缓存的只读解析。修复无摘要切换状态、编辑重问失败提示及跨机器重试倒计时。SDK 保持 1.0.3，协议升至 37。发布 GitHub 源码与三平台桌面安装包；说明见 `.github/release-notes/v0.99.3.md`。

## 0.99.2 原生会话树、Pi 1.0.3 与新图标

`0.99.2` 一并交付原生会话树的只读可视化、分支切换/摘要/书签、原地编辑重问及派生命令。SDK / pi-ai 精确锁定 1.0.3，原生提示词适配器同步校验该版本；会话树协议为 36。GitHub 仓库与桌面更新源改为 `youweichen0208/pi-harness`。网页和三平台打包图标统一使用 `icon-1a/1a-flat` 素材。npm 包名、CLI 命令与桌面应用标识沿用现有值。本次发布 GitHub 源码与三平台桌面 Release，不发布 npm。说明见 `.github/release-notes/v0.99.2.md`。

Pi 1.0.3 将 Azure provider 从 `azure-openai-responses` 改为 `azure`。使用该 provider 的用户需按上游说明更新原生 auth.json / models.json / settings.json 或重新登录；WebUI 不自动改写用户凭据。

## 0.99.1 对话设置与依赖安装修复

`0.99.1` 修复原生配置保存后对话级自动压缩、自动重试开关被还原的问题，默认工具改为读取时回退；统一 lockfile 下载地址到 npm 官方源，并在 CI 安装前校验。Pi SDK / pi-ai 保持 1.0.2，协议保持 35。说明见 `.github/release-notes/v0.99.1.md`。

## 0.99.0 原生工具与运行状态

`0.99.0` 修复原生工具元数据与完整输出下载，隔离扩展 UI，补齐 RPC 交互并展示原生压缩/重试状态。Pi SDK / pi-ai 保持 1.0.2，协议升至 35。说明见 `.github/release-notes/v0.99.0.md`；本次发布 GitHub 源码和三平台桌面 Release，不发布 npm。

## 0.18.1 Wiki 编辑与 Extensions v3

`0.18.1` 包含下述 Wiki 编辑与 Extensions v3 改进，并同步 Windows 工具栏回归的安装入口文案。说明见 `.github/release-notes/v0.18.1.md`；本次发布 GitHub 源码与三平台桌面 Release，不发布 npm。

## 0.18.0 构建候选（未公开）

Windows 工具栏检查仍使用旧安装按钮文案，发布被阻断；保留草稿，以 0.18.1 完成修正后重新构建。

`0.18.0` 实现第 7 版 Wiki 编辑设计与第 8 版 Extensions 列表设计：自动保存、保存冲突与桌面关闭保护，精简文档工具栏和请求改动展示，以及包目录展开详情、安装确认和失败重试。说明见 `.github/release-notes/v0.18.0.md`；本次发布 GitHub 源码与三平台桌面 Release，不发布 npm。

## 0.17.0 设置 v2 与 Wiki 临时会话

`0.17.0` 实现设置 v2、原生技能筛选与启停，将扩展更新集中到更新页并移除 pi-web-ui 自身条目。Wiki 发送前快照不再等待索引，文档对话采用原生内存会话，不写入项目历史，退出后清理空闲临时会话。说明见 `.github/release-notes/v0.17.0.md`；本次发布 GitHub 源码与三平台桌面 Release，不发布 npm。

## 0.16.0 Wiki 编辑增强

`0.16.0` 为全部文档斜杠菜单指令增加拼音与首字母别名，补齐 H1–H6，支持选中文字背景标记；修复新建代码块实时高亮、换行与保存丢行问题。说明见 `.github/release-notes/v0.16.0.md`；本次发布 GitHub 源码与三平台桌面 Release，不发布 npm。

## 0.15.2 Wiki 文档切换提速

`0.15.2` 将正文读取与索引、引用和原生会话初始化分离，保留编辑草稿并处理快速导航与失败重试；同步包含 Wiki 阅读布局、代码配色和请求意图修正。说明见 `.github/release-notes/v0.15.2.md`；本次发布 GitHub 源码与三平台桌面 Release，不发布 npm。

## 0.15.1 Wiki 与 Desktop 修复

`0.15.1` 修复文档打开时的对话面板、文档会话隔离和思考状态；内置 Pi / pi-ai 升级至 1.0.2。Desktop 排除应用扩展资源，继续按用户的原生 Pi 配置加载扩展。说明见 `.github/release-notes/v0.15.1.md`；发布 GitHub 源码与三平台桌面 Release。

## 0.15.0 Wiki 对话面板

`0.15.0` 将 Wiki 对话改为右侧常驻面板，支持实时消息、建议小节跳转、按项目记忆及窄屏抽屉；保留预览编辑和原生上下文。说明见 `.github/release-notes/v0.15.0.md`；本次发布 GitHub 源码和三平台桌面 Release。

## 0.14.2 桌面修复版

`0.14.2` 修复桌面完整退出后项目列表及当前目录恢复，以及网页链接交给系统默认浏览器打开。旧版临时客户端记录保留但不自动合并。说明见 `.github/release-notes/v0.14.2.md`；本次发布 GitHub 源码和三平台桌面 Release。

## 0.14.1 正式版

`0.14.1` 包含以下 0.14.0 功能，并修复 Markdown 服务端解析器未列入生产依赖的问题。三平台重新构建，增加包内依赖解析检查；说明见 `.github/release-notes/v0.14.1.md`。

## 0.14.0 构建候选（未公开）

`0.14.0` 更新 Wiki 阅读布局并默认支持预览内编辑，移除标签和消息显示入口，设置统一为 20a 紧凑列表，MCP / Codemode 常用控件自动保存。SDK / pi-ai 保持 1.0.1，协议版本 34。说明见 `.github/release-notes/v0.14.0.md`；npm 使用 `latest`，桌面三平台验证及附件齐全后公开 Release。

## 0.13.0 正式版

`0.13.0` 统一设置窗口布局，增加浅色/深色/跟随系统及应用更新按钮，移除界面插件设置入口。点击 Markdown 文件直接进入 Wiki，取消独立 Wiki 标签。SDK / pi-ai 保持精确锁定 1.0.1，协议版本 34。发布说明见 `.github/release-notes/v0.13.0.md`；npm 使用 `latest`，桌面三平台验证及附件齐全后公开 Release。

## 0.12.0 正式版

`0.12.0` 增加原生 Extensions 包管理和系统提示词文件编辑，移除独立生图工作台。SDK / pi-ai 保持精确锁定 1.0.1，协议版本 34。发布说明见 `.github/release-notes/v0.12.0.md`。npm 使用 `latest`；三平台桌面构建、验证及附件检查全部成功后公开 GitHub Release。

## 0.11.0 正式版

`0.11.0` 增加完整 Wiki 文件工作台与原生 Codemode/MCP 展示，SDK / pi-ai 精确锁定 1.0.1。协议版本 31。Wiki 操作、搜索、改动历史与手动撤销不追加宿主系统提示；原生上下文继续与独立 pi 会话一致。发布说明见 `.github/release-notes/v0.11.0.md`。npm 使用 `latest`，GitHub 使用 `v0.11.0` 标签，三平台桌面附件通过构建验证后公开。

## 0.10.0 正式版

`0.10.0` 移除 WebUI 自定义代理与上下文接管，保留文件和手动节点工作台，使用原版 pi 1.0.0。Codemode 和工具搜索使用原生配置默认开启。协议版本升至 30；旧历史保留。发布说明见 `.github/release-notes/v0.10.0.md`。npm 使用 `latest`，GitHub 使用 `v0.10.0` 标签，桌面附件全部构建验证后公开。

## 0.8.8 正式版

`0.8.8` 将内置 Pi SDK 升级至 0.99.2，接入原生 MCP/Codemode、官方账号授权、嵌套调用和图片展示，并保护模型编辑/刷新中的类型与额外配置。说明见 `.github/release-notes/v0.8.8.md`。npm 使用 `latest`；GitHub 标签使用 `v0.8.8`。

桌面工作流先创建 draft；macOS/Windows/Linux 各自构建、检查打包后的启动/SQLite/原生工具/OAuth，并上传验证后的附件。三个平台全部成功、安装包与更新元数据齐全后，最后一个 job 才公开 Release。手动单平台重建只更新附件，不单独公开草稿。macOS 打包前运行终端回归，确保 node-pty 补丁在签名前进入产物。

## 0.8.6 正式版

`0.8.6` 整理 Web 与桌面版的聊天任务清单：连续成功更新合并成展开卡片，后续只记录变化，支持跳回历史清单并高亮任务项；保留失败展示、跨轮次状态与 clear 身份隔离。npm 与三平台桌面版统一版本。说明见 `.github/release-notes/v0.8.6.md`。

## 0.8.5 正式版

`0.8.5` 修复长任务中的重复伪调用恢复、工具超时状态混淆，以及 SDK 异步准备期间用户插队后过期纠正提示仍执行的竞态。纠正按原生工具成功结果重新允许，每轮最多 3 次；保留停止及排队边界。npm 与三平台桌面版统一版本。说明见 `.github/release-notes/v0.8.5.md`。

## 0.8.4 桌面正式版

`0.8.4` 修复伪工具调用恢复被 todo 状态阻断的问题，并补充历史会话中明确继续后仅口头承诺的单次纠正；保留停止、排队与等待边界。本次发布 GitHub Release 及三平台桌面安装包。说明见 `.github/release-notes/v0.8.4.md`。

## 0.8.3 正式版

`0.8.3` 明确 `/new` 与 `/compact` 遵循 pi SDK 原生语义，修正 `/new` 命令说明，并将会话身份、历史恢复、取消及上下文隔离的回归测试纳入 CI。npm 与三平台桌面版统一版本。说明见 `.github/release-notes/v0.8.3.md`。

## 0.8.2 正式版

`0.8.2` 修复正文伪工具调用导致任务中断时的恢复与状态判断，保留停止、排队和当前任务边界；修复扩展消息缓存碰撞，优化历史摘要和模型附加内容提示。npm 与三平台桌面版统一版本。说明见 `.github/release-notes/v0.8.2.md`。

## 0.8.1 正式版

`0.8.1` 加强 todo 实施引导，区分任务清单与执行记录，移除任务总标题并整理设置菜单；修复节点页右侧设置入口意外出现。npm 与三平台桌面版统一版本。说明见 `.github/release-notes/v0.8.1.md`。

## 0.8.0 正式版

`0.8.0` 内置原生 rpiv-todo 任务清单，改进扩展名称展示，并新增组件更新检查和用户扩展手动更新。pi Agent 与内置任务清单随应用升级；npm 与三平台桌面版统一版本。说明见 `.github/release-notes/v0.8.0.md`。

## 0.7.4 正式版

`0.7.4` 修复会话切换后的空白终端与 `/new` 重置行为，更新工作区顶栏、运行命令和任务提纲，并明确 `task_plan` 与 skill 的流程边界。npm 与三平台桌面版统一版本；说明见 `.github/release-notes/v0.7.4.md`。

## 0.7.3 正式版

`0.7.3` 修复 `/new` 后延迟快照引起的旧消息和用量残留，补充节点 Agent 发送后的等待动画与状态提示。发布说明见 `.github/release-notes/v0.7.3.md`。

## 0.7.2 正式版

`0.7.2` 修复 Windows/Linux 顶栏窗口按钮占位，并支持来源节点在本机切换密码／公钥认证。Windows 发布增加顶栏浏览器回归门槛。npm 与桌面版统一版本；说明见 `.github/release-notes/v0.7.2.md`。

## 0.7.1 正式版

`0.7.1` 加入一次性 bash 默认超时兜底，改进项目栏折叠／调宽、设置入口、Xshell 本机私钥绑定与任务记录排版，并移除来源更新提示。npm 与三平台桌面安装包统一版本；说明见 `.github/release-notes/v0.7.1.md`。

## 0.7.0 正式版

`0.7.0` 发布 Xshell/OpenSSH 来源同步与节点工作台，修复工具输出快照重复追加，并补充 SSH 后台执行指导。沿当前 `0.6.x` 发布线升级；历史 `0.51.x` 不作为当前版本线的升级基准。npm 与三平台桌面安装包统一版本；说明及同步限制见 `.github/release-notes/v0.7.0.md`。

## 0.6.10 正式版

`0.6.10` 修复长命令卡片标题换行、任务进度重复标题、思考模式按钮样式、编辑结果缺少可见变化，以及折叠消息摘要排版。Web、npm 包及 macOS／Windows／Linux 桌面安装包统一使用 `0.6.10`。发布说明见 `.github/release-notes/v0.6.10.md`。

## 0.6.9 正式版

`0.6.9` 修正工作中输入框提示、任务标题和阶段展示、命令输出卡片及编辑零差异卡片；底栏显示 pi-web-ui 自身版本号。Web、npm 包及三平台桌面安装包统一使用 `0.6.9`。发布说明见 `.github/release-notes/v0.6.9.md`。

## 0.6.8 正式版

`0.6.8` 统一发布编辑／写入逐行 diff 卡片、任务面板状态与阶段摘要修正，以及精简后的上下文窗口和缓存命中用量弹窗。Web、npm 包和 macOS／Windows／Linux 桌面安装包使用同一版本号。发布说明见 `.github/release-notes/v0.6.8.md`。

## 0.6.7 正式版

`0.6.7` 为任务面板加入按任务规模分级展示：纯聊天不显示任务，单阶段直接列操作，多阶段汇总结果和过程，长任务可由 pi 提前给出并更新计划。修复新对话首条消息被推到消息区底部的问题，调整助手等待提示的位置，并移除输入框下方重复的快捷键提示。Web、npm 包和 macOS／Windows／Linux 桌面安装包使用同一版本号。

## 0.6.6 正式版

`0.6.6` 修正助手等待状态间距，收紧输入工具栏，并将右栏任务进度整理成阶段与结果卡片；文件栏移除「本次对话涉及」。按自检、推送源码、发布 npm `latest`、推送 `v0.6.6` 标签、核对三平台安装包的顺序发布。

## 0.6.5 正式版

`0.6.5` 增加从对话记录推断的当前任务步骤、工具与模型静默状态区分、连续写入卡片和文件操作分组，并修复长命令展开／收起。发布顺序：自检 → 推送源码 → 发布 npm `latest` → 推送 `v0.6.5` 标签触发三平台桌面包 → 核对 Release 附件。

## 0.6.4 正式版

`0.6.4` 将 npm、GitHub Release 和三平台桌面安装包统一到同一个版本，包含输入框用量显示、终端字符表格与路径链接、长消息折叠、等待状态间距修正等。发布前运行类型检查、构建、单测、协议冒烟、浏览器回归及 `npm pack --dry-run`。推送源码后发布 `@youweichen/pi-web-ui@0.6.4` 到 npm `latest`，再推送 `v0.6.4` 标签触发桌面安装包构建。最终核对 npm `latest`、工作流和 macOS/Windows/Linux 附件。

## 0.6.3 正式版

`0.6.3` 修复消息导航、用户消息折叠与命令输出预览，并在输入框显示上下文和模型缓存用量。推送 `v0.6.3` 标签会触发 macOS、Windows、Linux 安装包构建并生成 GitHub Release。本次 GitHub 发布与 npm 分开；只有完成 `npm publish` 后才将 npm 版本说明改为 `0.6.3`。

## 0.6.2 正式版

`0.6.2` 修复工作区文件误报、命令输出展示、断线时的工作状态与桌面服务恢复，并在 Web/Desktop 底栏显示运行版本。发布前核对 npm 版本未占用，保持 `package.json` 和 `package-lock.json` 一致，运行协议检查、类型检查、构建、单测、冒烟测试及 `npm pack --dry-run`。提交并推送源代码后，以 `npm publish --access public --tag latest` 发布 npm 包；推送 `v0.6.2` 标签会触发 macOS、Windows、Linux 的 Electron 安装包构建，生成正式 GitHub Release。最后核对 npm `latest`、GitHub Release 状态与三平台安装包。

**版本排序提醒**：SemVer 将 `0.6.x` 排在旧正式版 `0.51.2` 之前。npm 的 `latest` 标签可指向 `0.6.2`，但依赖范围 `^0.51.2` 不会自动升级；依赖方需要显式更新版本范围。后续版本规划需考虑这一历史编号。

## 步骤

```bash
# 1) 升版本（patch/minor 视改动；npm 上已存在该版本会 404 拒绝）
#    两处都要改，保持一致：
#      package.json 的 "version" 和 package-lock.json 的 "version"（第 2 行 + packages[""]）

# 2) 自检 + 构建
npm run typecheck
npm run build

# 3) 提交（Conventional Commits：feat/fix/perf/chore(scope): 描述，说明 why）
git add -A
git commit -m "feat(files): <一句话描述>"

# 4) 推送 GitHub（仓库公开：youweichen0208/pi-harness，分支 develop）
git push origin develop

# 5) 发布 npm（会自动跑 prepublishOnly 构建；scope 包必须 --access public）
npm publish --access public

# 6) 验证
npm view @youweichen/pi-harness version        # 应显示新版本（registry 有缓存延迟属正常）
curl -s https://registry.npmjs.org/@youweichen/pi-harness/latest | jq .version
```

## 注意事项

- 版本号必须递增且尚未占用；发布前用 `npm view @youweichen/pi-harness dist-tags --json` 核对。1.0.0 起包名为 `@youweichen/pi-harness`，第一次发布即为 1.0.0。旧包 `@youweichen/pi-web-ui` 停在 0.9.0，不删除（npm 只允许在 72 小时内或满足低下载量等条件时撤销，撤销后已安装用户也无法重装），改用 `npm deprecate @youweichen/pi-web-ui "已改名为 @youweichen/pi-harness：npm uninstall -g @youweichen/pi-web-ui && npm install -g @youweichen/pi-harness"` 让安装时显示迁移提示。
- 提交信息不要带 `Co-authored-by`（P1 规则，仓库 hook 会拦）。
- `.pi/commands.json` 是**每个项目各自**的个人命令（当前 cwd 的 `.pi/ 下），已被 gitignore，永远不会进公开仓库；切换 cwd 时命令列表自动刷新为该项目的命令。
- 大改动发布前先问用户是否要 `npm publish`（会真实消耗账号权限、触发构建）。
- **升级后的重启**：`npm i -g` 只更新磁盘文件，已运行进程内存里还是旧代码——前端是每次请求实时读盘的（会先变新），但 WS 消息处理是进程内旧逻辑，新旧混跑会表现为「界面是新的、某功能一直加载中」。界面内「立即更新」（顶栏更新下拉）现在是在可见终端 tab 中跑 `npm i -g @youweichen/pi-harness@latest`（复用 SCM/插件卸载同款 tab 模式），完成后需手动重启服务生效：`pi-harness server restart`（launchd/systemd 由服务管理器拉起；Docker 需 `docker compose restart`）。服务端保留 `PI_WEB_RESTART_CHILD` 端口等待握手（restart-handoff-test 回归），供外部编排的替换子进程使用。
- **发布前检查示例文件不泄密**：`deploy/`、`README` 等随 npm 包（`files` 白名单含 `deploy/`）和 GitHub 分发的文件**绝不放真实 IP / 域名 / 密钥**——用占位符（如 `<LAN_IP>`、`<PUBLIC_IP>:<PUBLIC_PORT>`、`your-host`）。真实环境配置只在本地改，不进仓库。

## 历史 IP 泄露的清理方法

2026-08 实操过（`deploy/nginx-subpath.conf` 曾含 `192.168.1.101` / `39.99.235.208:60018`，波及 53/128 个 commit）：

1. 先改工作区文件为占位符；
2. `git filter-branch --force --index-filter 'if git cat-file -e :<file> 2>/dev/null; then BLOB=$(git cat-file blob :<file> | sed -e "s/<旧IP>/<占位符>/g" ... | git hash-object -w --stdin); git update-index --cacheinfo "100644,$BLOB,<file>"; fi' -- --all`（**不要用 xargs 传 cacheinfo**，Git for Windows 下参数会碎导致 `option 'cacheinfo' expects <mode>,<sha1>,<path>`）；
3. 重写后**手动把 tag 移到重写版**（`git tag -f vX.Y.Z $(git log main --format='%h %s' | grep -F '<tag的message>' | head -1 | cut -d' ' -f1)`，filter-branch 不会自动跟）；
4. 删备份分支 + `rm -rf .git/refs/original` + `git reflog expire --expire=now --all` + `git gc --prune=now --aggressive`；
5. 验证 `git rev-list --all | while read c; do git grep -l '<IP>' $c -- . 2>/dev/null; done` 为空后 `git push --force` main + tag。

**残留提醒**：已发布 npm 包的 tarball 无法追回（只能靠新版本替换）；GitHub 上被 force push 覆盖的旧对象对访问者不可见但服务器会留存（需联系 GitHub 支持彻底删）。
