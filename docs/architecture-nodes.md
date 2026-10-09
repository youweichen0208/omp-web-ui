# 内置 SSH 节点工作台

顶栏「节点」打开节点来源与分组详情，连接后提供 Agent 工作台和 SSH PTY/SFTP 手动工作台。Windows/macOS 客户端都由本机 Node 服务通过 `ssh2` 连接 Linux/macOS SSH 服务；远端账号或容器决定实际权限。

## 数据与认证

- `<dataDir>/nodes.json` 存节点 ID、分组、地址、端口、用户名、认证方式、私钥路径、默认目录与已信任的 SHA-256 主机密钥指纹。密码和私钥口令使用 `PluginSecrets` 写入 `<dataDir>/node-workbench/secrets.bin`，共享 `<dataDir>/secrets.key` 加密密钥。
- 「导入 Remote-SSH 配置」仅读取旧插件的 `ssh-hosts.json` 元数据，不删除原配置，也不读取或导入旧插件的加密凭据。需要重新填写密码或私钥口令。导入/导出 JSON 只传非机密字段。
- 首次连接先给浏览器展示主机密钥指纹；信任后才允许认证。已保存的指纹变化时服务端阻止连接。指纹在每台客户端各自保存，不跨设备同步。

## 连接、终端与 Agent

- `NodeWorkbench` 按 `clientId:nodeId` 保存连接，终端按 `terminalId` 定位，所有可变请求要求与节点和会话身份匹配。断线时保留浏览器的已断开标签。浏览器 WebSocket 重连恢复同一连接上的 Agent 状态；SSH 断开会终止该连接的 Agent 和终端，再连接后需显式重新启动。
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

## 远端 Agent 工作台

连接后默认打开 Agent 页签，点击「启动远端 Agent」才在已信任的 SSH 连接上创建独立 exec 通道。`node-agent.ts` 通过远端 `sh -lc` 切换到用户选择的绝对路径，再执行 `pi --mode rpc`；路径经过 POSIX 单引号转义，禁止换行和 NUL。远端需要 Node ≥22.19.0、pi 1.0.4 及自己的模型配置。未安装时界面给出安装说明，由用户在手动终端执行；连接节点不会自动安装或调用模型。

每个 client/node 只有一个 Agent 进程，全部写操作校验其随机实例 ID；不同节点、客户端及本地主聊天彼此隔离。模型与凭据由远端 SDK 读取，本机不转发本地凭据、注册 SSH 代理工具或注入手动终端输出。浏览器只接收模型名称等白名单状态。原生 RPC 提供流式回复、工具记录、排队/纠正、停止、模型切换、新对话及 select/confirm/input/editor 扩展对话框。工具读写和 bash 在远端账号权限及所选目录执行。

运行结束使用 `agent_settled`；prompt 成功仅表示接受，`agent_end` 不清除工作状态。活动远端请求计入控制 socket 的 activeConversations 和应用更新空闲检查；quiesce 拒绝新 Agent、消息、新对话与模型切换，仍允许停止及回答已有弹窗。停止发送原生 abort，关闭 Agent 或 SSH 连接时只向该 exec 通道发送 TERM 并关闭。聊天由远端 pi 保存；界面保留连续的最近记录，最多 200 条或累计约 4 MiB（单条超预算时保留最新一条），工具结果沿用序列化长度限制。单条 RPC JSON 最大 16 MiB，超过限制断开并显示诊断；stderr 末尾最多 8,000 字符。RPC 请求有超时，失败不自动重发，输入在确认接受后才清空。

普通 WebSocket 断线不结束 SSH 会话，重新附着恢复当前 Agent 消息与待答弹窗。切换到「终端与文件」保留 Agent 实例及消息。SSH 断线或来源配置变更会关闭旧实例；旧实例 ID 的后续消息被拒绝。关闭工作台不会把远端对话转入本地主聊天。

`tests/node-agent-test.mjs` 使用真实 SSH 通道连接原版 pi 1.0.4 RPC 进程，由本地 HTTP 模型夹具响应，验证流式消息、远端凭据不下发、扩展确认、新会话、身份隔离和断开清理；`--browser` 增加真实界面操作与窄屏截图。
