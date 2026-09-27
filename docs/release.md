# 发布流程

> npm 发布者账号是 `youweichen`（`npm whoami` 验证），包名 `@youweichen/pi-web-ui`。当前项目独立维护，仓库为 `youweichen0208/pi-web-ui`。`dist/`、`web/dist/` 被 gitignore 不进 git，但 `package.json` 的 `files` 白名单会把它们打进 npm 包；`prepublishOnly` 会在发布前自动 `npm run build`。

## 0.6.3 正式版

`0.6.3` 修复消息导航、用户消息折叠与命令输出预览，并在输入框显示上下文和模型缓存用量。推送 `v0.6.3` 标签会触发 macOS、Windows、Linux 安装包构建并生成 GitHub Release。本次 GitHub 发布与 npm 分开；只有完成 `npm publish` 后才将 npm 版本说明改为 `0.6.3`。

## 0.6.2 正式版

`0.6.2` 修复工作区文件误报、命令输出展示、断线时的工作状态与桌面服务恢复，并在 Web/Desktop 底栏显示运行版本。发布前核对 npm 版本未占用，保持 `package.json` 和 `package-lock.json` 一致，运行协议检查、类型检查、构建、单测、冒烟测试及 `npm pack --dry-run`。提交并推送源代码后，以 `npm publish --access public --tag latest` 发布 npm 包；推送 `v0.6.2` 标签会触发 macOS、Windows、Linux 的 Electron 安装包构建，生成正式 GitHub Release。最后核对 npm `latest`、GitHub Release 状态与三平台安装包。

**版本排序提醒**：SemVer 将 `0.6.x` 排在旧正式版 `0.51.2` 之前。npm 的 `latest` 标签可指向 `0.6.2`，但依赖范围 `^0.51.2` 不会自动升级；依赖方需要显式更新版本范围。后续版本规划需考虑这一历史编号。

## 步骤

```bash
# 1) 升版本（patch/minor 视改动；npm 上已存在该版本会 404 拒绝）
#    两处都要改，保持一致：
#      package.json 的 "version" 和 package-lock.json 的 "version"（第 2 行 + packages[""]）

# 2) 自检 + 构建
npm run typecheck
npm run build

# 3) 提交（Conventional Commits：feat/fix/perf/chore(scope): 描述，说明 why）
git add -A
git commit -m "feat(files): <一句话描述>"

# 4) 推送 GitHub（仓库公开：youweichen0208/pi-web-ui，分支 develop）
git push origin develop

# 5) 发布 npm（会自动跑 prepublishOnly 构建；scope 包必须 --access public）
npm publish --access public

# 6) 验证
npm view @youweichen/pi-web-ui version        # 应显示新版本（registry 有缓存延迟属正常）
curl -s https://registry.npmjs.org/@youweichen/pi-web-ui/latest | jq .version
```

## 注意事项

- 版本号**必须**高于 npm registry 上已有的；发布前用 `npm view @youweichen/pi-web-ui version` 核对。
- 提交信息不要带 `Co-authored-by`（P1 规则，仓库 hook 会拦）。
- `.pi/commands.json` 是**每个项目各自**的个人命令（当前 cwd 的 `.pi/ 下），已被 gitignore，永远不会进公开仓库；切换 cwd 时命令列表自动刷新为该项目的命令。
- 大改动发布前先问用户是否要 `npm publish`（会真实消耗账号权限、触发构建）。
- **升级后的重启**：`npm i -g` 只更新磁盘文件，已运行进程内存里还是旧代码——前端是每次请求实时读盘的（会先变新），但 WS 消息处理是进程内旧逻辑，新旧混跑会表现为「界面是新的、某功能一直加载中」。界面内「立即更新」（顶栏更新下拉）现在是在可见终端 tab 中跑 `npm i -g @youweichen/pi-web-ui@latest`（复用 SCM/插件卸载同款 tab 模式），完成后需手动重启服务生效：`pi-web-ui server restart`（launchd/systemd 由服务管理器拉起；Docker 需 `docker compose restart`）。服务端保留 `PI_WEB_RESTART_CHILD` 端口等待握手（restart-handoff-test 回归），供外部编排的替换子进程使用。
- **发布前检查示例文件不泄密**：`deploy/`、`README` 等随 npm 包（`files` 白名单含 `deploy/`）和 GitHub 分发的文件**绝不放真实 IP / 域名 / 密钥**——用占位符（如 `<LAN_IP>`、`<PUBLIC_IP>:<PUBLIC_PORT>`、`your-host`）。真实环境配置只在本地改，不进仓库。

## 历史 IP 泄露的清理方法

2026-08 实操过（`deploy/nginx-subpath.conf` 曾含 `192.168.1.101` / `39.99.235.208:60018`，波及 53/128 个 commit）：

1. 先改工作区文件为占位符；
2. `git filter-branch --force --index-filter 'if git cat-file -e :<file> 2>/dev/null; then BLOB=$(git cat-file blob :<file> | sed -e "s/<旧IP>/<占位符>/g" ... | git hash-object -w --stdin); git update-index --cacheinfo "100644,$BLOB,<file>"; fi' -- --all`（**不要用 xargs 传 cacheinfo**，Git for Windows 下参数会碎导致 `option 'cacheinfo' expects <mode>,<sha1>,<path>`）；
3. 重写后**手动把 tag 移到重写版**（`git tag -f vX.Y.Z $(git log main --format='%h %s' | grep -F '<tag的message>' | head -1 | cut -d' ' -f1)`，filter-branch 不会自动跟）；
4. 删备份分支 + `rm -rf .git/refs/original` + `git reflog expire --expire=now --all` + `git gc --prune=now --aggressive`；
5. 验证 `git rev-list --all | while read c; do git grep -l '<IP>' $c -- . 2>/dev/null; done` 为空后 `git push --force` main + tag。

**残留提醒**：已发布 npm 包的 tarball 无法追回（只能靠新版本替换）；GitHub 上被 force push 覆盖的旧对象对访问者不可见但服务器会留存（需联系 GitHub 支持彻底删）。
