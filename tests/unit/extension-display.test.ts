import { expect, test } from "vitest";
import { extensionDisplay } from "../../server/extension-display.js";

test.each([
	["/app/node_modules/@scope/todo/index.ts", undefined, "@scope/todo"],
	["C:\\app\\node_modules\\@scope\\todo\\dist\\main.js", undefined, "@scope/todo"],
	["/app/node_modules/pkg/node_modules/nested/index.js", undefined, "nested"],
	["/agent/extensions/my-extension/index.ts", undefined, "my-extension"],
	["/agent/extensions/my-extension/dist/main.js", undefined, "my-extension"],
	["/agent/extensions/custom-footer.ts", undefined, "custom-footer"],
	["/project/.pi/extensions/index.ts", undefined, "project"],
	["/cache/index.ts", "npm:@scope/package", "@scope/package"],
	["", "npm:disabled-package", "disabled-package"],
])("extension entry %s has a recognizable label", (path, source, name) => {
	expect(extensionDisplay(path, source)).toEqual({ name });
});
