import { readFileSync } from "node:fs";

try {
	const lockfile = JSON.parse(readFileSync(process.argv[2] ?? "package-lock.json", "utf8"));
	if (!lockfile.packages || typeof lockfile.packages !== "object" || Array.isArray(lockfile.packages)) {
		throw new Error("lockfile must contain package entries");
	}
	let failures = 0;
	for (const [name, entry] of Object.entries(lockfile.packages)) {
		if (!Object.hasOwn(entry, "resolved") || entry.link === true) continue;
		let valid = false;
		try {
			const url = new URL(entry.resolved);
			valid = url.protocol === "https:" && url.host === "registry.npmjs.org" && !url.username && !url.password;
		} catch { /* Report malformed URLs along with non-official sources. */ }
		if (!valid) {
			console.error(`${name || "(root)"}: invalid resolved URL ${JSON.stringify(entry.resolved)}`);
			failures++;
		}
	}
	if (failures) process.exitCode = 1;
	else console.log("Lockfile download URLs use the official HTTPS npm registry.");
} catch (error) {
	console.error(`Lockfile check failed: ${error.message}`);
	process.exitCode = 1;
}
