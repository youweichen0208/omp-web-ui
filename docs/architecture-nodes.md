# 内置 SSH 节点工作台

顶栏「节点」打开节点来源与分组详情，连接后提供 Agent 工作台和 SSH PTY/SFTP 手动工作台。Windows/macOS 客户端都由本机 Node 服务通过 `ssh2` 连接 Linux/macOS SSH 服务；远端账号或容器决定实际权限。

## 数据与认证

- `<dataDir>/nodes.json` 存节点 ID、分组、地址、端口、用户名、认证方式、私钥路径、默认目录与已信任的 SHA-256 主机密钥指纹。密码和私钥口令使用 `PluginSecrets` 写入 `<dataDir>/node-workbench/secrets.bin`，共享 `<dataDir>/secrets.key` 加密密钥。
- 「导入 Remote-SSH 配置」仅读取旧插件的 `ssh-hosts.json` 元数据，不删除原配置，也不读取或导入旧插件的加密凭据。需要重新填写密码或私钥口令。导入/导出 JSON 只传非机密字段。
- 首次连接先给浏览器展示主机密钥指纹；信任后才允许认证。已保存的指纹变化时服务端阻止连接。指纹在每台客户端各自保存，不跨设备同步。

## 连接、终端与 Agent

- `NodeWorkbench` 按 `clientId:nodeId` 保存连接，终端按 `terminalId` 定位，所有可变请求要求与节点和会话身份匹配。断线时保留浏览器的已断开标签。浏览器 WebSocket 重连恢复同一连接上的 Agent 状态；SSH 断开会终止该连接的 Agent 和终端；重新连接自动准备新的隔离 Agent 实例。
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

## 凭据

“测试并保存”先核对主机指纹并验证当前节点认证，成功后才保存凭据；可选择同组同认证方式的节点复用（其余节点在各自连接时验证）。不勾选持久化时只保存在服务内存中，按 client/node 隔离。原工具修改密码不会更新这里的凭据。来源同步不会接触 Xshell 的密码密文。

## 验证补充

`tests/unit/node-sources.test.ts` 覆盖来源解析和敏感字段剔除；`tests/node-workbench-test.mjs` 覆盖同步合并、删除/失败保留、手动终端、SFTP 和隔离。浏览器测试覆盖 UTF-16 Xshell 导入、凭据验证、自动更新、节点切换和窄屏布局，不调用真实模型。Windows 下 Xshell 的自定义数据目录和非标准会话字段仍需实际安装环境验证。

Xshell 公钥登录节点可在凭据弹窗指定本机 OpenSSH 私钥路径（不是 `.pub` 公钥或 Xshell 密钥名称）；私钥口令允许留空。测试通过后保存 `localKeyPath` 本机绑定，来源配置仍只读，正常同步不会覆盖绑定；来源主机、用户或认证资料改变则清除绑定。绑定只解除私钥路径缺失限制，不会绕过代理等不支持项。错误路径或验证失败不覆盖已保存绑定。

来源节点的「认证设置」可在密码与公钥认证间切换。测试使用候选配置，成功后保存 `localAuth`，来源 `auth` 保留原值用于同步比较；失败不覆盖已保存选择。连接和界面使用本机选择，普通同步和重启保留；来源主机、用户或认证资料变化时与本机私钥绑定一起清除。切换方式会清理旧凭据和其他客户端连接，避免把服务器密码当成私钥口令。

## 节点 Agent Chat（#54）

连接成功后左侧显示 SSH 终端与文件，右侧直接显示 Agent Chat；窄屏上下排列。`node-agent.ts` 使用本机原版 pi 1.0.4 SDK、本机模型和凭据创建隔离会话。连接只准备会话，用户发送消息才调用模型；节点不需要 Node、pi 或模型配置。手动关闭 Agent 后不会立即重开，右侧保留重开和目录选择入口。初始化失败只影响聊天，SSH 终端仍可用。

每个 client/node 的会话位于 `<dataDir>/node-sessions/<clientId 的 SHA-256>/<nodeId>/`。同一服务重连后恢复最近历史，新的实例 ID 拒绝旧请求；新对话新建历史文件。模型切换只影响该节点会话，不写本机默认模型。浏览器只接收模型名称等白名单字段，本机凭据不进入 SSH 命令或节点文件。

这是主聊天原生上下文规则的明确例外：节点会话使用限定节点职责的提示词，只启用 `remote_command`、`remote_read`、`remote_write`。不加载本机项目上下文、用户扩展、技能、模板或 MCP，也不暴露本机 bash/read/write，防止误操作本机。主聊天保持原有工具、提示词与配置。

`node-command.ts` 每次在当前 SSH 连接上创建独立 exec，POSIX 引号保护默认绝对目录，目录切换失败立即退出；命令之间不保存 cd。命令与左侧手动 PTY 独立，不抢占用户正在运行的终端任务。输出上限 64 KiB，默认 120 秒，Agent 可显式指定 1–600 秒；取消、超时和断开只向该命令通道发送 TERM 并关闭。远端子进程是否响应信号取决于 SSH 服务及进程行为。读写走现有 SFTP，UTF-8 文件限制 512 KiB；所有工具捕获原连接，不能在异步期间改投到新节点。中断写入可能留下部分内容。

运行结束以 `agent_settled` 为准，`agent_end` 不清除工作状态。SDK 提供流式回复、原生工具记录、排队/纠正、停止和模型切换，界面发送确认后才清空输入。节点任务计入应用更新的忙碌检查；quiesce 拒绝连接、凭据验证及新 Agent 工作，允许停止和断开。普通 WebSocket 重连恢复同一 Agent 状态；SSH 断开取消该会话任务。历史由本机 SDK 保存，界面保留最多 200 条或约 4 MiB 的最近消息。

原生远端 RPC 方案已由上述本机 Agent + SSH 工具方案替换。现有远端 pi 历史保持原处，本次不会下载或迁移；此前本机 `node-sessions` 下的历史可继续使用。

回归：`tests/node-agent-test.mjs` 使用本机原版 SDK、本地模型 HTTP 夹具及无 pi/模型配置的 SSH 服务夹具，验证连接即就绪、工具和凭据隔离、SSH exec/SFTP、排队、取消、超时和重连历史；`--browser` 验证连接即聊天、左右分栏及窄屏。命令引用与错误目录由 `tests/unit/node-command.test.ts` 验证；真实生产 Linux 节点仍需实际环境验收。
