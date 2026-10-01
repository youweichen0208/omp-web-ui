import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Version of the running omp-web-ui package, independent of the OMP runtime. */
export function appVersion(root?: string): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = root ? [root] : [process.env.OMP_WEB_PKG_ROOT, resolve(here, ".."), resolve(here, "..", "..")];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { name?: string; version?: string };
			if (pkg.name === "@youweichen/omp-web-ui" && typeof pkg.version === "string") return pkg.version;
		} catch { /* inspect the next package root */ }
	}
	return "0.0.0";
}

/** SemVer precedence, including numeric prerelease identifiers and stable promotion. */
export function compareAppVersions(a: string, b: string): number {
	const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
	const left = parse(a), right = parse(b);
	if (!left || !right) return 0;
	for (let i = 1; i <= 3; i++) if (Number(left[i]) !== Number(right[i])) return Number(left[i]) - Number(right[i]);
	if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0;
	const l = left[4].split("."), r = right[4].split(".");
	for (let i = 0; i < Math.max(l.length, r.length); i++) {
		if (l[i] === undefined || r[i] === undefined) return l.length - r.length;
		if (l[i] === r[i]) continue;
		const ln = /^\d+$/.test(l[i]), rn = /^\d+$/.test(r[i]);
		if (ln && rn) return Number(l[i]) - Number(r[i]);
		if (ln !== rn) return ln ? -1 : 1;
		return l[i] < r[i] ? -1 : 1;
	}
	return 0;
}
