// electron-builder afterPack 钩子：给 macOS 构建产物做临时签名（ad-hoc signing）。
//
// 背景：electron-builder.yml 里 mac.identity 是 null（没有 Apple 开发者证书，
// 不想花钱签名/公证），但 Apple Silicon（arm64）从 macOS 11 起要求可执行文件
// 必须至少有一个签名（哪怕是 ad-hoc 的 `codesign --sign -`）才能启动——完全没
// 签名的 arm64 app，系统会直接报「已损坏，应该将其移到废纸篓」，且没法像
// 「未知开发者」那样右键打开跳过，只能靠用户在终端手动 `xattr -cr` 才能用。
//
// 加上这一步 ad-hoc 签名后，效果会变成常见的「无法验证开发者」提示，用户
// 右键 App → 打开 → 再点一次「打开」就能正常使用，不用碰终端。
// 这不是真正的代码签名/公证（不需要 Apple 开发者账号，免费），只是让系统
// 认得这是一个「完整」的可执行包，不算「损坏」。
//
// afterPack 在 app 打包完、dmg/zip 打包前执行，参数结构见：
// https://www.electron.build/configuration/configuration#afterpack

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
	const product = context.packager.appInfo.productFilename;
	const packagedRoot = context.electronPlatformName === "darwin"
		? path.join(context.appOutDir, `${product}.app`, "Contents/Resources/app")
		: path.join(context.appOutDir, "resources/app");
	const sdkRoot = path.join(packagedRoot, "node_modules/@earendil-works/pi-coding-agent");
	if (JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8")).version !== "1.0.0") throw new Error("Unexpected packaged Pi SDK version");
	if (!fs.readFileSync(path.join(sdkRoot, "dist/core/sdk.js"), "utf8").includes("pi-web-ui: restored sessions")) throw new Error("Packaged SDK is missing resume compatibility patch");
	if (!fs.readFileSync(path.join(sdkRoot, "docs/codemode.md"), "utf8").includes("generateImages")) throw new Error("Packaged codemode reference is missing");
	if (context.electronPlatformName !== "darwin") return;

	const appName = context.packager.appInfo.productFilename;
	const appPath = path.join(context.appOutDir, `${appName}.app`);

	if (!fs.existsSync(appPath)) {
		console.warn(`[afterPack] 没找到 ${appPath}，跳过 ad-hoc 签名`);
		return;
	}

	console.log(`[afterPack] ad-hoc 签名 ${appPath} ...`);
	execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
		stdio: "inherit",
	});
	console.log("[afterPack] ad-hoc 签名完成");
};
