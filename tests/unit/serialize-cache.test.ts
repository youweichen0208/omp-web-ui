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
