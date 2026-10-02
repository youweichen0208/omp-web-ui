import { describe, it, expect, vi, afterEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const mocks = vi.hoisted(() => ({
	state: vi.fn(),
	settingsFor: vi.fn(),
	file: vi.fn(),
	baseline: vi.fn(),
	touch: vi.fn(),
	query: vi.fn(),
	recordWait: vi.fn(),
	busy: vi.fn(),
}));
vi.mock("../../server/code-intelligence.js", () => ({
	codeManager: () => mocks,
	languageOf: (path: string) =>
		/\.[jt]sx?$/.test(path)
			? "typescript"
			: path.endsWith(".py")
				? "python"
				: undefined,
}));
import { codeFeedback, changedLines } from "../../server/code-feedback.js";
function fixture() {
	const handlers = new Map<string, (event: any) => any>();
	mocks.settingsFor.mockReturnValue({ enabled: true, feedback: true });
	mocks.file.mockResolvedValue({
		path: "a.ts",
		text: "const value: number = 'bad';",
	});
	mocks.baseline.mockResolvedValue([]);
	mocks.touch.mockResolvedValue(undefined);
	mocks.query.mockResolvedValue({
		freshness: "partial",
		diagnostics: [
			{
				path: "a.ts",
				line: 1,
				column: 1,
				severity: 1,
				message: "Type mismatch",
				code: "2322",
			},
		],
	});
	codeFeedback(
		"/project",
		"conversation",
	)({
		on: (name: string, handler: (event: any) => any) =>
			handlers.set(name, handler),
	} as unknown as ExtensionAPI);
	return handlers;
}
const event = (id: string, name: string, parent?: string) => ({
	toolCallId: id,
	toolName: name,
	parentToolCallId: parent,
	input: { path: "a.ts" },
	content: [
		{ type: "text", text: "original" },
		{ type: "image", mimeType: "image/png", data: "fixture" },
	],
	structuredContent: { value: 1 },
	details: { kept: true },
	usage: { tokens: 1 },
	isError: false,
});
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});
describe("Persistent edit diagnostics", () => {
	it("aggregates nested writes on the outer result and preserves all result fields", async () => {
		const h = fixture();
		await h.get("tool_call")!(event("outer", "codemode"));
		await h.get("tool_call")!(event("outer/1", "write", "outer"));
		expect(
			await h.get("tool_result")!(event("outer/1", "write", "outer")),
		).toBeUndefined();
		const outer = { ...event("outer", "codemode"), isError: true };
		const result = await h.get("tool_result")!(outer);
		expect(result.content.slice(0, 2)).toEqual(outer.content);
		expect(result.content[2].text).toContain("Type mismatch");
		expect(result).toMatchObject({
			structuredContent: outer.structuredContent,
			details: outer.details,
			usage: outer.usage,
			isError: true,
		});
		expect(h.has("context")).toBe(false);
	});
	it("waits for multiple nested edits in parallel under a single deadline", async () => {
		vi.useFakeTimers();
		const h = fixture();
		mocks.query.mockImplementation(() => new Promise(() => {}));
		for (const [id, path] of [
			["root/1", "a.ts"],
			["root/2", "b.ts"],
		]) {
			mocks.file.mockResolvedValueOnce({ path, text: "" });
			await h.get("tool_call")!({
				...event(id, "write", "root"),
				input: { path },
			});
			await h.get("tool_result")!(event(id, "write", "root"));
		}
		const pending = h.get("tool_result")!(event("root", "codemode"));
		await vi.advanceTimersByTimeAsync(1200);
		const result = await pending;
		expect(mocks.query).toHaveBeenCalledTimes(2);
		expect(result.content.at(-1).text).toContain("a.ts: pending");
		expect(result.content.at(-1).text).toContain("b.ts: pending");
		expect(mocks.recordWait).toHaveBeenCalledWith("/project", 1200);
	});
	it("adds no result content when automatic feedback is disabled", async () => {
		const h = fixture();
		mocks.settingsFor.mockReturnValue({ enabled: true, feedback: false });
		await h.get("tool_call")!(event("edit", "edit"));
		expect(await h.get("tool_result")!(event("edit", "edit"))).toBeUndefined();
		expect(mocks.query).not.toHaveBeenCalled();
	});
	it("limits the no-baseline neighborhood to changed lines", () => {
		expect(changedLines("same\nold\ntail", "same\nnew\ntail")).toEqual([1, 7]);
	});
});

it("skips unsupported files without reading state or waiting", async () => {
	const h = fixture();
	const e = { ...event("md", "write"), input: { path: "README.md" } };
	await h.get("tool_call")!(e);
	expect(await h.get("tool_result")!(e)).toBeUndefined();
	expect(mocks.state).not.toHaveBeenCalled();
	expect(mocks.query).not.toHaveBeenCalled();
	expect(mocks.file).not.toHaveBeenCalled();
});

it("does not present macro analysis limitations as real errors to the model", async () => {
	const h = fixture();
	mocks.query.mockResolvedValue({
		freshness: "fresh",
		diagnostics: [
			{
				path: "a.ts",
				line: 1,
				column: 1,
				severity: 1,
				message: "macro not expanded",
				code: "unresolved-proc-macro",
				analysisLimitation: true,
			},
		],
	});
	await h.get("tool_call")!(event("edit", "write"));
	const result = await h.get("tool_result")!(event("edit", "write"));
	expect(JSON.stringify(result)).not.toContain("macro not expanded");
});
