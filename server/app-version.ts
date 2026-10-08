import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Version of the running pi-harness package, independent of the pi SDK. */
export function appVersion(root?: string): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = root ? [root] : [process.env.PI_WEB_PKG_ROOT, resolve(here, ".."), resolve(here, "..", "..")];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { name?: string; version?: string };
			if (pkg.name === "@youweichen/pi-harness" && typeof pkg.version === "string") return pkg.version;
		} catch { /* inspect the next package root */ }
	}
	return "0.0.0";
}
