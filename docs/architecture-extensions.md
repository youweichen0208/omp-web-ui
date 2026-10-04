# Extensions 原生包管理

设置 › Extensions 对接 Pi 1.0.2 的 `DefaultPackageManager`、`SettingsManager` 和 `ProjectTrustStore`。安装、移除、更新与资源发现运行在独立 Node worker；浏览页面不执行扩展入口，缺失依赖采用 `resolve(() => "skip")`，不会因浏览自动安装。包变更在新会话生效，当前会话仅在用户点击重载时通过已有 `extensions_reload` 生效。宿主不向模型注册工具、注入消息或系统提示词。

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
