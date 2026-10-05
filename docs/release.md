# 发布流程

> npm 发布者账号是 `youweichen`（`npm whoami` 验证），包名 `@youweichen/pi-web-ui`。当前项目独立维护，仓库为 `youweichen0208/omp-web-ui`。`dist/`、`web/dist/` 被 gitignore 不进 git，但 `package.json` 的 `files` 白名单会把它们打进 npm 包；`prepublishOnly` 会在发布前自动 `npm run build`。

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

# 4) 推送 GitHub（仓库公开：youweichen0208/pi-web-ui，分支 develop）
git push origin develop

# 5) 发布 npm（会自动跑 prepublishOnly 构建；scope 包必须 --access public）
npm publish --access public

# 6) 验证
npm view @youweichen/pi-web-ui version        # 应显示新版本（registry 有缓存延迟属正常）
curl -s https://registry.npmjs.org/@youweichen/pi-web-ui/latest | jq .version
```

## 注意事项

- 版本号必须在当前发布线递增且尚未占用；发布前用 `npm view @youweichen/pi-web-ui dist-tags --json` 核对。当前从 `0.6.x` 升至 `0.7.x`，不要为超过历史 `0.51.x` 擅自跳号。
- 提交信息不要带 `Co-authored-by`（P1 规则，仓库 hook 会拦）。
- `.pi/commands.json` 是**每个项目各自**的个人命令（当前 cwd 的 `.pi/ 下），已被 gitignore，永远不会进公开仓库；切换 cwd 时命令列表自动刷新为该项目的命令。
- 大改动发布前先问用户是否要 `npm publish`（会真实消耗账号权限、触发构建）。
- **升级后的重启**：`npm i -g` 只更新磁盘文件，已运行进程内存里还是旧代码——前端是每次请求实时读盘的（会先变新），但 WS 消息处理是进程内旧逻辑，新旧混跑会表现为「界面是新的、某功能一直加载中」。界面内「立即更新」（顶栏更新下拉）现在是在可见终端 tab 中跑 `npm i -g @youweichen/pi-web-ui@latest`（复用 SCM/插件卸载同款 tab 模式），完成后需手动重启服务生效：`pi-web-ui server restart`（launchd/systemd 由服务管理器拉起；Docker 需 `docker compose restart`）。服务端保留 `PI_WEB_RESTART_CHILD` 端口等待握手（restart-handoff-test 回归），供外部编排的替换子进程使用。
- **发布前检查示例文件不泄密**：`deploy/`、`README` 等随 npm 包（`files` 白名单含 `deploy/`）和 GitHub 分发的文件**绝不放真实 IP / 域名 / 密钥**——用占位符（如 `<LAN_IP>`、`<PUBLIC_IP>:<PUBLIC_PORT>`、`your-host`）。真实环境配置只在本地改，不进仓库。

## 历史 IP 泄露的清理方法

2026-08 实操过（`deploy/nginx-subpath.conf` 曾含 `192.168.1.101` / `39.99.235.208:60018`，波及 53/128 个 commit）：

1. 先改工作区文件为占位符；
2. `git filter-branch --force --index-filter 'if git cat-file -e :<file> 2>/dev/null; then BLOB=$(git cat-file blob :<file> | sed -e "s/<旧IP>/<占位符>/g" ... | git hash-object -w --stdin); git update-index --cacheinfo "100644,$BLOB,<file>"; fi' -- --all`（**不要用 xargs 传 cacheinfo**，Git for Windows 下参数会碎导致 `option 'cacheinfo' expects <mode>,<sha1>,<path>`）；
3. 重写后**手动把 tag 移到重写版**（`git tag -f vX.Y.Z $(git log main --format='%h %s' | grep -F '<tag的message>' | head -1 | cut -d' ' -f1)`，filter-branch 不会自动跟）；
4. 删备份分支 + `rm -rf .git/refs/original` + `git reflog expire --expire=now --all` + `git gc --prune=now --aggressive`；
5. 验证 `git rev-list --all | while read c; do git grep -l '<IP>' $c -- . 2>/dev/null; done` 为空后 `git push --force` main + tag。

**残留提醒**：已发布 npm 包的 tarball 无法追回（只能靠新版本替换）；GitHub 上被 force push 覆盖的旧对象对访问者不可见但服务器会留存（需联系 GitHub 支持彻底删）。
