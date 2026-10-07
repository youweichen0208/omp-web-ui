# 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `PI_WEB_CWD` | `process.cwd()` | 智能体工作区（读/写/终端都以此为根） |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | 每客户端持久化 UI 状态（client-state.json，最近项目/工作目录）；对话会话放 SDK 默认目录 `<agentDir>/sessions/--<cwd>--/`（与 pi CLI/TUI 共享同一对话列表） |
| `PI_WEB_INLINE_FILE_MAX` | `12288` (12KB) | inline 附件的内联阈值，超过自动降级为路径引用 |
| `PI_WEB_VISION_TIMEOUT_MS` | `90000` | 视觉桥单次转写（整批图片）超时，防止慢视觉模型拖住 prompt |
| `PI_WEB_STALL_NOTIFY_MS` | `180000` | 模型无进展看门狗：流式运行中 N 毫秒无任何 SDK 事件则发 warning 提示可能失联（不自动 abort——深度思考可合法静默数分钟）；0 = 关闭 |
| `PI_WEB_UPLOAD_RETENTION_DAYS` | `14` | 上传文件保留天数（`<dataDir>/uploads/`，启动时扫一次 + 每 6 小时一次）；0 = 关闭清理 |
| `PI_WEB_SHELL` | 自动探测 | Windows 终端面板（node-pty）的 shell：默认优先 Git Bash（与 SDK bash 工具一致），可用此变量显式指定（如 `powershell.exe` / `cmd.exe`） |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi 配置目录（auth.json / models.json / skills） |
| `PI_WEB_HOST` | `127.0.0.1` | 监听地址。**默认只绑 loopback**（本地个人工具，不暴露到网络）；局域网/容器访问需显式 `0.0.0.0`（docker-compose 已内置） |
| `PI_WEB_ALLOW_ORIGINS` | 空 | 逗号分隔的额外 Origin 白名单（如 `http://localhost:5173` dev 代理、反代场景），用于绕过 WS 的 Origin/Host 同权威校验 |
| `PI_WEB_ALLOW_HOSTS` | 空 | 请求 Host 的 hostname 白名单（逗号分隔）。**未设置且绑定 loopback 时默认只放行 `localhost` / `127.0.0.1` / `[::1]`**，防 DNS rebinding；绑定 `0.0.0.0` 或走反代时需自行设置（否则只做 Origin/Host 同权威校验） |
| `PI_WEB_TOKEN` | 空 | **可选共享口令鉴权**：设置后所有 HTTP/WS 请求必须携带（`Authorization: Bearer` / `X-PI-Token` 头、`?token=` 参数或 `pi_web_token` cookie 任一匹配；浏览器首次经 `?token=xxx` 进入后存 localStorage 并下发 HttpOnly cookie）；`/api/health` 保持开放供探针。前端 `web/src/auth-token.ts` 统一注入；口令变化（或换端口重启）时服务端会重发 cookie，不会被旧 cookie 挡住；比较用常量时间；`/api/health` 不再返回工作区路径。**桌面版每次启动自动生成随机口令**（`electron/server-auth.mjs`），无需配置；回归：`tests/token-auth-test.mjs`（端口 8975）、`tests/desktop-server-auth-test.mjs` |
| `PI_WEB_CLIENT_IDLE_MINUTES` | `30` | 客户端（浏览器标签页）断开且无运行任务、终端、后台服务后，超过 N 分钟回收其会话（释放运行时与定时器；最近项目等状态已持久化，同一 clientId 回来会重建）；0 = 不回收。`client-state.json` 另外最多保留 200 个客户端条目 |
