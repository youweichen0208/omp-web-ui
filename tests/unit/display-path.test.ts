import { expect, test } from "vitest";
import { compactWorkspacePath } from "../../web/src/display-path.js";
test("workspace paths abbreviate home and long middle sections on either platform", () => {
	expect(compactWorkspacePath("/Users/alice/projects/pi-harness")).toBe("~/projects/pi-harness");
	expect(compactWorkspacePath("/home/alice/projects/team/pi-harness")).toBe("~/projects/…/pi-harness");
	expect(compactWorkspacePath("C:\\Users\\alice\\projects\\team\\pi-harness")).toBe("~/projects/…/pi-harness");
	expect(compactWorkspacePath("/srv/work/project")).toBe("/srv/…/project");
});
