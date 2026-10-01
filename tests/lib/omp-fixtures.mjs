import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ompEnvironment, ompRuntimePaths } from "../../dist/server/omp/paths.js";

export function seedOmpSession(cwd, agentDir, text, name) {
	return seedOmpMessages(cwd, agentDir, [{ role: "user", content: text, timestamp: Date.now() }], name);
}

export function seedOmpMessages(cwd, agentDir, messages, name) {
	return JSON.parse(execFileSync(ompRuntimePaths().bun, [fileURLToPath(new URL("../fixtures/omp-session.mjs", import.meta.url))], {
		env: ompEnvironment(agentDir), input: JSON.stringify({ cwd, name, messages }),
		encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"],
	})).path;
}
