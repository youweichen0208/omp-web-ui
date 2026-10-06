# Pi 1.0.4 原生能力与资源审查

本报告对应 pi-web-ui **0.99.8**、协议 **v39**、原版 Pi **1.0.4**。原计划保留应用 0.99.7；用户随后要求发布 GitHub Release，因此应用及 lockfile 同步递增到 0.99.8。没有发布 npm、更新全局 CLI 或重启既有服务。

## 结论

日常原生聊天、模板与附件、队列、会话树、MCP/Codemode、图片和扩展弹窗的集成具备实际回归证据，1.0.4 升级兼容性通过。不能把这解释为任意 TUI 插件完全兼容，或异常恢复全部可靠：同项目多会话强停恢复、reload 归属和并发入口已有确定性复现，应优先另开修复。

轻量性结论：少量项目、短历史、复用客户端时开销可控，但不能称为接近裸 SDK 的超轻界面；20,000 条历史的渲染 GC heap 达约 166–249 MiB、进程树 RSS 峰值达 2.3–3.2 GiB，已不适合当作轻量负载。桌面安装后逻辑体积约452 MiB。

轻量性必须区分小工作集与持续增长。原生 SDK 的空会话成本较小；Web 增加服务、序列化和浏览器界面，Electron 还包含 Chromium 进程。长历史的摘要 DOM、超过 4096 条后的消息缓存行为，以及不回收的客户端/跨项目 runtime，是主要优化目标。30 分钟固定工作集能检验该工作集的稳定性，不能证明无限新增客户端、项目或附件也有界。

完整能力矩阵及每条官方契约、服务端/协议/前端/测试路径见 [原生能力附录](pi-native-capability-review.md)；资源结构、已有上限及尚未动态验证的风险见 [资源静态附录](pi-resource-static-review.md)。两份附录属于本报告，分别说明 SDK 自动继承和宿主适配、动态证据与静态判断。

## 升级实现与验证

- `pi-coding-agent`、`pi-ai` 精确锁定 1.0.4；lockfile 的 chord、pi-agent-core、pi-codemode、pi-mcp、pi-telemetry、pi-tui 同步解析为 1.0.4，无另一份旧 Pi 包。没有修改 SDK。另修正原有 esbuild 0.28.2→0.28.1、send 0.20.0→0.19.2 的声明/下载不一致：重新解析为声明版本的官方 tarball，并让 check:lockfile 校验文件名与版本一致；完整生产依赖树 npm ls 验证通过。官方 v1.0.3→v1.0.4 比较未修改 prompt-templates 源文件，比较清单保存在 [upstream-comparison.json](review-data/upstream-comparison.json)。
- `system-prompt-view.ts` 按 selectedTools 排除 hiddenTools 后计算规则来源；全文仍调用原生 builder，并与 session.systemPrompt 严格比较。隐藏 read/bash 仍可间接读取的技能由 SDK 保留。强制提示词、不匹配只读降级保持原样。
- `native-prompt-template.ts` 版本保护更新到 1.0.4；真实模板参数、空白分隔、附件、扩展优先级和队列回归通过。失败拒绝发送并保留草稿。
- Node 与 Electron 原生工具定位、MCP stdio/HTTP、嵌套调用和生成图片费用经过本地夹具验证。新增 1.0.4 特定 MCP 连接中关闭、Codemode 修改内建对象后结算、read 图片和历史读回回归。
- 当前架构、开发及 AGENTS.md 版本说明同步；历史发布记录保持原样。旧浏览器测试的 `.status-messages` 已随当前界面改为 `.status-ctx`，继续验证新会话等待快照时不显示旧上下文。

本机最终验收：协议检查、双端及测试类型检查、生产构建通过；75 个单测文件、423 个测试通过；46/46 零 token 冒烟通过。浏览器专项涵盖提示词编辑、冻结附件、会话树、扩展弹窗、MCP/Codemode 与原生操作；Electron 覆盖状态恢复、外链、包内服务/SQLite worker、原生工具、模板及 OAuth 夹具；macOS 签名完整性校验通过。

