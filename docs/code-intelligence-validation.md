# 0.10.0 代码智能验证记录

日期：2026-10-02。本机 macOS arm64，Pi SDK 1.0.0，Electron 41.10.7。此记录对应本轮可运行实现，不代表所有性能与跨平台验收已经结束。

## 已通过

- 协议单源检查，双端版本 33；完整类型检查与 Web / Server 构建。
- 71 个单测文件、426 个用例通过；47 / 47 零 token 冒烟通过。
- 真实离线 TS / Python：符号、诊断、磁盘更新、版本冲突、项目路径边界、UTF-16 定位、同一行多个符号选择、共享 watcher。
- TS 无版本聚合通知的 JSON-RPC 夹具先推送旧语义错误，200ms 后推送修复结果；首次 fresh 已无旧错误，基线为空。真实 TS 修复同样验证首次 fresh，且未信任 Python 不影响按 TS 文件查询。
- 真实语言服务能发现模块新建、模块删除及 node_modules 内本地声明包安装；客户端独占文件监听已关闭，依赖语言服务自身监听。
- 工具链在含空格的路径构建成功，重复构建 SHA256 相同；两个独立进程并发准备同一缓存成功。真实路径别名归一化通过。
- Windows taskkill 等待有模拟回调测试；Linux 监听算法在本机验证目录删除重建后继续通知。文件栏浏览 dist 仍能实时刷新。以上不代替 Windows / Linux 真机验收。
- 未信任项目的本地 TypeScript / 插件 / 假 Python 解释器执行标记未出现；随包编译器正常工作。
- Python 外部磁盘编辑能经共享 watcher 更新诊断，未使用随包 fsevents。
- 本地模型 fixtures：嵌套 write 不主动输出返回值，诊断仍保存在外层 codemode transcript；图片与原结果字段保留。单截止时间并行等待、关闭反馈、输出 32 KiB 上限有单测。
- 子代理 `code` 工具通过 IPC 查询宿主共享语言服务，结果由实际 SDK 子进程回传。
- 中英文设置、默认关闭反馈、堆设置保存、筛选；1280 与 900 像素浏览器窗口无运行错误或设置面板横向溢出。
- Mac 包内 Electron：服务启动、SQLite / 终端、离线 TS / Python、codemode、MCP deferred reload/resume、OAuth lazy 模块、SDK 子代理生命周期/写锁/结果回传/项目归属/重连与共享 code IPC。
- 包内全部服务端 JS 与当前 dist 文件逐个 SHA256 一致。
- npm dry-run 包含工具链的 manifest 和归档；归档 6,865,974 字节，解压 36,765,894 字节 / 5,542 个文件，满足 12 / 45 MiB 预算。
- 单个 code 工具定义为 1,202 字符；按字符数 / 3 保守估计约 401 tokens。这只是定义长度估计，不是真实模型 tokenizer 或缓存命中率。

## 第一批原生语言

- JDT LS 1.61.0、Temurin JDK 21.0.12.1+1、gopls 0.21.1、rust-analyzer 2026-09-28、clangd 23.1.0 均在隔离数据目录安装。未修改系统 JDK、Go 或用户启动配置。
- Java、Go、Rust、C/C++ 的真实服务：符号、读取符号、定义跳转、类型错误及修复后的诊断已通过。Rust 验证真实 Cargo 工程和标准库；类型诊断使用标准拉取接口，取消索引请求会保持 pending，修复首次 fresh 已无旧错误，且项目 build.rs 标记未出现。Java 使用无外部依赖的 Maven fixture；不代表公司私有依赖或大型 Maven 工程的完整导入验证。
- 新增语言的未信任项目使用会写执行标记的假服务器验证，标记文件未出现。ZIP 符号链接拒绝、越界路径、安装进程关闭和文件类型识别有单测。
- 最终 Mac 安装包内使用 Electron 运行四种真实原生服务，诊断、修复、符号读取与定义跳转通过；旧终端、MCP/codemode 和子代理回归通过。
- 中英文 900/1280 像素设置页通过，新增四种语言开关、服务器路径、安装入口、Java home 与内存目标。
- 已添加三平台真实原生语言 CI；开发期间未推送触发 runner；beta 发布时由标签流程执行。Rust SDK 在独立临时目录安装，未修改用户 Rust 配置。

## 本轮审查修正

