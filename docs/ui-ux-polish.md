# UI/UX 全页面优化与验收

## 依据和边界

用户指定 `ui-ux-pro-max-skill-2.15.0.tar.gz`，已读取其中 `.claude/skills/ui-ux-pro-max/SKILL.md`、quick-reference、pro-rules。已运行 design-system 查询，生成结果中的营销落地页结构与本产品不符，未采纳；进一步 style 查询确认 Minimalism & Swiss Style 适合专业工作台，采用清晰字重、克制表面、单一强调色。React 查询中的语义表单建议适用于本项目 React 18，未采用版本特定 API。

本项目以 `docs/ui-design.md` 为视觉事实源，保留暖灰/蓝色、现有系统字体、用户确认的文件树、无蓝色内框的输入区。不会引入远程字体、新组件库或修改原生代理生命周期。保持原有全部功能入口。桌面端共用前端；模拟壳验证与真正安装包实机验证分开记录。

## 页面清单（完成须有运行证据）

| 页面族 | 检查和优化范围 | 状态 / 证据 |
| --- | --- | --- |
| 应用外壳 | 顶栏/侧栏/状态栏、主题、窄屏导航、窗口控件 | 已验收共享前端；fluid-interface / desktop-toolbar 浏览器回归，Windows 为模拟壳，另有真实 macOS Electron Wiki/preload 集成通过 |
| 聊天 | 空态、消息、输入、附件、模型选择、队列、工具、等待、错误、任务产出 | brand-command-groups / changes-panel / model-config-ui 已通过；ui-ux-polish 覆盖四种内联请求的键盘提交及对话归属 |
| 文件 | 搜索、树、创建、代码/媒体/SQLite预览、编辑和保存状态 | 文件树、真实代码保存、SQLite 和 file-editor-protocol 通过；2400×1600 大图解码/缩放和 WebM 真实播放、四档明暗截图通过 |
| Wiki | 阅读/编辑/工具栏、目录、索引/搜索、右侧聊天、双链 | wiki-ui / wiki-panels / ui-workbenches 通过；搜索/阅读弹窗及保存失败离开确认的双向 Tab 通过 |
| 终端 | 标签、连接状态、命令配置、空态 | ui-workbenches 四档明暗布局及 terminal-smoke 通过 |
| Git / 改动 | 状态/分支/历史、diff、本轮/分支/工作区、窄屏 | 真实临时 Git diff、375px 上下布局和 changes-panel-ui 通过 |
| SSH 节点 | 来源/列表/详情、连接表单、Agent/终端/SFTP、错误状态 | node-workbench-browser 本地 mock 及四档布局通过；未连接真实节点 |
| 会话树 | 树/搜索/分支、label/摘要/草稿恢复 | session-tree 协议及浏览器、bookmark 双向 Tab 通过 |
| 设置 · 提示词 | 导航、分段、编辑器、状态、保存/重载 | system-prompt 浏览器流程和四档明暗布局通过 |
| 设置 · 技能 | 搜索/筛选、详情、启停 | extensions 浏览器搜索、启停落盘、重载与小屏通过 |
| 设置 · Extensions | 包列表、资源、编辑、安装/更新表单 | extensions 功能回归通过；安装/确认、编辑器共享焦点栈，安装和编辑双向 Tab 已通过 |
| 设置 · MCP/Codemode | 作用域、自动保存/高级选项、服务器表单/信任 | codemode-mcp 浏览器及 extensions 的 JSON 保存通过；JSON 编辑器双向 Tab 已通过 |
| 设置 · 更新 | 版本、检查中/成功/错误状态 | 当前 extensions 更新页面自动检查偏好、503 错误及刷新恢复通过 |
| 配置和弹窗 | 首次配置、模型/服务商、OAuth、目录选择、搜索、后台任务、扩展确认 | 共用焦点及 OAuth 嵌套通过，模型获取/元数据/错误通过；扩展内联请求、MCP/扩展编辑器及 Wiki 专有弹窗已验证 |
| 插件宿主 | 宿主空态/错误/设置容器（第三方插件内容不重写） | ui-plugin-polish 的挂载失败、重试恢复、小屏和切页保留状态通过 |

## 验证规则

每页先检查实际渲染，再记录修正和截图。覆盖 light/dark，375/768/1024/1440 和横屏；输入和长路径不造成页面横向溢出。检查可访问名称、键盘操作、可见焦点、弹窗焦点回收、减少动态效果、放大文字；代码和数据表保留自身横向滚动。使用隔离 data-dir、端口≥8900 的零 token 夹具，不连接真实节点、不调用模型。检验原生执行/保存/取消等语义不变。最终运行 typecheck、build、design、unit 与相关浏览器/协议回归，不以单个首页截图证明全页完成。

## 验收结果

全部页面族已完成本轮优化及验收。保留既有暖灰/蓝色视觉、文件树参考设计和无内层蓝框的输入区；统一弹窗焦点、改善小屏导航与工作台、文字可读性、触屏操作和失败恢复。以下检查点是执行过程记录，其中“待检查/未完成”描述当时状态；当前结论以本节和上方表格为准。