原始验证日志在 [validation](review-data/validation)。已知缺陷复现 [native-reproductions.json](review-data/native-reproductions.json) 的 PASS 表示成功证明缺陷存在，不是通过正常行为验收；它故意不进入 smoke。

## 测量方法与适用范围

环境与构建标识见 [build.json](review-data/build.json) 及各模式 environment.json。安装先检查官方 HTTPS registry，再执行干净的 `npm ci`，使用 `npm run build` 的生产前端/服务端。首次采样发现原锁文件下载版本不一致后已作废，最终结果来自修正后的重新安装、构建和采样。macOS 构建使用本机 npm 安装的同版本 Electron 41.10.7 目录，绕过构建器重复下载，不替换 Electron 版本。资源场景按 SDK、Electron、Web 串行运行；本机其他用户应用保持运行，没有锁定 CPU 频率或独占整机，数值不作为跨硬件保证；每类短场景三个独立进程轮次；测试工作区和原生会话目录在轮次之间保留，后续轮次会看到先前本地夹具写入的历史，故这些轮次不是完全冷盘克隆。Web 使用隔离 Chromium，Electron 使用当前版本实际 macOS 打包应用；不把开发态 DevTools 算入结果。

所有 agent、data、cwd、浏览器 profile 隔离到临时目录，端口由内核分配并校验 ≥8900；没有真实模型计费或账号授权。并行会话用本地保持流式响应的模型夹具；流式负载为 100×1 KiB/20ms；大工具结果为约 8.4 MB 的持久化结果。主负载显式使用 defaultTools:[]，隔离工具执行；另有默认工具开启的三轮空闲基线，不能把主负载 idle 值当产品默认配置。终端为已创建的空闲 PTY，不是持续刷屏。长历史为 500/5,000/20,000 条交替 user/assistant 消息，每条约 512 字节重复文本。压缩率偏高，不代表随机代码/图片历史。Wiki 为 100 个约10KB文档、PDF 为一页、SQLite 为10,000行分页查询、附件草稿为1MiB。Wiki/PDF/SQLite 通过真实 HTTP API 测索引/读取/搜索/查询，未打开完整 Wiki/PDF 阅读 UI；附件通过浏览器文件输入添加。因此附加阶段不能用来估算复杂 PDF 阅读器的完整渲染成本。

独立 SDK 的 1/3/8 是空闲会话数，Web/Electron 的对应阶段是本地模型保持响应的活跃会话数；两者不是相同工作量的横向跑分。MCP/Codemode 另做三个独立会话进程的启用/调用/释放测量。

另有 `--history-only` 补充基准：每轮用两条种子消息保证自动恢复起点较小，按 500→5,000→20,000 顺序加载，等待页面实际消息行数吻合、首尾消息身份稳定2秒后才进入阶段末 GC；它不经过30客户端/30项目等主负载。这组数据用于更清楚地比较目标历史的页面留存；主负载表仍完整保留切换期间的峰值和跨阶段留存。

每轮阶段是累计工作集：30 个客户端是新增测试 ID 的数量，另有 UI/控制客户端；项目、长历史和后续功能加载会保留之前允许常驻的状态。因此不能把「sessions-8 阶段总内存」误读为干净的八会话成本。比较边际变化与独立 SDK 基线时必须保留这一差异。

