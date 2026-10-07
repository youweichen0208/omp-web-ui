import { describe, expect, it } from "vitest";
import { groupBashMessages } from "../../web/src/bash-groups.js";
import { compactCommandLabel, commandRecordLabel, commandDuration } from "../../web/src/bash-presentation.js";
import type { UiMessage } from "../../server/protocol.js";
const call = (id: string): UiMessage => ({ id, role: "assistant", content: [{ type: "toolCall", id: `tool-${id}`, name: "bash", argumentsText: '{"command":"pwd"}' }] });
const result = (id: string): UiMessage => ({ id: `result-${id}`, role: "toolResult", toolCallId: `tool-${id}`, content: [{ type: "text", text: "/tmp" }] });

describe("command groups", () => {
	it("merges consecutive assistant calls across results without changing source messages", () => {
		const messages = [call("a"), result("a"), call("b"), result("b"), call("c")];
		const before = JSON.stringify(messages);
		const groups = groupBashMessages(messages);
		expect(groups.projected.get("a")?.content.map((block) => block.type === "toolCall" ? block.id : undefined)).toEqual(["tool-a", "tool-b", "tool-c"]);
		expect([...groups.owners]).toEqual([["b", "a"], ["c", "a"]]);
		expect(JSON.stringify(messages)).toBe(before);
	});
	it("respects user, prose, thinking, history and event boundaries", () => {
		for (const separator of [
			{ id: "user", role: "user", content: [{ type: "text", text: "continue" }] },
			{ id: "text", role: "assistant", content: [{ type: "text", text: "next" }] },
			{ id: "thinking", role: "assistant", content: [{ type: "thinking", thinking: "check" }] },
			{ id: "read", role: "assistant", content: [{ type: "toolCall", id: "read", name: "read" }] },
		]) expect(groupBashMessages([call("a"), separator, call("b")]).owners.size).toBe(0);
		expect(groupBashMessages([call("a"), call("b")], 1).owners.size).toBe(0);
		expect(groupBashMessages([call("a"), call("b")], 0, new Set([1])).owners.size).toBe(0);
	});
	it("shortens path interiors and multiline headers while preserving executable and leaf", () => {
		expect(compactCommandLabel("cat /Users/alice/projects/app/config.json")).toBe("cat …/config.json");
		expect(compactCommandLabel("python3 - <<'PY'\nprint(1)\nPY")).toBe("python3 - <<'PY'");
		expect(compactCommandLabel("git status --short")).toBe("git status --short");
	});
});

it("keeps the filename and omits only an unquoted trailing stderr redirect", () => {
	const command = "git show feat/hermes-design-package:docs/architecture/decisions/progress.json 2>/dev/null";
	expect(compactCommandLabel(command)).toBe("git show feat/hermes-design-package:docs/…/progress.json");
	expect(compactCommandLabel(command)).not.toContain("/dev/null");
	expect(commandRecordLabel(command)).toBe("progress.json");
	expect(commandRecordLabel(command.replace("progress.json", "ARCHITECTURE.md"))).toBe("ARCHITECTURE.md");
	for (const literal of ["echo 'text 2>/dev/null'", 'echo "text 2>/dev/null"', 'echo "unterminated 2>/dev/null', "echo x && cat f 2>/dev/null"]) expect(compactCommandLabel(literal)).toBe(literal);
	expect(commandDuration(0)).toBe("<0.1s");
	expect(commandDuration(99)).toBe("<0.1s");
	expect(commandDuration(100)).toBe("0.1s");
});
