# Extensions 原生包管理

设置 › Extensions 对接 Pi 1.0.4 的 `DefaultPackageManager`、`SettingsManager` 和 `ProjectTrustStore`。安装、移除、更新与资源发现运行在独立 Node worker；浏览页面不执行扩展入口，缺失依赖采用 `resolve(() => "skip")`，不会因浏览自动安装。包变更在新会话生效，当前会话仅在用户点击重载时通过已有 `extensions_reload` 生效。宿主不向模型注册工具、注入消息或系统提示词。

## 请求与运行边界

`/api/extensions` 位于公共鉴权中间件之后，校验同源、已连接 clientId、活动 cwd、工作区切换和 quiesce。HTTP 类型集中在 protocol.ts；独立于聊天 WebSocket 消息。来源预览返回绑定 clientId/cwd、20 分钟有效的 ticket；确认安装必须提交 ticket。列表与预览是只读操作，写任务全服务串行；日志有界 128 KB，关闭面板后可按任务 ID 恢复轮询。

worker 保留原生 npmCommand，项目和个人作用域使用相同原生安装路径。读任务最多 4 个，超时 2 分钟；写任务超时 20 分钟。worker 是独立进程组，超时和服务退出仅终止其所属进程树。Electron 通过 ELECTRON_RUN_AS_NODE 加载相同 worker。

Desktop 不打包应用自己的 `extensions/` 或声明其扩展入口。会话使用 Pi 原生用户目录与受信任项目资源发现，保留原生 Codemode/tool_search/MCP 工厂。CLI 的可选 `/webui` 入口只属于 npm 包；用户已配置的扩展不被 Desktop 删除或迁移。打包钩子拒绝夹带应用扩展，`wiki-electron-test.mjs` 验证用户扩展在启动和新会话中执行，并遵循原生禁用规则。

## 配置语义

包开关以原生四类资源过滤数组 `[]` 禁用全部资源，启用时恢复原配置。原过滤规则备份在 agentDir/webui-extension-filters.json；个人范围的备份跨项目共享。关闭项目 autoload delta 时显式改成完整禁用声明，重新启用恢复原 delta。单文件开关写入原生 `+absolutePath` / `-absolutePath`，不删除文件。

设置摘要在写任务开始及安装完成前校验，防止覆盖外部修改。SettingsManager 自身保留不相关字段并锁定写入；长安装遇到冲突时保留已安装文件并报告配置未覆盖。移到另一范围先安装并保存目标声明，再移除原声明，保留过滤规则；迁移不会清理原托管缓存。本地来源只移除引用。应用本身和内嵌 SDK 由应用升级流程管理。

未信任项目仅显示 settings.json 中的包声明，不读取项目包安装目录，不安装或启用。Extensions 不隐式授予信任。信任需要在原生 Pi 或已有 MCP 设置中明确操作。

更新检查、更新操作使用按范围隔离的原生内存 SettingsManager，避免原生 update(source) 同时更新两个范围或检查时被项目声明去重。SDK 判断版本和 ref 可更新性；固定 npm 版本、带 Git ref 的来源及本地文件不纳入更新。Git 工作树有未提交改动时阻止更新。范围/tag npm 来源只显示可更新标记，不把 registry/latest 当成满足范围的目标版本。

## 目录和展示

pi.dev 当前通过服务端 HTML 提供目录，没有依赖未公开 JSON API。extensions-catalog.ts 从 data-package-* 和文本中提取名称、类型、下载量、日期与版本，支持原站搜索、排序和分页。只渲染文本及校验后的 HTTP(S) 链接，不注入远程 HTML。目录格式变化时展示错误及原站入口。联网请求 15 秒超时、5 分钟缓存，缓存有界。安装预览从 npm registry 读取显式资源清单；Git 来源确认前不克隆，因此清单未知时明确提示审查源码。版本说明从仓库的 GitHub latest release 提取至多三条，并显示实际 release tag，不伪造包 changelog。

用户进入管理页后注册该工作区的后台更新检查，服务运行期间每 6 小时检查；最多记忆 32 个工作区。自动检查开关存放 agentDir/webui-extensions.json，关闭后停止后台检查。关闭设置不会自动安装或更新任何包。