| 要求 | 当前证据 |
| --- | --- |
| 使用指定 skill、符合产品形态 | 已读取归档中的 skill/quick-reference/pro-rules，执行 design-system、style、UX 和 React 查询；采用适合开发工作台的规则，保留项目视觉规范 |
| 全部页面族 | 上表覆盖外壳、聊天、文件、Wiki、终端、Git、节点、会话树、五个设置页、配置/弹窗与插件宿主；共享样式和各页关键流程均有对应浏览器证据 |
| 响应式和双主题 | settings/workbenches/preview 四档 375/768/1024/1440；另有横屏、20px 根字体、reduced-motion，主题文字对比度实测 >=4.5 |
| 键盘及焦点 | 共享焦点栈，打开时同步转移、双向 Tab、关闭恢复；设置/OAuth/扩展/MCP/Wiki/节点/会话树有覆盖；内联请求保留非模态和原生响应值 |
| 文件与内容完整性 | 代码保存到盘、版本冲突协议、Wiki 编辑/失败/冲突/撤销、SQLite 只读、图片实际解码与视频实际播放通过 |
| Desktop + Web | Chromium 实际布局/交互；macOS 真实 Electron/preload/后端集成；Windows/macOS 工具栏模拟壳尺寸检查。未生成安装包，未声称 Windows 真机验收 |
| 工程门禁 | typecheck/build/design/unit 通过（104 文件，599 项通过、1 项跳过）；全量协议冒烟 72/72，后续纯 UI 修改追加对应浏览器回归 |
| 原生代理边界 | 没有修改代理调度/模型调用；使用本地夹具与 mock，未连接生产节点；无远程字体或新依赖 |

已知验证边界：页面族的布局矩阵与关键功能流程分别覆盖，未宣称每个功能状态都跑过所有尺寸的笛卡尔积。旧的 file-editor-ui、agent-working-ui 和 component-updates 浏览器脚本仍引用已移除界面，未作为通过证据；替代覆盖见下方检查点。真实跨平台安装包验收属于发布流程，本次没有推送或发布。

### 首批实现与证据

- 已实现共享 `useDialogFocus`，应用于设置、搜索、目录选择、首次配置、模型配置和后台任务弹窗。对下拉菜单触发的弹窗，关闭后恢复菜单触发按钮。ProviderAuth/嵌套弹窗/节点与 Wiki 专有对话框仍待检查。
- 已实现设置小屏顶部文字导航、选中状态语义和弹窗表单 16px 字号。
- `tests/ui-ux-polish-browser-test.mjs` 通过：设置/搜索焦点进入、双向 Tab 边界、关闭恢复；设置 5 页 × 375/768/1440 × light/dark 的渲染与截图（tests/scratch/polish-settings-*）。这些仅证明基础布局与导航，不代表安装/保存/信任等功能流程已验收。已人工检查 375px 浅色提示词页面截图。
- 当前仍需逐页检查真实内容、错误状态、长文本、横屏/放大及功能回归；未完成整个目标。

### Workbench verification checkpoint

- Git below 700px now stacks the file/history list above the diff, retaining independent scrolling. Branch and commit inputs have accessible names; errors use alerts. Long node paths wrap, touch workbench targets are at least 44px, and small-screen form inputs use 16px text.
- Wiki opens with the document visible at widths <=760px. Desktop still opens chat by default. Resizing alone does not override the user's panel choice. Mobile body/title sizes are 16/28px with 20px horizontal gutters.
- PASS: `tests/ui-workbenches-browser-test.mjs`: terminal/nodes/Git/Wiki at 375/768/1440 in light/dark; actual temporary Git diff; stacked diff geometry; mobile file-search navigation to Wiki and chat toggle. Screenshots: `tests/scratch/workbench-*`. Visually inspected phone Git, nodes, terminal, Wiki reading, and desktop dark Wiki.
- PASS: `tests/wiki-panels-browser-test.mjs` (simulated Windows shell panel reopening/resizing).
- PASS: `tests/node-workbench-browser-test.mjs` (local mock SSH connection, credentials, PTY input/output, SFTP, node isolation, source sync). Replaced the obsolete manual-workbench tab click with an assertion that manual terminal and Agent are simultaneously visible.
- PASS: typecheck, build, design tokens. This is partial evidence, not completion of the page checklist above. Next: file previews, session tree, settings detail/error states, remaining dialog families, landscape/text scaling/reduced-motion, and final regression.

### Third checkpoint: previews, session tree and remaining shared dialogs

