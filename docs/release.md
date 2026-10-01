# 发布流程

OMP 使用仓库 `youweichen0208/omp-web-ui`、npm 包 `@youweichen/omp-web-ui`、命令 `omp-web-ui`，桌面显示名称为 **OMP**。发布者 npm 账号为 `youweichen`。历史 Pi 版本的说明保留在 `.github/release-notes/v0.*.md`。

## 1.0.0 候选版

首个候选版本是 `1.0.0-beta.1`，npm 发布到 `next`，GitHub 标记 prerelease。应用只使用 Oh My Pi 和 `~/.omp/agent`，不改写旧 Pi 文件。beta.1 尚不自动导入模型；开发版新增首次启动模型导入，范围与隔离规则见 [OMP 运行时](architecture-omp.md#配置与凭据)。保留桌面内部 appId `com.youweichen.pi-web-ui` 和 Debian 包身份 `pi`，以维持安装器升级关系。

macOS 不使用付费签名或公证，构建后做 ad-hoc 签名。macOS 更新提示打开对应 Release，用户手动下载替换。

## 验证与提交

版本同步修改 package.json 和 package-lock.json（含根 package 项）；先检查 npm 上该版本未被占用。检查示例、测试日志和构建产物不含真实凭据。运行：

```bash
npm ci
npm run check:protocol
npm run typecheck
npm run build
npm test
npm run test:smoke
npm pack --dry-run
```

执行相关浏览器回归，并将真实 tarball 安装到临时目录，验证内置 Bun 和 OMP 会话。测试使用临时 agent/data/cwd，不连接开发者的模型或旧配置。Conventional Commit 使用 breaking change 标记；提交不得添加 Co-authored-by。

## 桌面 Release

推送 `v1.0.0-beta.1` 标签触发 `.github/workflows/release-desktop.yml`：

1. 校验标签与 package 版本一致，创建 draft prerelease。
2. macOS、Windows、Linux 原生 runner 安装依赖、构建前后端；只对 node-pty 执行 Electron rebuild。
3. electron-builder 使用 `--publish never` 生成产物。
4. 每个平台运行 packaged-server-start-test，使用包内 Electron/Bun 验证凭据、工具、todo、历史、SQLite 和 HTTP。Windows 另需终端、布局与 portable 重启回归。
5. 验证后的安装包和更新元数据上传 draft。三个 job 全部成功，最后一个 job 才将 draft 公开。

单平台手动重跑只上传该平台产物，不自动公开 Release。不得用 continue-on-error 绕过终端或包内启动失败。Bun 的 `.exe` 文件、原生工具使用的 `.d.ts` 文本资源和 CHANGELOG.md 必须显式保留，不能依赖 electron-builder 的默认过滤规则。

## npm

GitHub 和三平台验证通过后发布候选版：

```bash
npm whoami
npm publish --access public --tag next
npm view @youweichen/omp-web-ui@next version
```

`prepublishOnly` 自动构建；npm 包必须包含 omp-worker、dist、web/dist，以及声明的 Bun/OMP 精确依赖。正式 1.0.0 才发布到 `latest`。不要发布新版本到旧包名，也不要因旧包历史编号而改变候选版策略。

首次创建 npm 包的例外：2026-10-01 使用 `--tag next` 发布 1.0.0-beta.1 后，registry 自动附加了 `latest`；经身份验证后的删除请求仍返回 HTTP 400。因此该首版目前同时由 `next`/`latest` 指向，版本性质仍为 beta。后续候选版只显式更新 `next`，正式版再主动更新 `latest`。上游记录：https://github.com/npm/cli/issues/8490。

安装后执行 `omp-web-ui server restart` 使运行中的服务加载新版；Docker 重建并替换容器。发布结束核对 npm dist-tag、GitHub 标签/提交、Release 状态及三平台全部附件。