- 16 个平台资源的 SHA256 固定在源码，JDK 固定到具体版本；上游 digest 仅作二次校验。Mac Rust、clangd、JDT LS 和 JDK 已重新下载并匹配固定表。上游 hash 改变及下载内容不匹配均有拒绝测试；其他平台资源本轮未下载实测，初始哈希取自官方元数据，不代表独立签名验证。
- 最终包使用 `env -i` 和 `/usr/bin:/bin:/usr/sbin:/sbin` 的精简 PATH 运行四种真实语言服务，通过诊断、修复、符号读取和跳转。Go 经 Homebrew 兜底发现；Rust 使用临时 SDK 的 CARGO_HOME/RUSTUP_HOME。官方 `/usr/local/go/bin` 候选路径另有单测，未实际安装 Go 的官方 pkg；这轮未从访达手动打开完整应用。
- Rust 部分覆盖文案和宏分析限制分类已补齐，限制类信息不作为真实错误反馈给模型。中英文问题面板、高内存提示及 900/1280 像素布局通过浏览器测试。
- Go 安装强制启用官方 checksum database；下载错误提供代理/GOPROXY 或本地服务器路径办法，GitHub 限流提示有测试。
- JDT 索引缓存自动回收、镜像配置和本地归档导入尚未实现；大型原生 workspace 的内存峰值仍待测量。固定 URL 直接下载以减少 GitHub API 依赖、登录 shell PATH 对 asdf/mise/SDKMAN/goenv 的发现也列为后续改进，当前仍可配置绝对路径。

## Java 8 / 17 补充验证

- 新增独立 Java 8 / 17 项目 JDK 路径设置，语言服务器仍由固定 JDK 21 启动；空路径保留原有 JDT 默认行为。绝对路径校验和 runtime 映射有单测，真实启动检查完整 JDK 与实际版本。
- 隔离目录中的 Temurin 8u504-b01（mac x64，经本机兼容运行）及 17.0.20.1+1（mac arm64）用于真实 Maven fixture。两个版本的符号查询、读取、定义跳转、类型错误与修复均通过；Java 8 拒绝 Java 9 List.of API，Java 17 record 正常分析。
- 最终 Mac 包内重复执行上述两组测试，使用精简 PATH，均通过。中英文 900/1280 像素设置页通过。CI 新增各平台对应项目 JDK 测试，但尚未推送运行。
- 本项验证语言服务器的 Maven 导入与分析，不代表执行了完整 mvn package、多模块项目或 Maven toolchains 回归。自动安装仍只提供 JDK 21；Java 8/17 的生产设置指向已有本机完整 JDK。

## Maven 专用范围调整

- 移除 Gradle importer、项目独立 Gradle 缓存、wrapper 白名单、daemon 识别/统计/清理及对应测试。Java 仅支持包含 pom.xml 的 Maven 项目，Java 8/17/21 支持保留。
- build.gradle / build.gradle.kts 的纯 Gradle 项目在服务启动前阻断，状态显示「Gradle 项目暂不支持」，不输出 Java 诊断；加入 pom.xml 后可进入 Maven 启动路径。两种标志文件都有测试。
- Maven 多模块 reactor fixture 通过模块依赖解析、跨模块源码定义跳转和错误修复；Java 8/17/21 单模块回归均通过。最终 Mac 包在精简 PATH 下分别使用 Java 8/17/21 项目 JDK，三组 reactor 多模块测试均通过。
- 历史 Gradle 验证属于之前实现，不代表当前交付支持 Gradle。既有用户缓存不自动删除。
- 公司项目的 settings.xml 私有账号/镜像、首次下载期间 pending 语义、首次导入耗时和大型项目内存峰值尚未实际验证；需用户提供对应本机项目。

## 嵌套 Maven 与 settings.xml 修正

- Maven 探测覆盖根目录及三层子目录，跳过依赖/生成目录与目录软链接，限制 256 个目录、10000 个条目；预热与查询共用规则。三层、忽略目录、深度边界和嵌套预热有单测。
- 新增用户/全局 settings.xml 手动路径；默认只探测 ~/.m2/settings.xml、MAVEN_HOME/M2_HOME 的 conf/settings.xml。绝对路径校验、路径持久化和 JDT 参数映射通过单测，不读取或下发配置内容。
- 实际 JDT LS 在 backend/pom.xml 下完成多模块依赖解析、源码定义跳转和诊断修复，fixture 同时配置独立的用户/全局 settings.xml。最终 Mac 包在精简 PATH 下分别验证 Java 8/17/21 的上述嵌套 reactor，均通过。这些文件没有私服账号，不能替代公司认证和镜像实测。
- 中英文 900/1280 像素设置页含两项 settings.xml 输入框，通过浏览器验证。清理了本轮临时数据目录下 5 份旧 Gradle 缓存及测试归档，未操作用户真实 ~/.gradle 或应用数据目录。
- 公司私服账号/镜像、首次下载期间 pending、真实首次导入耗时及大型项目内存峰值仍未实测。