- Extended the focus hook to conditional dialogs and generic element roots; node source/credentials/edit, session-tree navigation/bookmark/content, and provider authentication now retain keyboard focus and restore their opener. Settings and authentication check the active dialog before handling Escape.
- Improved small-screen tree/secondary-dialog input sizes, wrapped action rows, scrollable long content, and coarse-pointer preview controls.
- PASS: node browser regression including forward/reverse Tab in the new-node form; native session-tree protocol and browser suite including bookmark focus, branch navigation, summary outcomes, external changes, and draft protection.
- PASS: SQLite browser suite (tables/views, pagination, empty/corrupt data, int64/blob/null, read-only, workspace isolation and late responses).
- PASS: new `ui-preview-polish-browser-test.mjs`: edit and save a real code file, verify disk contents, verify editor intersects the viewport at 375/768/1440 in light/dark, landscape and reduced-motion. Visually inspected the mobile preview screenshot. Resizing to mobile requires opening the existing file drawer; the test verifies the actual viewport, not merely Playwright visibility of offscreen elements.
- PASS: shared dialog suite, now including repeated authentication dialogs above settings and Escape preserving the underlying settings dialog. Typecheck/build/design pass.
- Legacy `file-editor-ui-test.mjs` remains stale: it expects the removed thinking-segments control, fixed-time drawer animation, and Markdown inside the old preview rather than Wiki. Its source was left unchanged. Current preview test covers real code saves; comprehensive conflict/guard evidence still needs the current protocol tests in final regression.
- Still incomplete: settings detail workflows, Wiki search/edit flows, chat/error/queue states, plugin host, remaining accessibility/layout matrix and final regression. Do not treat this checkpoint as completion.


### Fourth checkpoint: current workflows and final shared checks

- Added a recoverable plugin mount-error surface, composer accessible name, readable skill descriptions, wrapped settings errors, and touch-visible message actions. Preserved the requested absence of an inner composer focus outline.
- Extended settings, workbench and file-preview matrices to 375/768/1024/1440 in both themes. The settings suite additionally checks 844×390 landscape, 20px root text, reduced motion, and computed text/dim/faint contrast >=4.5 on both page and elevated backgrounds. These are shared layout checks, not proof of every state in every page.
- PASS: typecheck, build, protocol sync, design tokens, 104 unit files (599 tests passed, 1 skipped), and the full zero-token smoke runner (72/72). Logs are local `/tmp/pi-polish-*`; screenshots are in ignored `tests/scratch/`.
- PASS browser workflows: system-prompt; extensions (now including an injected 503 during check, mobile error display, and refresh recovery); codemode-mcp; wiki-ui; changes-panel-ui; model-config-ui; brand-command-groups-ui; desktop-toolbar; fluid-interface; plugin host; preview; workbenches. Model test now joins a workspace and selects the visible composer menu before exercising its existing metadata/error assertions.
- The old component-updates browser case still targets removed application-update UI, old skill disclosure markup, and the former tab title. It was not rewritten to mask the obsolete assumptions. Current extensions browser tests cover the replacement update page. The smoke runner's component version protocol checks pass.
- The old agent-working browser case targets a removed Bash DOM class. Current brand-command-groups tests cover the active command, failure, queue and composer presentations. The old file-editor browser case remains obsolete as recorded above; code save, file-version conflicts and Wiki guards have current replacement coverage.
- Visually inspected skill contents, dark mobile updates, and landscape/scaled settings in addition to the previously recorded screens. Full completion is still unproven: audit nested extension/MCP/Wiki focus interaction, inline extension requests, remaining media/configuration states, then reconcile this checklist. No release or remote push performed.


### Fifth checkpoint: nested settings focus

- Replaced the extension install/confirmation dialog's independent focus trap with the shared dialog stack. Added the same stack participation to the extension file editor and MCP JSON editor. The parent Settings dialog no longer owns Tab traversal while these nested editors are open.
- PASS: typecheck, build, design tokens, extensions browser suite with explicit forward/reverse Tab assertions in install preview, file editor and MCP JSON editor; existing installation retry, editor persistence, and MCP JSON save assertions still pass.
- Extended preview coverage to a real decoded PNG, alt text, file-search navigation, and viewport containment at all four widths in both themes. The fixture is intentionally tiny: it proves decode and placement, not large-image scaling or video playback. Mobile dark image layout inspected. Those remaining media states and Wiki-specific dialogs still require inspection before completion.


### Final checkpoint: Wiki, inline requests and media

- Wiki search/navigation guards and reading dialogs now use the shared focus stack. Moving focus during layout avoids losing an immediate Escape between opening and the next animation frame. Current Wiki UI and autosave tests include search/info-dialog Tab loops and a failed-save navigation guard with retained draft after cancel.
- Inline extension requests retain their non-modal layout. Inputs have accessible names; Escape from an unrelated modal does not cancel the request underneath. The dialog matrix injects all four request kinds and verifies keyboard submission, multiline content, and conversation identity without a model call.
- Read-only media no longer claims it was saved. The preview fixture now generates a 2400×1600 PNG and a playable WebM using local Canvas/MediaRecorder, verifies decode, native video controls and playback time, and checks both themes at four widths. Mobile screenshots visually inspected.
- PASS: `wiki-ui-test`, `wiki-editing-test`, `wiki-electron-test` (actual local Electron), `ui-ux-polish-browser-test`, `ui-preview-polish-browser-test`, `extensions-test --browser`, typecheck/build/design/unit. The Electron test now explicitly joins its isolated fixture workspace before entering Wiki.
