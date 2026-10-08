import { expect, test } from "vitest";
import { contentFingerprint, type AgentMessage } from "../../server/serialize.js";

test("same-millisecond custom messages retain distinct cache identities", () => {
	const message: AgentMessage = { role: "custom", customType: "tool-call-recovery", content: "Correction deferred", display: true, details: { status: "deferred" }, timestamp: 1234 };
	const extension: AgentMessage = { ...message, customType: "extension-queue", content: "Wait for confirmation" };
	expect(contentFingerprint(message)).not.toBe(contentFingerprint(extension));
	expect(contentFingerprint(message)).not.toBe(contentFingerprint({ ...message, content: "Correction stopped" }));
	expect(contentFingerprint(message)).not.toBe(contentFingerprint({ ...message, details: { status: "cancelled" } }));
	expect(contentFingerprint(message)).not.toBe(contentFingerprint({ ...message, display: false }));
	expect(contentFingerprint(message)).toBe(contentFingerprint({ ...message }));
});

test("fingerprints include tails and every content block, including image bytes", () => {
	const make = (suffix: string): AgentMessage => ({ role: "user", timestamp: 42, content: [{ type: "text", text: "x".repeat(520) + suffix }] });
	expect(contentFingerprint(make("a"))).not.toBe(contentFingerprint(make("b")));
	const image = (data: string): AgentMessage => ({ role: "user", timestamp: 42, content: [{ type: "image", mimeType: "image/png", data }] });
	expect(contentFingerprint(image("AAAA"))).not.toBe(contentFingerprint(image("BBBB")));
	const second = (text: string): AgentMessage => ({ role: "user", timestamp: 42, content: [{ type: "text", text: "same" }, { type: "text", text }] });
	expect(contentFingerprint(second("one"))).not.toBe(contentFingerprint(second("two")));
});
