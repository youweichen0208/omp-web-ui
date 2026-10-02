# 项目共享的代码智能

0.10.0 引入 TypeScript / JavaScript、Python、Java、Go、Rust、C/C++ 语言服务。Web 与 Desktop 使用同一服务端实现；独立子代理通过 IPC 请求宿主，避免为每个会话启动一套语言服务。

## 模块与协议

- `server/code-intelligence.ts`：真实项目路径上的共享状态、语言服务进程、JSON-RPC、磁盘文档 LRU、查询、新鲜度、内存与恢复。
- `server/code-tools.ts`：六种语言共用一个只读 `code` 工具，action 为 `symbols` / `navigate` / `read_symbol` / `diagnostics`。行号与 UTF-16 列从 1 开始；可使用行号和符号名定位。重名返回候选列，避免猜测。
- `server/code-languages.ts`：文件扩展名、LSP 文档语言标识和服务器设置；`server/code-native-toolchains.ts`：原生服务发现、启动参数、按需安装与 Java 项目缓存租约。
- `server/code-feedback.ts`：可选编辑反馈，不使用 context 注入。按外层调用归集嵌套 edit/write，最终附加到外层 tool_result。保留原内容、图片、structuredContent、details、isError 和 usage。
- `server/project-watcher.ts`：文件面板和语言服务按项目共享监听。macOS / Windows 使用原生递归 watcher；Linux 排除依赖和构建目录后逐目录注册，上限 1,024 个，达到上限报告 partial。
- `server/code-toolchain.ts` 与 `scripts/build-code-toolchain.mjs`：离线工具链的打包、哈希校验、加锁与解压缓存。
- `server/protocol.ts`：`code_request` / `code_result` / `code_state`，协议版本 33，新增 install 操作与语言配置。请求包含 requestId 与 cwd；UI 校验归属，保存设置后会话 reload 沿用 agent_settled 延迟机制。

设置入口为「代码智能」；右侧文件栏可切换「问题」，支持筛选与通过现有文件预览保护跳转行号。面板报告已检查的打开文件数，不能当成全项目检查。

## 默认与信任

默认启用语言服务，自动诊断反馈关闭。项目切换稳定两秒后根据 package.json、tsconfig/jsconfig、pyproject、pyrightconfig 等标志预热，不扫描整棵项目目录。查询可直接启动需要的语言服务。

TypeScript 固定使用随包 5.9.3，禁用自动类型获取与项目插件。界面同时显示项目声明的 TS 版本；新版项目可能与随包编译器有差异。Python 在 SDK ProjectTrustStore 未信任项目时不启动；信任操作复用原生 MCP 设置中的 SDK 项目信任操作。受信任项目允许配置 Python 解释器。

文件读取仅允许真实路径在项目内、大小不超过 512 KiB 的文件。当前只分析磁盘内容，不使用编辑器尚未保存的草稿。文档上限 128 个 / 16 MiB，五分钟未使用关闭。结果限 100 项 / 32 KiB，明确报告截断。

## 服务与资源

全局最多四棵语言服务进程树，启动串行化。TS language-server 外层堆为 256 MiB，tsserver 默认 2,048 MiB；Python 默认 768 MiB。项目设置可将分析堆调至 512–8,192 MiB。

RSS 统计包含子进程。物理内存 20%（最多 2 GiB）的总预算只约束后台、无任务与查询的项目，持续超预算五秒后回收；前台项目只受各进程堆上限约束。后台服务闲置五分钟关闭。正向堆错误证据归类 OOM，显示上限并要求用户调整或重启；未知退出不猜测成 OOM。普通故障最多自动恢复两次，采样到的 tsserver 内部 PID 更换也计入预算。准备工具链最多两分钟，完成解压后才开始语言服务的 20 秒初始化计时。

## 诊断与对话缓存