打包 Electron 会移除 NODE_OPTIONS，因此其后端通过本地临时 inspector（检查 9229 空闲、校验 PID 后注入、立即关闭）加载同一探针，并断言已经产出数据；开发态测量不能替代这一步。普通采样与主动 GC 串行，避免并发调试请求在 GC 时失效。未加载后端探针的桌面试跑已作废。测试专用 preload 每秒记录服务进程 RSS、heapUsed、external、CPU 累积值、Node 活动句柄及活动资源种类；不写入应用实现。本地模型夹具与测量驱动不计入应用进程树。OS `ps` 只记录所启动进程树。退出后另用 verify-resource-cleanup 对全部已采样 PID 核对，按进程启动时间排除后来复用的 PID；该核对不能检测从未采到的短命进程。浏览器通过 CDP 记录 JS heap、DOM、监听器、请求字节。CDP nodes 包括文本节点及可能尚可达的脱离文档节点，不能等同可见元素个数。自然峰值是采样观测到的峰值，短于1秒的临时子进程/分配可能漏采，不是严格上界；与阶段结束明确请求的 GC 后留存分开；RSS 不等同活对象大小，也不保证 GC 后立即归还 OS。全进程树 RSS 是进程 RSS 求和，共享页可能重复，不能当作独占物理内存；Web 启动独立 Chromium，包含整套浏览器进程，不等于已打开浏览器中新标签页的边际成本。`ps` 的进程树值在 GC 请求前采样，仅作自然总占用；post-GC 后端值来自 preload，前端值来自 CDP。

CDP 在渲染主线程繁忙时会延迟返回，不能保证前端每秒都有可用样本；原始时间戳保留这种间隔。Node 活动句柄数不等于 OS 文件描述符总数。HTTP encodedDataLength 是已完成请求的传输长度；WebSocket payload 统计为**解压后的字节**，不是网络压缩后长度。补充长历史测试还记录控制 WS 连接的 net.Socket bytesRead/bytesWritten 差值，包含压缩后的 WS 帧及控制帧，不包含 IP/TCP 包头；这是该夹具连接的真实 TCP 流字节，不是整个应用链路总量。控制夹具显式 get_state 会强制全量快照，故这些字节不能直接推断真实流式增量流量。

资源脚本的 ui-ready 包含进程启动、探针准备及仪器化页面加载；Electron 为捕获完整首屏传输会再次导航，故不能把这个值当原生冷启动。独立点击脚本的 launch-to-ready 另记录首次页面可操作时间（含首次配置夹具弹窗关闭），不重载页面。历史加载时间包含控制请求及轮询，不能视为纯渲染耗时。固定循环计时是控制请求到下一次观察到快照，包含100ms轮询下限；它不保证这份快照已属于目标项目，更不是按键到像素延迟。循环在同一个控制客户端的三个项目间发请求，同时页面轮换对话/终端/节点视图；节点视图仅自动检测本机 SSH 配置的路径与数量元数据，不导入或连接节点。另外通过 `native-interaction-benchmark.mjs` 在三个短历史项目上测真实点击到目标内容可见且两次 requestAnimationFrame 后的延迟；它与协议轮询计时分开报告。样本量和 P50/P95 由 summary.json 及 interaction.json 原样列出，不用三个样本制造稳定尾延迟结论。

