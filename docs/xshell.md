# Xshell 与 SSH 连接手册

Xshell 是 Windows 上独立的 SSH 客户端。它可以连接与 pi-web-ui 内置 SSH 节点工作台相同的 Linux/macOS 服务器，但 Xshell 会话和 pi-web-ui 节点资料分别管理。Xshell 不承载 pi-web-ui 的节点 Agent 对话。

## 用 Xshell 建立会话

1. 打开 Xshell，选择「文件 → 新建」（File → New）。
2. 协议选择 SSH，填写会话名称、远端主机名或 IP，以及 SSH 端口（通常为 `22`）。
3. 在会话属性的「连接 → 用户身份验证」填写用户名，并选择密码或公钥认证。若用公钥认证，在 Xshell 中指定**Xshell 客户端本机**可用的私钥；远端账号需已安装对应公钥。
4. 连接时，核对服务器主机密钥指纹，再决定是否接受。服务器换钥时先独立核实，不要直接覆盖旧信任。
5. 登录后可在 Xshell 的终端中运行 `pwd` 和 `whoami`，确认当前目录与远端账号。

界面名称可能随 Xshell 版本和语言变化。具体菜单和认证选项以 [Xshell 官方手册](https://www.netsarang.com/docs/Xshell8_manual.pdf) 为准。

## 与 pi-web-ui 工作台并用

在 pi-web-ui 顶栏打开「SSH 节点」，点 `＋` 新增节点，手动填写与 Xshell 会话相同的主机、端口和用户名。认证方式在 pi-web-ui 中单独设置：密码、客户端本机私钥路径或 SSH agent。连接时也需要单独核对主机密钥指纹。

两者可以同时连接同一台服务器，但各自打开的 shell 拥有独立的目录与环境。在 Xshell 中执行的 `cd` 不会改变 pi-web-ui 标签的目录；pi-web-ui Agent 只使用工作台中当前选中的终端。Xshell 会话配置目前不能直接导入 pi-web-ui；工作台的「导入 Remote-SSH 配置」指旧版 pi-web-ui 插件，不是 Xshell。

## 不使用 Xshell 时

Windows 与 macOS 都可以直接使用 pi-web-ui 的内置工作台。系统 SSH 命令也可用于先验证网络和账号：

```bash
ssh -p 22 user@your-host
```

更多工作台操作见 [内置 SSH 节点工作台手册](ssh-workbench.md)。