诊断有 fresh / pending / stale / partial / unavailable，没有收到诊断不等于没有错误。携带文档版本的通知必须匹配；同时校验磁盘哈希与服务 generation。编辑和诊断推送使文件进入 pending；最后一份推送之后等待 400 ms 静默窗口，再检查文档版本、磁盘哈希和发布序号。TS 无版本的聚合推送同样等待静默窗口，稳定结果才标为 fresh 并可作为基线。fresh 是有界稳定性判断，SDK 并未提供所有诊断类别已完成的正式屏障；迟到推送会重新进入 pending。按文件查询只判断对应文件和语言服务，不受其他文件 pending 或其他语言未信任影响。

目前关闭 `useClientFileWatcher`，语言服务自行监听模块与依赖；客户端不发送不完整的 `didChangeWatchedFiles`。共享 watcher 的 1,024 目录上限不包含语言服务自身的监听。Linux 仅在结构变化时检查相关子树，删除重建目录后重新注册；文件栏保留当前浏览目录的直接监听，保证排除目录和共享监听上限之外的刷新。文档被 LRU 关闭后保留有界的最后诊断，并标为 stale。

维护每 15 秒运行一次并防重入；Windows CIM 超时为 10 秒，探测失败保留上次 RSS 并显示错误。项目版本和展示信任状态最多缓存 15 秒，Python 启动授权仍即时检查官方信任文件。状态仅在变化时推送，推送外层 cwd 使用客户端原路径，状态内部使用真实路径。连续稳定五分钟后清零恢复计数；Windows shutdown 等待有界 taskkill 回调完成。

不支持的文件类型不跟踪、不等待诊断。编辑钩子同步读取设置，不为关闭的反馈构建完整状态；超限工具结果通过减少结构化条目返回，不截断 JSON 字符串。

自动反馈开启时，顶层编辑或外层 codemode 的所有文件同时等待，使用一个 1,200 ms 截止时间，超时写 pending。内层工具结果不附加内容；脚本无需主动输出诊断。没有确认的新鲜基线时只报告修改区域附近的诊断，并提示可能原已存在。内容总限 4,000 字符，各文件最多十项。反馈进入持久化 transcript，不临时改变历史缓存前缀，不触发新模型轮次。等待耗时保留最近 100 次，供统计 P50 / P95。

## 数据与安装包

### Java / Go / Rust / C/C++

四种原生语言默认启用，只有已安装的服务才启动；项目预热检查 pom.xml、build.gradle(.kts)、go.mod/go.work、Cargo.toml、CMakeLists.txt、compile_commands.json 和 compile_flags.txt。安装必须由设置页的明确按钮触发，查询或打开项目不会自动安装语言服务器。

