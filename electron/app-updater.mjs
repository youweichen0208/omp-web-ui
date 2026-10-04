/** Fixed update operations; never accepts package names or URLs from the renderer. */
export function createAppUpdater({ updater, version, supported, publish, confirmInstall }) {
	let state = { phase: supported ? "idle" : "unsupported", current: version };
	let pending;
	const update = patch => { state = { ...state, ...patch }; publish({ ...state }); };
	updater.autoDownload = false;
	updater.autoInstallOnAppQuit = false;
	updater.on("checking-for-update", () => update({ phase: "checking", error: undefined }));
	updater.on("update-available", info => update({ phase: "available", latest: info.version, error: undefined }));
	updater.on("update-not-available", () => update({ phase: "current", latest: undefined, error: undefined }));
	updater.on("download-progress", progress => update({ phase: "downloading", percent: Math.round(progress.percent) }));
	updater.on("update-downloaded", info => update({ phase: "downloaded", latest: info.version, percent: 100 }));
	updater.on("error", error => update({ phase: "error", error: error.message }));

	async function run(action) {
		if (!["read", "check", "update", "install"].includes(action)) throw Error("Invalid update action");
		if (action === "read" || !supported) return { ...state };
		if (pending) { await pending; return { ...state }; }
		if (action === "install" && state.phase !== "downloaded") throw Error("Update has not been downloaded");
		if (action !== "install" && state.phase === "downloaded") return { ...state };
		pending = (async () => {
			try {
				if (action === "install") {
					if (await confirmInstall()) updater.quitAndInstall();
					return;
				}
				if (action === "check" || state.phase !== "available") await updater.checkForUpdates();
				if (action === "update" && state.phase === "available") {
					update({ phase: "downloading", percent: 0, error: undefined });
					await updater.downloadUpdate();
				}
			} catch (error) { update({ phase: "error", error: error.message }); }
		})();
		try { await pending; } finally { pending = undefined; }
		return { ...state };
	}
	return { run };
}
