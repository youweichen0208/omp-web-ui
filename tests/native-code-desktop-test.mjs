/** Run real native language fixtures using the packaged Electron runtime/SDK. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const [executable, root] = process.argv.slice(2).map((path) => resolve(path));
assert(
	executable && root,
	"Usage: node tests/native-code-desktop-test.mjs <Electron executable> <app root>",
);
assert(
	process.env.PI_NATIVE_TEST_DATA,
	"Prepare isolated native toolchains with native-code-intelligence-test.mjs --install first",
);
for (const test of [
	"native-code-intelligence-test.mjs",
	"maven-code-intelligence-test.mjs",
]) {
	execFileSync(executable, [resolve("tests", test)], {
		stdio: "inherit",
		timeout: 600000,
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			PI_NATIVE_APP_ROOT: root,
			PI_NATIVE_MAVEN_PREFIX: "backend",
		},
	});
}
console.log(
	"PASS packaged Java/Go/Rust/C++ language services and nested Maven reactor",
);