- Java：JDT LS 1.61.0；可指定服务器目录和语言服务器 Java 21+ JDK。另有 Java 8、17 项目 JDK 目录，分别映射到 `java.configuration.runtimes` 的 `JavaSE-1.8` / `JavaSE-17`；项目编译版本由 pom.xml 决定，不改变语言服务器启动 JDK。填写的项目 JDK 必须有 java 与 javac，启动前核对版本；仍需项目受信任。Java 8/17 JDK 当前使用用户已有安装，不自动下载，不修改 JAVA_HOME、Maven toolchains 或系统默认 JDK。按需安装可补齐 Temurin Java 21 到应用数据目录，不修改系统 JDK。Java 目前只支持 Maven，显式关闭 Gradle 导入。根目录或三层子目录内存在 pom.xml 即可；预热与查询使用同一浅层探测，跳过 node_modules、.git、target、build、dist 等目录，不遍历目录软链接，最多检查 256 个目录/10000 个条目，超限提示直接打开 Maven 子项目；已就绪 Java 服务通过信任检查后直接返回，不再重复扫描，服务重启时重新探测；纯 Gradle 项目状态为「暂不支持」，不会启动 Java 服务或提供推测的 classpath 诊断。不创建 GRADLE_USER_HOME、wrapper 白名单或管理 Gradle daemon。设置提供用户和全局 settings.xml 的绝对路径，分别传给 java.configuration.maven.userSettings / globalSettings。默认检查 ~/.m2/settings.xml 与 MAVEN_HOME/M2_HOME 下的 conf/settings.xml，访达启动时可手动填写；未发现全局配置时，首次加载项目通过安全的 mvn 查找解析软链接，检查相邻 conf/settings.xml 和 Homebrew 的 libexec/conf/settings.xml；不执行 mvn，项目内二进制仍排除，手动填写优先。设置中只持久化文件路径，不改写文件或展示凭据。字段对应 [JDT LS 官方设置](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.61.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/preferences/Preferences.java)；公司私有仓库和镜像的真实导入仍需实际项目验证。初始化最多 90 秒。每个真实项目拥有独立 JDT workspace；跨应用实例通过租约分开，空闲主缓存可在重启后复用。
- Go：gopls 0.21.1；需要本机 Go SDK。按需安装使用隔离 GOBIN/GOMODCACHE/GOCACHE；服务禁用隐式 Go 工具链下载，并使用只读模块模式。Go 模块与 SDK 兼容性仍由 gopls 判定。
- Rust：rust-analyzer 2026-09-28；需要本机 Rust/Cargo，标准库分析需要 rust-src。默认关闭 Cargo check、构建脚本与过程宏执行，并禁止 rustup 隐式安装缺少的项目工具链；因此构建脚本生成代码、过程宏及部分编译器诊断不完整。使用标准 `textDocument/diagnostic` 拉取原生诊断，校验文档版本与磁盘内容后保存；避免仅依赖推送而遗漏本轮 fixture 的原生类型诊断。查询结果明确标记部分覆盖；宏未展开等分析限制单独标记并降低为信息，不进入自动错误反馈。文件监听明确由 rust-analyzer 自身承担。
- C/C++：clangd 23.1.0 或已安装的 clangd；需要编译环境和准确的编译数据库。关闭项目 .clangd 配置、clang-tidy 与后台索引，默认两线程。不设置任意 query-driver 白名单；特殊编译器、生成头文件等可能需要先准备构建产物。非 macOS ARM64 的上游安装包未支持时，使用自定义本机 clangd 路径。

除 TS/JS 外，服务启动前都即时检查 SDK 项目信任。配置中的路径必须为绝对路径；默认 PATH 检测排除项目内部工具。查找 SDK 补齐官方 macOS `/usr/local/go/bin`、Homebrew、默认 Cargo bin 与显式 CARGO_HOME/GOROOT；无需执行登录 shell，因此不会增加项目切换启动脚本开销。原生服务及安装进程不继承 ELECTRON_RUN_AS_NODE，随包 TS/Python 仍保留。Java 有堆上限，Go 的 GOMEMLIMIT 是软内存目标；Rust/clangd 无硬内存限制，前台没有总 RSS 硬上限。界面常驻解释这些边界，单服务超过 1 GiB 显示高内存提醒；RSS 采样仍由既有维护周期更新。仍保留全局四棵服务树上限；查询中的语言不会被容量回收，空闲前台服务可让出槽位。

原生工具安装到 `<data-dir>/code-intelligence/native-tools/`；归档先校验 `server/native-toolchain-pins.ts` 中的固定 SHA256，上游哈希只作第二次核对；JDK 固定 Temurin `21.0.12.1+1`，不再查询 latest。固定哈希缓存使用独立目录，旧动态校验缓存不能被静默复用。通过 `npm run build:server` 后运行 `node scripts/review-native-toolchain-pins.mjs` 生成候选，更新需人工审阅并随应用发布；运行时不会自动改表。校验后再安全解压到 staging 并原子发布。Go 源码安装强制使用 sum.golang.org 校验，并禁止用户私有模块规则绕过此校验，保留 GOPROXY 选择。ZIP 拒绝符号链接、越界及超限条目；TAR 拒绝越界与外部链接。安装有跨进程锁，失败不留下 ready 状态；服务关闭取消下载并等待自有安装进程树终止。支持 HTTP(S) 代理环境变量，GitHub 资源直接使用固定表中的 Release 下载 URL，不依赖运行时 API 配额。下载失败提示 HTTPS_PROXY / GOPROXY 和本机服务器路径；403/429 提示 API 拒绝或频率限制。暂不提供镜像 URL 或本地归档导入；JDT 索引缓存仍由使用者管理，租约持有至服务模块关闭。

