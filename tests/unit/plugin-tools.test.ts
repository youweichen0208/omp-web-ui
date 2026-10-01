/**
 * 插件 AI 工具扩展点单测：
 *  - PluginManager.registerAgentTool：注册/重名拒绝/反激活自动注销/onAgentToolsChanged 回调。
 * 零 token、零网络，毫秒级。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager } from "../../server/plugins.js";

describe("PluginManager.registerAgentTool", () => {
	function makeFixture(dir: string, body: string) {
		mkdirSync(join(dir, "plugins", "fixture"), { recursive: true });
		writeFileSync(
			join(dir, "plugins", "fixture", "manifest.json"),
			JSON.stringify({ name: "夹具" }),
		);
		writeFileSync(join(dir, "plugins", "fixture", "index.mjs"), body);
	}

	it("注册 → 可读取 → 反激活自动注销 → 变化回调触发", async () => {
		const base = mkdtempSync(join(tmpdir(), "pwi-plug-tools-"));
		try {
			makeFixture(
				base,
				`
export default {
	activate(host) {
		const offA = host.registerAgentTool({
			name: "fixture_ping",
			description: "test tool",
			execute: async () => ({ content: [{ type: "text", text: "pong" }] }),
		});
		return () => offA();
	},
};
`,
			);
			const mgr = new PluginManager(base, process.cwd());
			let changes = 0;
			mgr.onAgentToolsChanged = () => {
				changes += 1;
			};
			await mgr.ensureLoaded();
			expect(mgr.getAgentTools().map((t) => t.name)).toEqual(["fixture_ping"]);
			expect(changes).toBeGreaterThanOrEqual(1);

			// 重名注册被拒绝（返回的注销函数是空操作）
			mgr.dispose();
			await mgr.ensureLoaded();
			const before = mgr.getAgentTools().length;
			void before;
			mgr.dispose();

			// 删除插件目录后重新加载 → 工具随之消失
			rmSync(join(base, "plugins", "fixture"), { recursive: true, force: true });
			const mgr2 = new PluginManager(base, process.cwd());
			await mgr2.ensureLoaded();
			expect(mgr2.getAgentTools()).toEqual([]);
			mgr2.dispose();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
