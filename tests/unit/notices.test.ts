import { describe, expect, it } from "vitest";
import { appendNotice, isLegacyMcpNotice } from "../../web/src/notices.js";
import type { Notice } from "../../web/src/notices.js";

const warning: Notice = { id: 1, level: "error", text: "目录不可读：ENOENT: scandir 'D:\\knowledge-base\\raw'", conversationId: "a" };

describe("notice aggregation", () => {
	it("shows repeated directory errors once, with their occurrence count", () => {
		let notices: Notice[] = [];
		for (let id = 1; id <= 4; id++) notices = appendNotice(notices, { ...warning, id });
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ id: 1, count: 4, text: warning.text });
	});
	it("keeps different conversations, severities and texts separate", () => {
		let notices = [warning];
		for (const incoming of [{ ...warning, id: 2, conversationId: "b" }, { ...warning, id: 3, level: "info" as const }, { ...warning, id: 4, text: "another error" }, { ...warning, id: 5, conversationId: undefined }]) notices = appendNotice(notices, incoming);
		expect(notices).toHaveLength(5);
	});
	it("merges non-adjacent repeats immutably and preserves other notices", () => {
		const other: Notice = { id: 2, level: "info", text: "saved" };
		const original = [warning, other];
		const merged = appendNotice(original, { ...warning, id: 3 });
		expect(merged).toHaveLength(2);
		expect(merged[0].count).toBe(2);
		expect(original[0].count).toBeUndefined();
		expect(merged[1]).toBe(other);
	});
	it("retains the six-notice limit and starts fresh after dismissal", () => {
		let notices: Notice[] = [];
		for (let id = 0; id < 8; id++) notices = appendNotice(notices, { ...warning, id, text: String(id) });
		expect(notices.map(n => n.id)).toEqual([2, 3, 4, 5, 6, 7]);
		expect(appendNotice([], warning)[0].count ?? 1).toBe(1);
	});
});


describe("legacy MCP adapter notice", () => {
	it("recognizes Windows and POSIX migration messages without treating other errors as migration", () => {
		expect(isLegacyMcpNotice(String.raw`pi-mcp-adapter no longer reads C:\Users\user\.pi\agent\mcp.json. Move it with: mv ...`)).toBe(true);
		expect(isLegacyMcpNotice("pi-mcp-adapter no longer reads /home/user/.pi/agent/mcp.json. Merge source into target.")).toBe(true);
		expect(isLegacyMcpNotice("MCP connection failed")).toBe(false);
		expect(isLegacyMcpNotice("pi-mcp-adapter no longer reads /home/user/another.json. Move it with: mv ...")).toBe(false);
	});
});
