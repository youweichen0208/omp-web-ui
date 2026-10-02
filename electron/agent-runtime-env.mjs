/** The server and its built-in workers use the current Electron executable. */
export function agentRuntimeEnvironment(_pkgRoot, _dataDir, _executable = process.execPath) {
	return { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
}
