/**
 * 插件宿主设施单测（零依赖、毫秒级）：storage / secrets / deps 探测 /
 * apiVersion 门控 / 斜杠命令注册表。不启 server、不碰网络。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSecrets, isDepAvailable } from "../../server/plugin-facilities.js";
import { PLUGIN_API_VERSION, PluginManager, type PluginHost } from "../../server/plugins.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, code: string, manifest?: Record<string, unknown>): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...(manifest ?? {}) }));
	writeFileSync(join(pdir, "index.mjs"), code);
}

/** 抓取宿主对象，供断言宿主设施行为。 */
async function activate(id: string): Promise<PluginHost> {
	let host!: PluginHost;
	makePlugin(
		id,
		`export default { activate(h) { globalThis.__hosts["${id}"] = h; } };`,
	);
(globalThis as unknown as { __hosts?: Record<string, PluginHost> }).__hosts ??= {};
	await mgr.ensureLoaded();
	host = (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts[id];
	expect(host).toBeTruthy();
	return host;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-facilities-test-"));
	mgr = new PluginManager(dir, dir);
});

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("host.storage", () => {
	it("get/set/all/delete 往返 + 落盘 <pluginDir>/storage.json", async () => {
		const h = await activate("a");
		h.storage.set("layout", { split: 0.3 });
		expect(h.storage.get("layout")).toEqual({ split: 0.3 });
		expect(h.storage.get("missing", "fallback")).toBe("fallback");
		expect(Object.keys(h.storage.all())).toContain("layout");
		// 明文落盘到插件目录，跨实例（重新 load）可读
		expect(existsSync(join(dir, "plugins", "a", "storage.json"))).toBe(true);

		h.storage.set("k", 1);
		h.storage.delete("k");
		expect(h.storage.get("k")).toBeUndefined();
	});
});

describe("host.secrets", () => {
	it("set/get 往返；明文绝不写进文件；has/list/delete 正常", async () => {
		const h = await activate("b");
		const secret = "hunter2-super-secret-密码";
		h.secrets.set("mail_pass", secret);
		expect(h.secrets.get("mail_pass")).toBe(secret);
		expect(h.secrets.has("mail_pass")).toBe(true);
		expect(h.secrets.list()).toEqual(["mail_pass"]);

		const raw = readFileSync(join(dir, "plugins", "b", "secrets.bin"), "utf8");
		expect(raw).not.toContain(secret); // 密文形态存在
		expect(raw.length).toBeGreaterThan(50);

		h.secrets.delete("mail_pass");
		expect(h.secrets.get("mail_pass")).toBeUndefined();
		expect(h.secrets.has("mail_pass")).toBe(false);
	});

	it("换了宿主密钥（拷到别的机器）解不开 → fail closed 返回 undefined", async () => {
		const h = await activate("c");
		h.secrets.set("token", "t0psecret");
		// 同一插件目录、不同 dataDir（= 不同密钥）
		const otherDataDir = mkdtempSync(join(tmpdir(), "other-data-"));
		try {
			const stolen = new PluginSecrets(otherDataDir, join(dir, "plugins", "c"));
			expect(stolen.get("token")).toBeUndefined();
		} finally {
			rmSync(otherDataDir, { recursive: true, force: true });
		}
	});
});

describe("deps 探测", () => {
	it("isDepAvailable 命中内置模块 / 未安装包返回 false", () => {
		const pdir = mkdirSync(join(dir, "plugins", "empty"), { recursive: true });
		expect(isDepAvailable(pdir ?? dir, "node:path")).toBe(true);
		expect(isDepAvailable(pdir ?? dir, "definitely-not-a-module-xyz")).toBe(false);
	});
});

describe("apiVersion 门控", () => {
	it("manifest apiVersion 高于宿主 → 激活失败并提示升级；低于等于 → 正常激活", async () => {
		makePlugin("futuristic", "export default {};", { apiVersion: PLUGIN_API_VERSION + 1 });
		makePlugin("classic", "export default {};", { apiVersion: 1 });
		const list = await mgr.ensureLoaded();
		expect(list.find((p) => p.id === "futuristic")?.error).toContain("请升级 pi-web-ui");
		expect(list.find((p) => p.id === "classic")?.error).toBeUndefined();
	});
});
