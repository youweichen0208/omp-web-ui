import { describe, expect, it } from "vitest";
import { extensionKey } from "../../server/client-state.js";

describe("extensionKey", () => {
	it("包扩展用 npm spec 作为稳定 id", () => {
		expect(
			extensionKey({
				sourceInfo: { origin: "package", source: "npm:pi-powerline-footer", path: "C:\\agent\\npm\\node_modules\\pi-powerline-footer\\dist\\index.js" },
				path: "C:\\agent\\npm\\node_modules\\pi-powerline-footer\\dist\\index.js",
			}),
		).toBe("npm:pi-powerline-footer");
	});

	it("无 sourceInfo 时回退到路径", () => {
		const p = "C:\\agent\\extensions\\my-ext\\index.ts";
		expect(extensionKey({ path: p })).toBe(p);
	});
});
