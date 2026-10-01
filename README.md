# pi-web-ui

[中文](#快速开始) · [English](#english)

pi-web-ui 是独立维护的 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) Web 与桌面界面。在浏览器或 Electron 窗口中使用 Agent 对话、文件树与预览、附件、终端、模型管理，以及内置的 SSH 节点工作台。

SSH 工作台让 macOS 或 Windows 上的本机 pi-web-ui 服务连接 Linux/macOS 节点：左侧按组管理节点，中间开多个 SSH 终端标签并通过 SFTP 浏览文件，右侧是各节点独立的 Agent 对话。Agent 使用当前选中的远端终端执行命令，输出在终端中可见。节点的实际操作权限由远端账号或容器决定。

## 快速开始

需要 Node.js **22.19.0 或更高版本**，以及至少一个已配置的 pi 模型服务商（`~/.pi/agent`）。

```bash
npm install -g @youweichen/pi-web-ui
pi-web-ui                         # 打开 http://127.0.0.1:8787
pi-web-ui --port 9000 --cwd /path/to/project
```

不安装到全局也可以运行 `npx @youweichen/pi-web-ui`。升级后若使用开机自启服务，运行 `pi-web-ui server restart`，让服务端加载新版本。

### 版本与升级

正式版通过 `npm install -g @youweichen/pi-web-ui@latest` 安装，桌面安装包见 [GitHub Releases](https://github.com/youweichen0208/pi-web-ui/releases)。`0.6.x` 的 SemVer 排序低于旧版 `0.51.2`；如果你在其他项目的依赖中固定了 `^0.51.2`，请显式改为 `^0.6.2` 才会切换到本系列。可运行 `npm view @youweichen/pi-web-ui dist-tags --json` 核对 npm 标签。

## SSH 节点工作台

1. 打开顶栏「SSH 节点」，点击左侧 `＋` 新增节点。填写分组、名称、地址、端口、用户名、认证方式和默认目录。
2. 选择密码、本机私钥路径或本机 SSH agent 认证。密码和私钥口令保存在本机加密存储中；导入、导出节点 JSON 不包含凭据。
3. 首次连接时核对远端主机密钥指纹，再选择信任。密钥变化会阻止连接；确认服务器换钥后，可在节点编辑窗口清除旧信任并重新核对。
4. 连接后打开终端标签。右侧 Agent 使用当前选中的标签，保留该 shell 的目录和环境；运行时锁定人工输入，命令及结果同时显示在终端和对话中。

节点资料分别保存在每台客户端，不自动同步。可从旧版 Remote-SSH 插件导入主机资料，旧配置不会被删除，凭据需要重新填写。SSH 工作台与本地项目终端相互独立。

详细步骤、密钥配置、SFTP、故障排查见 [内置 SSH 节点工作台手册](https://github.com/youweichen0208/pi-web-ui/blob/develop/docs/ssh-workbench.md)。Windows 用户如果还使用外部 Xshell，可参考 [Xshell 与 SSH 连接手册](https://github.com/youweichen0208/pi-web-ui/blob/develop/docs/xshell.md)。

## 其他功能

- 多项目与多对话、消息流式显示、文件树与预览、文件附件和编辑。
- 本地终端（xterm.js + node-pty）、Git 视图、模型及思考强度选择。
- 中文和英文界面、声音提醒、可选插件及 pi 扩展。
- CLI、开机自启服务、Docker 与 Electron 桌面版。

## 运行与部署

```bash
pi-web-ui server install    # macOS: launchd；Windows: 计划任务；Linux: systemd
pi-web-ui server status     # 也支持 start、stop、restart、uninstall
```

默认只监听 `127.0.0.1`。如果需要从其他设备访问，请参阅 [部署手册](https://github.com/youweichen0208/pi-web-ui/blob/develop/docs/deployment.md) 配置监听地址与 `PI_WEB_TOKEN` 鉴权；不要直接把未保护的 Web 界面暴露到公网。Docker 与环境变量也见 [部署手册](https://github.com/youweichen0208/pi-web-ui/blob/develop/docs/deployment.md) 和 [环境变量列表](https://github.com/youweichen0208/pi-web-ui/blob/develop/docs/env-vars.md)。

桌面安装包在 [GitHub Releases](https://github.com/youweichen0208/pi-web-ui/releases) 提供。Electron 使用同一套服务端和界面，桌面版数据目录是 `~/.pi-web-desktop`，CLI 默认是 `~/.pi-web`；pi 的对话历史仍由 `~/.pi/agent` 管理。安装包目前未签名。源码构建方式见 [部署手册](https://github.com/youweichen0208/pi-web-ui/blob/develop/docs/deployment.md)。

## 开发

```bash
npm ci
npm run dev            # 后端 :8788，Vite :5173
npm run typecheck
npm run build
npm test
npm run test:smoke
```

项目架构与测试规范见 [docs/development.md](https://github.com/youweichen0208/pi-web-ui/blob/develop/docs/development.md)。源码及问题反馈位于 [youweichen0208/pi-web-ui](https://github.com/youweichen0208/pi-web-ui)。

## English

pi-web-ui is an independently maintained web and Electron interface for the pi coding agent SDK. It includes chat, file browsing and editing, attachments, a local terminal, model management, and a built-in SSH node workbench with grouped hosts, multiple PTY tabs, SFTP files, and a separate Agent conversation for each node.

Requires Node.js **>= 22.19.0** and a configured pi model provider. Install with `npm install -g @youweichen/pi-web-ui`, then run `pi-web-ui`. See the [SSH workbench guide](https://github.com/youweichen0208/pi-web-ui/blob/develop/docs/ssh-workbench.md), [Xshell guide](https://github.com/youweichen0208/pi-web-ui/blob/develop/docs/xshell.md), and [deployment guide](https://github.com/youweichen0208/pi-web-ui/blob/develop/docs/deployment.md).

## License

MIT