单文件编辑仅允许资源发现结果中的受信任 standalone JS/TS 文件，最大 512 KB，严格 UTF-8；SHA-256 文件版本校验后原子保存，保留文件权限。浏览器编辑草稿有离开保护。桌面固定 IPC `openExtensionPath` 由本机服务将当前目录的包 ID 解析为已安装路径，主进程仅 reveal，不执行任意文件；浏览器提供复制路径。

## 验证

- tests/unit/extensions.test.ts：原生过滤恢复、单文件开关、未信任项目、范围迁移、本地移除、配置冲突、目录文本解析。
- tests/extensions-test.mjs：隔离配置和端口 9210，真实 SDK/HTTP 安装本地夹具、启停、卸载、编辑、鉴权和同源；`--browser` 覆盖中英文、安装确认、列表、目录、编辑与窄屏布局。目录 UI 使用确定性响应，真实 pi.dev 搜索另作联网验证。
- 原生上下文边界沿用 tests/new-chat-context-test.mjs。

## 设置 v2 的技能与更新

技能页通过 `/api/extensions` 的 `skills-list` / `skills-toggle` 读取 `NativeSkillsState`，`skills-service.ts` 使用原生包管理器发现资源并读取技能元数据，不执行扩展入口、不安装缺失依赖。技能名称与描述可搜索，并按个人、项目和包筛选。桌面使用已有固定目录 IPC 展示个人技能目录（服务端固定 ID `skills:user`，目录不存在时展示 agentDir）；浏览器提供复制路径。开关写入所属范围的原生 `skills` 过滤器，包技能仅修改对应包的 skills 字段，保留 extensions/prompts/themes 等字段。空过滤数组的禁用基线在启用一个技能时保留，避免误启用同包其他技能。涉及多个技能的同一自定义资源目录保持只读；临时资源和未信任项目不能写入。请求沿用工作区、来源、JSON、quiesce 与配置版本校验，和包操作共用写入互斥。写入后由用户点击原生 reload 或新建会话生效。

更新页复用 Extensions 的持久任务、更新所有包、检查和服务器自动检查偏好；管理页提供安装、启停、编辑与重载，v3 同时允许针对单个包使用已有原生更新动作。隐藏应用自己的 pi-harness 项和 standalone 文件；Pi 只展示 Desktop 内置版本，不允许独立升级锁定 SDK。自动检查在管理页进入后按已有六小时间隔执行；安装策略明确为手动，未增加后台安装行为。浏览器回归覆盖开关实际落盘、更新页项目过滤、MCP JSON 编辑以及 390px 布局。


## Extensions v3（第 8 版设计）

浏览 pi.dev 改为紧凑列表，点击行展开唯一详情，按钮独立触发预览或原生更新。搜索按 300ms 防抖提交名称、作者或描述关键字，分类与排序、翻页均通过目录服务。总数来自原站计数，缺失时只显示本页数量。描述有中文字段时优先使用中文，否则保留原文；自动翻译尚未启用，不额外调用模型。

只读 `details` 动作复用来源校验及 npm 元数据读取，返回 `ExtensionPackageDetails`，不签发安装 ticket、不安装或执行包。展开资源标签统计 manifest 显式声明项；目录或通配符不推断实际文件数量，未提供声明时提示未知。许可证未声明时显示未知。请求带 AbortSignal，切换展开项忽略迟到响应。来源预览仍独立签发 ticket，并保留作用域、信任、版本与写任务互斥校验。

包安装状态按原生 npm 声明匹配，同名多作用域时优先选择可更新的受信任、未固定且非保护条目，按钮将其 ID 传给原生更新流程。其他已安装项只显示已安装，不从目录 latest 推断更新资格。安装确认保持 480px 弹窗，展示资源声明、个人/项目设置路径及命令预览；未信任项目不可选择。任务运行时保留弹窗并锁定操作，失败保留日志末尾，重试重新预览获取 ticket，成功后返回已安装列表并标注新包。

已安装页签数量仅统计包，不包括单文件；文件保留路径、打开/复制、重载、开关和展开编辑。键盘支持页签方向键、弹窗焦点循环及关闭后焦点恢复。更新页继续隐藏 pi-harness 和单文件。扩展回归同时覆盖失败重试、详情只读权限、中英文、深色与 390px 窄屏。
