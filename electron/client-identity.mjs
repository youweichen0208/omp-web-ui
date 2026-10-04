import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Desktop has one window; its identity must survive both process and port changes. */
export function desktopClientId(dataDir) {
	mkdirSync(dataDir, { recursive: true });
	const path = join(dataDir, "desktop-client-id");
	try {
		const id = readFileSync(path, "utf8").trim();
		if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) throw new Error("Invalid desktop client identity");
		return id;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const id = randomUUID();
	writeFileSync(path, `${id}\n`, { flag: "wx", mode: 0o600 });
	return id;
}