2026-10-06，源码提交 `4fecc5b` 的 [主 CI](https://github.com/youweichen0208/pi-harness/actions/runs/37421363349) 和 [三平台发布工作流](https://github.com/youweichen0208/pi-harness/actions/runs/37421855122) 全部通过，[v0.99.8](https://github.com/youweichen0208/pi-harness/releases/tag/v0.99.8) 已公开。macOS/Windows/Linux 真实 runner 均完成原生工具、OAuth、包内服务回归，Windows 另通过工具栏和便携版重启验证；13 个发布附件的大小及 GitHub 提供的摘要见 [release-verification.json](review-data/release-verification.json)。这些结果不等于 Windows/Linux 资源实测；本机资源数值不外推到其他平台。真实 OAuth 服务端政策、真实模型长时间重试及复杂 PDF/极端附件负载不在这些夹具的验证范围内。

<!-- RESOURCE_RESULTS_START -->
## 实测结果

完整阶段表、CPU/句柄、采样错误和三轮原始值见 [资源汇总](review-data/resource-metrics.md) 与 [summary.json](review-data/summary.json)。内存和体积数值使用 MiB（2²⁰ bytes），不是 MB。

### 空闲基线与增长

| 独立基线 | 后端 GC heap | 渲染 GC heap | 全进程 RSS 观测峰值 |
| --- | ---: | ---: | ---: |
| 原生 SDK 导入，未建会话 | 30.4–30.4 | — | 128.3 |
| 原生 SDK：1 空闲会话 | 32.2–32.2 | — | 130.2 |
| 原生 SDK：3 空闲会话 | 33.5–33.5 | — | 135.8 |
| 原生 SDK：8 空闲会话 | 36.8–36.9 | — | 150.2 |
| Web：默认原生工具开启，首次连接后 | 42.0–42.0 | 5.2–5.4 | 1264.4 |
| Electron：默认原生工具开启，首次连接后 | 31.9–32.0 | 5.7–5.7 | 715.2 |

默认配置下，后端自然 RSS 峰值 Web 237.6 MiB、Electron 232.6 MiB；heap 不能替代进程占用。各行三轮独立进程。SDK 导入/空会话没有 WebUI 服务与浏览器；Web 独立 Chromium 的整套 RSS 不能视为已有浏览器新标签页的边际占用。默认工具开启并不意味着 Codemode worker 或 MCP 连接已经执行。

| 累计主负载阶段 | Web 后端 GC heap | Electron 后端 GC heap |
| --- | ---: | ---: |
| 新增 1 个客户端后断开 | 43.7–44.3 | 33.3–33.9 |
| 新增客户端累计 10 个后断开 | 50.2–51.7 | 38.6–40.2 |
| 新增客户端累计 30 个后断开 | 59.6–65.4 | 47.5–51.7 |
| 同一个 ID 重连 30 次 | 59.3–65.0 | 47.3–51.3 |
| 访问 3 个项目 | 63.8–101.8 | 52.3–77.8 |
| 访问 10 个项目 | 67.0–104.8 | 53.8–79.7 |
| 访问 30 个项目 | 75.6–113.5 | 61.5–87.5 |
| 后续 1 个活跃会话 | 141.6–176.9 | 109.9–133.5 |
| 后续 3 个活跃会话 | 142.8–178.1 | 110.9–134.5 |
| 后续 8 个活跃会话 | 146.1–181.6 | 113.6–137.5 |

新 ID 断开后仍保留 ClientSession；同 ID 重连基本复用原对象。项目数字包含自动恢复历史与先前阶段，不宜用总量除以项目数推导固定单项目成本。8 会话行还包含之前的大历史和客户端工作集。

### 页面稳定后的长历史

| 消息数 | Web 渲染 GC heap | Web GC DOM nodes 最大值 | Electron 渲染 GC heap | Electron GC DOM nodes 最大值 |
| ---: | ---: | ---: | ---: | ---: |
| 500 | 13.2–13.2 | 7,566 | 13.6–13.7 | 7,607 |
| 5,000 | 47.8–48.0 | 70,645 | 48.4–48.5 | 70,660 |
| 20,000 | 247.8–248.9 | 390,764 | 166.1–248.5 | 390,774 |

20,000 条稳定历史阶段，全进程树自然 RSS 峰值 Web 3321.4 MiB，Electron 2342.3 MiB。后端 GC heap 分别为 93.2–93.2 / 67.5–67.5 MiB。主负载中的对应阶段可能含前一历史的过渡分配，不能与这组更小起点的补测直接相减。

仅把旧消息折叠成摘要仍留下随消息数增长的 DOM；这些数值结合源码和缓存复现支持优先处理列表窗口化与序列化身份。长历史本身已不能视为轻量负载。

### 30 分钟固定工作集

| 指标 | Web | Electron |
| --- | ---: | ---: |
| 实际分钟 / 循环次数 | 30.1 / 350 | 30.0 / 350 |
| 后端 GC heap：循环前 → 后 | 147.8 → 149.1 | 115.2 → 116.4 |
| 后端 external：循环前 → 后 | 4.0 → 13.9 | 4.6 → 17.1 |
| 后端 GC 时 RSS：循环前 → 后 | 358.0 → 370.0 | 268.6 → 344.5 |
| 自然 heap：首/末分钟中位数 | 153.0 / 232.3 | 162.4 / 224.9 |
| 自然 RSS：首/末分钟中位数 | 361.8 / 395.5 | 269.0 / 366.6 |
| 后端自然 RSS / heap 峰值 | 484.6 / 301.5 | 436.7 / 253.9 |
| 后端 CPU P50 / P95（单核100%） | 0.1% / 15.7% | 0.1% / 14.2% |
| 后端末次句柄 / 活动资源数 | 7 / 74 | 7 / 74 |
| 渲染末次 GC heap / DOM nodes | 12.1 / 893 | 12.0 / 952 |
| 渲染主线程 duty P50 / P95 | 0.1% / 4.0% | 0.1% / 4.9% |
| Electron 主进程末次 GC heap | — | 6.4 |

后端 GC heap 的增加约 1–2 MiB，句柄/活动资源数未随循环增长；但 RSS 和 external 明显上升，本轮没有完成 external 的持有者归因，不能称作所有内存都稳定或排除 native/Buffer 留存。首次访问另两个项目、创建终端/节点视图也会增加正常工作集；自然 heap 的首末差异受 GC 周期影响，不能单独当泄漏斜率。桌面主进程在这组低日志量负载下较小，不验证高日志吞吐时的 serverOut 上限。

所有短轮次和两端长循环的采样错误数为 0。退出后对所有采样 PID 的检查见 [cleanup-audit.json](review-data/cleanup-audit.json)，没有发现残留；此检测不覆盖从未采样到的进程。

### 附加功能与传输

| 独立 SDK + MCP/Codemode 阶段 | 父进程自然 RSS 峰值 | 父进程 GC heap 范围 |
| --- | ---: | ---: |
| sdk-import | 128.1 | 30.6–30.6 |
| native-tools-loaded | 131.1 | 33.1–33.1 |
| codemode-mcp-execute | 171.0 | 37.7–37.7 |
| disposed | 171.0 | 37.2–37.2 |

MCP 表仅是独立 SDK 父进程，不含 stdio MCP 子进程 RSS；原始多 PID 样本保留在压缩包中。1/4/16 个空闲 PTY、关闭、Wiki/PDF/SQLite 与附件阶段的完整结果在资源汇总；它们是累计场景，不能用跨阶段总量估算某功能独占成本。

| 首屏已完成 HTTP 请求（默认工具空闲补测） | 传输 MiB 范围 | 请求数范围 |
| --- | ---: | ---: |
| web-default | 0.5–0.5 | 13–13 |
| electron-default | 0.5–0.5 | 12–12 |

| 稳定历史加载控制 WS 连接 | 20,000条 TCP 收到 MiB 范围 | 解压后收到 MiB 范围 |
| --- | ---: | ---: |
| web-history | 2.0–2.0 | 82.9–82.9 |
| electron-history | 1.7–2.3 | 69.0–96.7 |

WS 已协商 permessage-deflate；TCP 流计数包含控制帧而非 IP/TCP 包头。夹具重复文本压缩率很高，还显式 get_state 触发完整快照，因此不能外推真实代码/图片历史的流量。逐轮上传、下载、解压字节与扩展协商值在 summary.transfers。

<!-- RESOURCE_RESULTS_END -->

## 构建、安装与点击延迟

本机 macOS 26.5 / Apple M5 Pro / 24 GiB；Web/SDK 用 Node 26.0.0，正式桌面包为 Electron 41.10.7 / Node 24.18.0 / Chromium 146。Web 浏览器版本单独记录在 environment.json；Node/V8、渲染器版本及前台刷新率不同；后端内存和界面延迟都代表各自运行组合，不能把横向差异全部归因于应用代码或优化。

| 体积对象 | MiB | 口径 |
| --- | ---: | --- |
| npm 包 | 2.41 | npm pack --dry-run，不含依赖 |
| npm 解包 | 7.11 | 217 个发布文件 |
| 本机生产依赖 | 259.56 | npm ls --omit=dev 的唯一文件路径；含平台可选依赖，不含开发包 |
| Web 构建 | 5.70 | 磁盘文件合计，不等于首屏请求 |
| 服务端构建 | 0.69 | dist/server 文件合计 |
| macOS 安装后应用 | 451.57 | 逻辑文件字节，含 Electron 与裁剪后依赖 |
| macOS 应用磁盘占用 | 522.76 | du -sk，受文件系统分配粒度影响 |
| pi-0.99.8-mac-arm64.dmg | 161.51 | 本机正式构建，SHA-256 见 package-size.json |
| pi-0.99.8-mac-arm64.zip | 167.48 | 本机正式构建，SHA-256 见 package-size.json |

生产依赖最大的几项为 node-pty（约62 MiB）、pdfjs-dist（约33 MiB）、Pi SDK（约32 MiB）与本机 canvas（约27 MiB），详见 package-size.json。node-pty 的本机安装包含约58 MiB跨平台 prebuilds，但桌面产物已裁剪到约1.8 MiB，不能把本机全部预编译包误当作桌面还能直接削减的空间。React/xterm 等前端库已在 devDependencies；服务端实际使用的 remark-parse/unified 不能盲删。进一步裁剪应先核对运行时文件定位，保留原版 SDK 文档、原生工具和全部打包回归。

此处桌面安装包为本机 macOS arm64，Windows/Linux 不用估算值冒充实测安装体积。发布工作流另生成真实平台安装包。大小与哈希见 [package-size.json](review-data/package-size.json)。

| 启动/真实点击场景 | Web P50/P95 ms | Electron P50/P95 ms | 样本数/每端 |
| --- | ---: | ---: | ---: |
| launch-to-ready | 1066.3 / 1088.0 | 885.6 / 895.3 | 3 |
| warm-project-click | 49.5 / 50.9 | 24.3 / 24.8 | 90 |
| warm-view-click | 32.5 / 34.1 | 16.0 / 17.3 | 90 |

启动为三个隔离进程样本，没有清理 OS 文件缓存，P95只是其中最大值。点击每轮30次；项目场景在三个已预热的短历史之间切换；视图场景为终端/对话。通过 DOM click 触发真实处理器，等待目标内容和两次动画帧，不包含物理输入设备/合成器呈现延迟。原始样本见 [Web](review-data/web-interaction.json) / [Electron](review-data/electron-interaction.json)。

## 可复现入口

```bash
npm run check:lockfile
npm ci
npm run check:protocol
npm run typecheck
npm run build
npm test
npm run test:smoke

node tests/native-resource-benchmark.mjs --mode=sdk --seconds=0 --rounds=3
node tests/native-resource-benchmark.mjs --mode=web --seconds=1800 --rounds=3
npm run build:electron:mac -- --publish never
node tests/native-resource-benchmark.mjs --mode=electron --seconds=1800 --rounds=3 \
  --electron-executable=release/mac-arm64/pi.app/Contents/MacOS/pi
node tests/native-resource-tools.mjs
node tests/native-resource-benchmark.mjs --mode=web --seconds=0 --rounds=3 --history-only --out=docs/review-data/web-history
node tests/native-resource-benchmark.mjs --mode=electron --seconds=0 --rounds=3 --history-only --out=docs/review-data/electron-history \
  --electron-executable=release/mac-arm64/pi.app/Contents/MacOS/pi
node tests/native-resource-benchmark.mjs --mode=web --seconds=0 --rounds=3 --idle-only --default-tools --out=docs/review-data/web-default
node tests/native-resource-benchmark.mjs --mode=electron --seconds=0 --rounds=3 --idle-only --default-tools --out=docs/review-data/electron-default \
  --electron-executable=release/mac-arm64/pi.app/Contents/MacOS/pi
node tests/native-interaction-benchmark.mjs
node tests/native-interaction-benchmark.mjs --electron-executable=release/mac-arm64/pi.app/Contents/MacOS/pi
node tests/summarize-native-resources.mjs
node tests/verify-resource-cleanup.mjs
node tests/measure-package-size.mjs

node tests/pi-message-cache-review-repro.mjs docs/review-data/message-cache-reproductions.json
node tests/pi-native-review-repro.mjs docs/review-data/native-reproductions.json
node tests/pi-104-upstream-fixes-test.mjs docs/review-data/pi-104-upstream-fixes.json
```

基准输出路径用 `--out` 指定空目录；同一路径重复运行会追加 JSONL，比较前应使用新的输出目录。仅清理脚本自己创建的临时目录与进程。原始采样见 [raw-samples.tar.gz](review-data/raw-samples.tar.gz)，先解压到 review-data 再运行汇总脚本；字段与归档说明见 [证据说明](review-data/README.md)。

## 问题优先级与优化路线

| 优先级 | 证据类型与问题 | 触发与影响 | 建议、收益、成本和兼容风险 |
| --- | --- | --- | --- |
| P1 | 已复现：强停恢复会话错归属（N1） | 同 cwd A/B，B 最近落盘；A force-reset 恢复 B，后台 A 未重新订阅 | 捕获原会话文件并 bindSession(conv)，加入恢复世代检查；消除串会话风险，成本中等，须覆盖 Wiki/空会话/释放竞争 |
| P1 | 已复现缓存失效 + 实测历史DOM增长 | >4096消息序列化缓存扫描回绕；历史摘要仍逐条挂载 | 保持持久消息引用，摘要列表窗口化；直接降低CPU、DOM及快照成本，成本中高，须保留树导航、搜索、滚动锚点和附件编辑ID |
| P2 | 受控复现：同timestamp消息指纹碰撞 | 不同正文首512字符和总长相同，缓存会共享UI内容/ID；原生entryId附件引用仍正确 | 使用原生entry身份或可靠内容标识；成本中，兼顾流式消息与同毫秒附件，不能将显示错用等同SDK原始历史损坏 |
| P2 | 已复现：reload 归属和入口重叠（N2/N3） | reload 等待时切换会话；保存/MCP/手动入口同时进入 | 捕获来源session，统一按会话串行reload；成本中，保留原生shutdown/start顺序，不伪造成功 |
| P2 | 设计留存：断线客户端、跨项目runtime缺全局预算 | 不断新增clientId/项目后断开或切走 | 按空闲/无任务/无PTY安全休眠，设置总预算；收益随使用规模增长，成本中，不能停止用户后台任务换内存 |
| P2 | 静态无界：Electron serverOut | 子进程持续写stdout/stderr，主进程保留全部历史 | 仅保留诊断尾部；收益明确、成本与兼容风险低，需日志压力回归 |
| P3 | 有界但上限偏宽：Wiki/PDF/终端/草稿 | 多项目索引、复杂PDF、多个会话终端、累计草稿 | 从条目个数改为全局字节预算及分批读取；成本中，必须保护未提交用户草稿 |
| P3 | 实测增长、原因未定位：external/RSS | 两端30分钟后 external 约增加10–12MiB，GC heap仅增1–2MiB | 做Buffer/native内存归因及更长复测；本轮不能判定泄漏或推算日增长，成本中 |
| P3 | 明确平台差异：扩展编辑器/TUI UI | getEditorText 空值、autocomplete/custom等无Web等价 | 公布RPC支持矩阵，再按实际插件需求实现异步草稿读取；文档成本低，协议扩展风险中 |

升级之外的优化与既有缺陷在本轮仅审查和复现，没有混入 SDK 升级实现。
