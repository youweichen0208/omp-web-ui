/**
 * One-time cleanup of the launchd agent installed by releases before 1.0.
 *
 * Old releases registered the default macOS service under a label inherited from
 * the upstream project. It is not kept: commands that rewrite or remove the service
 * (install, uninstall) delete the old agent; commands that only operate on it
 * (start, stop, restart, status, shortcut) move its existing configuration to the
 * current label first, so a running auto-start setup survives the upgrade.
 */
export const LEGACY_LAUNCHD_LABEL = ["com", "xingshuyin", "pi-web-ui"].join(".");

/** Replace the Label value of a launchd plist; null when the label is not found. */
export function relabelPlist(content, from, to) {
	const pattern = new RegExp(`(<key>Label</key>\\s*<string>)${from.replace(/[.]/g, "\\.")}(</string>)`);
	return pattern.test(content) ? content.replace(pattern, `$1${to}$2`) : null;
}

/**
 * Plan the cleanup for one command. `migrate` keeps the old configuration under the
 * new label; otherwise the old agent is only removed.
 */
export function legacyLaunchdPlan({ legacyExists, targetExists, action }) {
	if (!legacyExists) return "none";
	if (action === "install" || action === "uninstall" || targetExists) return "remove";
	return "migrate";
}