## Java 查询快速返回与 Maven 路径兜底

- 已就绪 Java 服务不再重复 Maven 探测，五次重复访问未调用 discovery 有单测；信任撤销仍在快速返回之前检查。
- 项目首次加载时，全局 settings.xml 空缺可由本机 mvn 文件路径兜底；解析软链接，覆盖标准 conf 和 Homebrew libexec/conf 两种布局，不运行 mvn。布局及实际软链接的执行标记测试通过。

## Web / Desktop 语言服务状态提示

- 状态栏 LSP 入口、设置页/问题面板共用的六种语言状态卡片，显示连接、初始化、缺失工具链、信任、失败原因、尚未启动和关闭状态；状态栏可直达代码智能设置。
- 断线覆盖、未查询语言不推测为未安装、已关闭服务不计入已连接、部分服务失败不被其他 ready 掩盖有单测。
- 中英文 900/1280 像素浏览器验证状态转换、失败原因展开、Escape、其他项目迟到回执隔离和直接设置入口；布局始终在视口边界内。另用模拟 Electron API 的 macOS/Windows 桌面样式验证中英文 900px 布局；这不替代对应平台真实 Electron 窗口测试。

## 本地安装包

- `release/pi-0.10.0-mac-arm64.dmg`，约 238 MiB。
  SHA256：`93bbbb7178c2cb7219b854dd7e9f792154c25721e0add96c848e7d0764c79d16`
- `release/pi-0.10.0-mac-arm64.zip`，约 245 MiB。
  SHA256：`ab98f7456bfc31b9a0d7cd93a5de6ee1786be15150531c828e4fc20b00a26f2f`

包采用现有 ad-hoc 签名方式。以上是 0.10.0 开发期间的本机产物记录。1.0.0-beta.2 由 GitHub 标签工作流发布预发布，跨平台实际结果见对应 Actions；本轮不发布 npm。

## 尚未完成的专项验收

- 真实大型 TS 仓库的索引峰值、OOM 与可调堆上限验证。
- 对照 0.9.0 的普通切换 P95，以及索引 CPU 饱和时的切换 P95。
- 真实 edit 诊断等待延迟 P50 / P95；目前验证的是 fixture 与单截止时间机制。
- Windows 绿色版五次冷启动、首次解压 / Defender 扫描，以及 Linux 实际 inotify 占用和目录上限退化。
- Windows / Linux 真机产物；已添加三平台语言服务 CI 与包内回归，但开发期间未推送触发 runner；beta 发布时由标签流程执行，不能标记为通过。
- 真实 Anthropic / OpenAI 缓存命中率与费用；未授权付费模型测试，不能用零费用 fixture 替代。

自动诊断反馈保持默认关闭。架构与边界见 [代码智能](architecture-code-intelligence.md)。

## 1.0.0-beta.1 发布前本机复验（2026-10-02）

协议 v33、类型检查、71 个单测文件 / 426 用例、47 项零 token 冒烟与中英文 Web / 模拟 macOS、Windows 窄窗口状态提示均通过。actionlint 1.7.12 检查发布与复用 CI 工作流通过。

Mac arm64 beta 包内 Electron 实测 TS/Python、Java/Go/Rust/C++、嵌套 Maven 多模块、SQLite、MCP/codemode、OAuth、生图和内置子代理通过；ad-hoc 签名校验通过。修复 Rust 监听刷新与诊断基线的竞态，并覆盖首次索引暂时返回空结果后继续拉取诊断的回归。

本机产物（GitHub runner 会独立重建，附件哈希以实际发布为准）：

- `pi-1.0.0-beta.1-mac-arm64.dmg` SHA256：`e00e77e82f7d612ee807f76592b88fcff22500ed4254978e1b7261716157edf0`
- `pi-1.0.0-beta.1-mac-arm64.zip` SHA256：`c5adf524b88566da81868d4ad24afb4a0a093c8106a7601c8d91903f557564d1`

本次只发布 GitHub 预发布；Windows / Linux 是否通过，以标签 Actions 最终状态为准，不以本机模拟代替。

`v1.0.0-beta.1` 在旧 OMP 迁移中使用过，本轮发布采用 `v1.0.0-beta.2`，保留旧标签身份；以上 beta.1 为改名之前的本机验证包。
