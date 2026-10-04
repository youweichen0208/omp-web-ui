import { expect, test } from "vitest";
import { codemodeDetails } from "../../server/codemode-presentation.js";
import { parseNativeMcpStatus } from "../../server/native-mcp-presentation.js";
import { codemodeScript, codemodeOptions } from "../../web/src/codemode-presentation.js";
import { effectiveMcpExposure, importMcpJson } from "../../web/src/mcp-presentation.js";

test("native renderer details retain models cost and cancellation without arbitrary metadata", () => {
	const result = codemodeDetails({ calls: [{ id: "a", name: "models.classify", status: "ok", args: "{}", durationMs: 123, cost: .002 }, { id: "b", name: "read", status: "cancelled", cost: Infinity }, { id: "c", status: "bogus" }], fullOutputPath: "/tmp/output", token: "SECRET" });
	expect(result?.calls).toHaveLength(2); expect(result?.calls[0].cost).toBe(.002); expect(result?.calls[1].status).toBe("cancelled"); expect(result?.calls[1].cost).toBeUndefined(); expect(JSON.stringify(result)).not.toContain("SECRET");
	expect(codemodeDetails({ calls: Array.from({ length: 300 }, (_, id) => ({ id: String(id), name: "read", status: "ok" })) })).toMatchObject({ totalCalls: 300, calls: expect.any(Array) });
	expect(codemodeDetails({ calls: Array(300).fill({ id: "a", name: "read", status: "ok" }) })?.calls).toHaveLength(256);
});
test("scripts/options survive native JSON storage and malformed streaming fragments", () => {
	const code = '// @options: {"max_output_tokens": 25, "timeout_ms": 1000}\ntext("ok")';
	expect(codemodeScript(JSON.stringify({ code }))).toBe(code); expect(codemodeOptions(code)).toEqual({ max_output_tokens: 25, timeout_ms: 1000 }); expect(codemodeOptions('// @options: {"timeout_ms":"invalid"}')).toEqual({}); expect(codemodeScript('{"co')).toBe('{"co');
});
test("status parser preserves server failures, authentication and disconnected states", () => {
	const states = parseNativeMcpStatus('git: needs sign-in, run /mcp login git (deferred)\ndb: failed (codemode)\n    ECONNREFUSED\nfs: connected, 4 tools (direct)\noff: disabled (hidden)\nlater: disconnected, reconnects on next call (codemode)\nconfig error: invalid entry');
	expect(states.map(s => s.state)).toEqual(["needs-auth", "failed", "connected", "disabled", "disconnected"]); expect(states[1].detail).toContain("ECONNREFUSED"); expect(states[2].toolCount).toBe(4);
});
test("exposure exact overrides win over ordered patterns and regex punctuation is literal", () => {
	const config = { exposure: "deferred", toolExposure: { "get_*": "codemode", get_one: "direct", "get.a": "hidden" } };
	expect(effectiveMcpExposure(config, "get_one").value).toBe("direct"); expect(effectiveMcpExposure(config, "get_two").value).toBe("codemode"); expect(effectiveMcpExposure(config, "getxa").value).toBe("deferred"); expect(effectiveMcpExposure(config, "get.a").value).toBe("hidden");
});
test("JSON imports convert client formats, preserve current config and reject collisions/prompts", () => {
	const current = { autoEnableCodemode: false, mcpServers: { keep: { command: "node" } } };
	const result = importMcpJson(JSON.stringify({ mcp: { imported: { type: "local", command: ["node", "server.js"], environment: { TOKEN: "{env:TOKEN}" } } } }), current);
	expect(result).toMatchObject({ autoEnableCodemode: false, mcpServers: { keep: { command: "node" }, imported: { type: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "${TOKEN}" } } } });
	expect(() => importMcpJson('{"mcpServers":{"keep":{"url":"x"}}}', current)).toThrow(/already exists/); expect(() => importMcpJson('{"servers":{"a":{"url":"${input:key}"}}}', current)).toThrow(/ENV_NAME/);
});
