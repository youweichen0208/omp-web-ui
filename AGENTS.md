# AGENTS.md — OMP Web UI

## 项目与架构

OMP Web UI 是 Oh My Pi 的 Web 与 Electron 界面。npm 包 `@youweichen/omp-web-ui`，CLI `omp-web-ui`，桌面名称 OMP，仓库 `youweichen0208/omp-web-ui`。Node >=22.19.0；Bun 和 OMP 随包安装，版本由 package.json 精确锁定。

Node/Electron 管理 HTTP、WebSocket、PTY、文件和 SSH；每个会话的 OMP 在独立 Bun 子进程运行。**修改运行时、工具、队列、模型配置、历史或打包前读 `docs/architecture-omp.md`。** 禁止重新引入旧 Pi SDK、私有 Agent 状态修改、rpiv-todo 或宿主伪调用恢复循环。

配置全新使用 `~/.omp/agent`；Web 数据 `~/.omp-web`，桌面数据 `~/.omp-web-desktop`。不迁移或修改旧 `~/.pi` 配置和历史。桌面内部 appId 保留 `com.youweichen.pi-web-ui`，Debian 包身份保留 pi，以维持安装器升级识别。

## 代码导航

| 路径 | 职责 |
| --- | --- |
| server/omp/ | Node 宿主接口、RPC 传输、模型目录、历史只读投影 |
| omp-worker/ | Bun bootstrap、OMP 会话与配置管理 |
| server/agent-service.ts | 每客户端多会话、事件、快照、项目归属与生命周期 |
| server/protocol.ts | 唯一 wire 类型源；web/src/types.ts 仅 re-export |
| server/serialize.ts、todo-progress.ts | OMP 消息和原生 todo 的 UI 投影 |
| server/prompt-delivery.ts | 附件与问题原子提交 |
| server/model-admin.ts | models.yml 和原生凭据管理；密钥不下发浏览器 |
| server/goal-service.ts | 应用目标、审查、调研向导；独立 OMP 会话 |
| server/settings-service.ts、webui-context.ts | 应用设置与官方 OMP UI RPC 桥 |
| server/terminals.ts | node-pty、持久终端工具、.omp/commands.json |
| server/node-workbench.ts | SSH/SFTP、命令确认、受限 OMP 节点会话 |
| server/plugins.ts | 应用界面插件；与 OMP 原生扩展分开 |
| web/src/use-chat.ts、App.tsx | WebSocket reducer、终端桥与布局 |
| web/src/components/ | 聊天、文件、终端、任务、模型和设置组件 |
| web/src/styles.css、i18n.tsx | 全部样式与 zh/en 文案 |
| electron/、electron-builder.yml | 桌面主进程、沙箱 preload、打包 |
| bin/omp-web-ui.mjs | CLI 与开机服务 |
| tests/、scripts/ | 单测、隔离协议/浏览器回归、协议检查 |

## 按修改范围阅读

- 快照、消息增量、安全、多会话、项目缓存：`docs/architecture-core.md`。
- 附件、文件编辑、保存冲突、离开保护：`docs/architecture-attachments.md`。
- PTY、SCM、后台端口：`docs/architecture-terminal.md`。
- 应用界面插件：`docs/architecture-plugins.md`；MCP 使用 OMP 原生配置，见 `docs/architecture-omp.md`。
- SSH 来源、凭据、执行确认、SFTP：`docs/architecture-nodes.md`。
- 清单合并、变化行、跳转高亮、布局：`docs/ui-design.md` 与 `web/src/todo-presentation.ts`。
- 桌面窗口、preload、窄窗口：`docs/deployment.md`。
- 开发与测试：`docs/development.md`；发布：`docs/release.md`；配置：`docs/env-vars.md`。

## 编码与验证

使用 Tab 缩进。文案走 useT()，zh/en 同时新增；样式集中在 styles.css。协议仅改 server/protocol.ts，发送端/接收端 switch 同步处理；破坏 wire 兼容时同步两端 protocol-version.ts。

```bash
npm ci
npm run dev             # 后端 8788，Vite 5173
npm run check:protocol
npm run typecheck       # 提交前必跑
npm run build
npm test
npm run test:smoke
```

测试使用独立端口 >=8900、mkdtemp 隔离 agent/data/workspace。只清理自己启动的 PID；端口占用直接失败，禁止 pkill -f 或按端口杀未知进程。OMP 会话夹具通过 tests/lib/omp-fixtures.mjs 创建，不手写旧 Pi 文件格式。纯协议测试不调用真实付费模型。

OMP `agent_end` 不是整个任务完成；以 `session_settled` 为准。异步 mutation、abort、dispose 必须 await 或显式处理失败。切换项目、快照和编辑操作始终校验 conversationId/cwd/requestId，保持服务端唯一事实源。

## 发布与部署

package.json 与 package-lock.json 同步版本。提交采用 Conventional Commits，不加 Co-authored-by。首个迁移候选版本是 1.0.0-beta.1，npm 使用 next；候选验证通过前不发布 latest。

桌面按平台重建 node-pty（npm run rebuild:electron），再打包、执行打包产物回归。其他 OMP 原生依赖属于 Bun，不能重建为 Electron ABI。GitHub Release 先保持 draft，三个平台验证和附件齐全后再公开。macOS 使用 ad-hoc 签名与手动下载更新，不要求付费 Apple 证书。

默认仅监听 loopback；远程部署显式配置 OMP_WEB_HOST、OMP_WEB_TOKEN。CLI 自启服务升级后需 `omp-web-ui server restart`。完整环境变量见 docs/env-vars.md。

结构或流程变化时同步本文与相关 docs。不要在指南中写入令牌、密钥或用户机器的临时测试状态。