原生语言工具链不随 npm/安装包打入大体积二进制；安装时需联网，代码分析在部署机器上运行。Java/Go/Rust 项目的依赖解析可能使用本机包管理器访问依赖仓库。参考：[JDT LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls)、[gopls](https://go.dev/gopls/)、[rust-analyzer](https://rust-analyzer.github.io/book/installation.html)、[clangd](https://clangd.llvm.org/installation.html)。

`tests/native-code-intelligence-test.mjs --install` 在隔离目录中安装并验证真实原生服务；三平台独立 CI 检查符号、读取符号、类型错误与修复后的诊断。普通零 token 冒烟不强制下载原生工具链。

设置：`<data-dir>/code-intelligence/<项目真实路径 SHA256>.json`。
工具链：`<data-dir>/code-intelligence/toolchains/<归档 SHA256>/`。准备有进程锁、锁内 ready 二次检查和 staging rename；活进程 lease 保护缓存，启动与准备新版本时清理无活 lease 的旧版本。初始化计时不包含解压。构建使用 fileURLToPath，按稳定顺序收录文件并规范权限；空格路径和重复构建哈希有回归测试。

工具链仅为构建依赖，npm 与 Desktop 随包携带一个通用压缩包，首次使用离线解压。只裁剪 TS 多语言诊断与 .map 文件，保留 typeshed 和许可证，不包含 fsevents。预算为压缩 ≤12 MiB / 解压 ≤45 MiB；当前实测 6,865,974 / 36,765,894 字节、5,542 个内部文件。Windows portable.unpackDirName 保持原设置。

## 验证

`tests/code-intelligence-test.mjs` 运行真实服务，覆盖 TS/Python 查询、诊断、磁盘更新、版本冲突、项目路径边界、共享 watcher，以及未信任项目的本地 TS / 插件 / 假 Python 执行标记。

`tests/native-tools-desktop-test.mjs` 使用本地零费用模型验证 codemode 嵌套 write 的诊断保存在外层 transcript，且图片仍在；同时保留 MCP deferred resume/reload 回归。`tests/unit/code-feedback.test.ts` 验证结果字段保留、并行单截止时间与关闭开关。`tests/code-intelligence-browser-test.mjs` 验证中英文、900/1280 像素设置布局与默认关闭反馈。打包产物启动回归直接用包内 Electron 运行真实工具链检查；CI 增加 macOS / Windows / Linux 语言服务矩阵。

仍需专项性能验收：大型真实 TS 仓库的索引峰值 RSS/OOM；索引 CPU 饱和时切换 P95 与 0.9.0 基线；Windows 绿色版五次冷启动和 Defender 首次解压；Linux 实际 inotify 使用与目录上限退化；真实 Anthropic/OpenAI 缓存命中率与费用。零费用 fixtures 不能证明真实服务商缓存命中率。自动反馈保持默认关闭。

本轮本机验证与安装包校验见 [验证记录](code-intelligence-validation.md)。

Maven 多模块回归使用 `tests/maven-code-intelligence-test.mjs`，验证 reactor 中依赖解析、跨模块源码定义跳转和错误修复。macOS 用精简 PATH 下的包内 Electron 验证 Go/Rust，不能用 shell 继承 PATH 代替该场景。
