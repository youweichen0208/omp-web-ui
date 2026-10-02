/** Pi 1.0.0 passes new-session defaults on resume, bypassing transcript tool restoration. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../node_modules/@earendil-works/pi-coding-agent/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
if (manifest.version === "1.0.0") {
	const path = fileURLToPath(new URL("dist/core/sdk.js", root));
	const before = "        initialActiveToolNames,\n        usesDefaultTools:";
	const after = "        // pi-web-ui: restored sessions derive their loadout from the transcript.\n        initialActiveToolNames: hasExistingSession && options.tools === undefined && !options.noTools ? undefined : initialActiveToolNames,\n        usesDefaultTools:";
	const source = readFileSync(path, "utf8");
	if (!source.includes(after)) {
		if (!source.includes(before)) throw new Error("Pi 1.0 SDK resume patch no longer matches; review before building");
		writeFileSync(path,source.replace(before,after));
		console.log("Applied Pi 1.0 SDK transcript tool restoration patch");
	}
}
