import { describe, it, expect } from "vitest";
import { encodePrompt, projectPrompt } from "../../server/omp/prompt-content.js";

describe("OMP atomic attachments", () => {
	it("keeps bridged thumbnails out of model input and restores them from metadata", () => {
		const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
		const encoded = encodePrompt("Read this", [{ message: { customType: "file", content: [{ type: "text", text: "Transcribed evidence" }, image], display: true, details: { mode: "bridged" } } }]);
		expect(encoded.images).toBeUndefined();
		expect(encoded.message).not.toContain(image.data);
		expect(encoded.message).toContain("Transcribed evidence");
		const thumbnails = new Map([[encoded.thumbnails!.id, encoded.thumbnails!.images]]);
		const projected = projectPrompt({ role: "user", content: encoded.message, timestamp: 1 }, thumbnails);
		expect(projected[0].role === "custom" && projected[0].content).toContainEqual(image);
		expect(projected[1].role === "user" && projected[1].content).toBe("Read this");
	});
	it("sends direct images once and projects the matching attachment", () => {
		const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
		const encoded = encodePrompt("Describe", [{ message: { customType: "file", content: [image], display: true } }]);
		expect(encoded.images).toEqual([image]);
		expect(encoded.message).not.toContain(image.data);
		const projected = projectPrompt({ role: "user", content: [{ type: "text", text: encoded.message }, ...encoded.images!], timestamp: 1 });
		expect(projected[0].role === "custom" && projected[0].content).toEqual([image]);
		expect(projected[1].role === "user" && projected[1].content).toBe("Describe");
	});
});
