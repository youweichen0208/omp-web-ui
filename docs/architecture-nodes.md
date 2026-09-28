# 内置 SSH 节点工作台

顶栏「节点」打开节点来源与分组详情，连接后切换为左侧 SSH PTY/SFTP、右侧独立 Agent 对话的工作台。Windows/macOS 客户端都由本机 Node 服务通过 `ssh2` 连接 Linux/macOS SSH 服务；远端账号或容器决定实际权限。

## 数据与认证

- `<dataDir>/nodes.json` 存节点 ID、分组、地址、端口、用户名、认证方式、私钥路径、默认目录与已信任的 SHA-256 主机密钥指纹。密码和私钥口令使用 `PluginSecrets` 写入 `<dataDir>/node-workbench/secrets.bin`，共享 `<dataDir>/secrets.key` 加密密钥。
- 「导入 Remote-SSH 配置」仅读取旧插件的 `ssh-hosts.json` 元数据，不删除原配置，也不读取或导入旧插件的加密凭据。需要重新填写密码或私钥口令。导入/导出 JSON 只传非机密字段。
- 首次连接先给浏览器展示主机密钥指纹；信任后才允许认证。已保存的指纹变化时服务端阻止连接。指纹在每台客户端各自保存，不跨设备同步。

## 连接、终端与 Agent

- `NodeWorkbench` 按 `clientId:nodeId` 保存连接，终端按 `terminalId` 定位，所有可变请求要求与节点和会话身份匹配。断线时保留浏览器的已断开标签。重连恢复节点选择与 Agent 会话，终端需重新打开。
- 节点 Agent 用 `SessionManager.continueRecent` 将每个客户端/节点的历史存于 `<dataDir>/node-sessions/<clientId SHA-256>/<nodeId>/`。SDK 默认工具全部关闭，只启用 `remote_command`、`remote_read`、`remote_write`；节点会话禁用本地扩展、技能与项目上下文。终端功能不依赖 Agent 模型配置。
- Agent 的命令进入用户当前选中的手动 SSH shell。服务端先锁定输入并发送 Ctrl+C，再等 shell 执行随机哨兵；确认成功才发命令，结束哨兵收集结果。无法确认或超时则报错，不继续发命令。终端输出同时广播到可见终端，工具结果进入 Agent 会话。用户可中断终端或停止 Agent。
- SFTP 浏览、读取与 UTF-8 写入按远端账号权限执行；单次读写限制 512 KiB。工具结果与终端捕获输出限制 64 KiB。

## 协议与验证

`node_request`/`node_event` 承载 `requestId`、`nodeId`、`terminalId`、`conversationId`；`server/protocol.ts` 为唯一 wire 类型源，前端在 `use-chat.ts` 转发节点事件给按需加载的工作台组件。`tests/node-workbench-test.mjs` 使用本地 mock SSH 服务覆盖主机信任、指纹变化、认证失败、终端命令、SFTP 及节点隔离。

## 来源同步

节点页分为来源设置、节点列表/详情、连接工作台三种视图。`server/node-sources.ts` 只读取 Xshell `.xsh` 和 OpenSSH config 元数据，不读取或解密保存的密码，不执行 config 中的命令。Windows 默认检测 Documents（含 OneDrive）下的 NetSarang Computer/8/Xshell/Sessions，各平台检测 `~/.ssh/config`；自定义路径指向运行服务的机器，可在来源页指定。

- `nodes.json` 同时保存 sources；持续同步每 5 秒扫描，单来源扫描串行，重启后恢复。支持立即同步、暂停/恢复与一次导入。最多 10 个来源，每来源 200 个节点。扫描失败保留上次完整节点数据并展示错误。
- 以 `sourceId + sourceKey`（Xshell 相对文件名或 SSH Host 别名）匹配节点。目录/文件重命名视为旧来源移除、新来源加入。源文件删除只标记不可连接，不删除历史记录；文件恢复后恢复节点。来源字段只读。
- 名称/分组/端口更新保留已补填凭据；主机地址、用户名、认证方式、私钥路径变化会清除凭据。地址/端口变化清除指纹，重新连接需核对身份。变更断开原连接并取消待确认操作。
- Xshell 支持 UTF-8、UTF-16 LE BOM、文本解码兜底；私钥必须是可直接读取的本机路径。跳板机、代理、未知认证方式、非 SSH 会话和无法确定的私钥路径标记为不可连接。
- SSH config 支持具体 Host、通配默认值、否定匹配及首值优先的 HostName/User/Port/IdentityFile。Include、Match、ProxyCommand、ProxyJump、转发等未支持的行为会标记并阻止连接，不能忽略后直连。没有 IdentityFile 时使用 SSH agent，服务进程需有 `SSH_AUTH_SOCK`。
- “在本机定位配置”打开服务所在机器的文件管理器；浏览器可复制来源路径，原配置由 Xshell/编辑器修改。不会通过文件关联自动启动远端连接。

## 凭据与执行确认

“测试并保存”先核对主机指纹并验证当前节点认证，成功后才保存凭据；可选择同组同认证方式的节点复用（其余节点在各自连接时验证）。不勾选持久化时只保存在服务内存中，按 client/node 隔离。原工具修改密码不会更新这里的凭据。来源同步不会接触 Xshell 的密码密文。

每节点执行策略为 `readonly`（默认）、`confirm`、`auto` 或 `off`。`readonly` 仅允许小范围明确只读的命令语法及 SFTP 读取自动执行，其他命令与 SFTP 写入均由服务端等待确认；未知命令不会因模型自称只读而自动放行。`confirm` 对读取也要求确认，`off` 禁用节点 Agent 工具。

确认与 client/node/terminal 绑定，显示原命令或完整写入内容；命令可编辑后执行。拒绝、停止 Agent、连接断开、终端关闭、节点配置或权限变化会取消确认，5 分钟未确认自动过期。确认后复查连接身份，防止把旧操作发往新连接。手动终端输入和手动 SFTP 操作仍由用户直接控制。

连接工作台保留多节点连接和每节点终端标签，左终端右 Agent。最近 12 KiB 终端输出作为不可信上下文提供给 Agent；选中输出可作为引用发送，草稿与引用按节点隔离。实时命令卡片显示执行结果；当前挂载终端用 xterm marker 标记 Agent 命令并支持定位。重新挂载后仍可查看本服务进程内保存的命令输出，但旧 marker 不恢复。终端滚动历史与每条命令输出均有限额。节点对话模型选择独立于主对话，复用 SDK 配置中的可用模型。

## 验证补充

`tests/unit/node-sources.test.ts` 覆盖来源解析、敏感字段剔除和只读命令判定；`tests/node-workbench-test.mjs` 覆盖同步合并、删除/失败保留、执行确认/拒绝/撤销及隔离。浏览器测试覆盖 UTF-16 Xshell 导入、凭据验证、自动更新、输出引用、节点切换和窄屏布局，不调用真实模型。Windows 下 Xshell 的自定义数据目录和非标准会话字段仍需实际安装环境验证。
