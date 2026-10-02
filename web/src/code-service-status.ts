import type { CodeLanguage, CodeState } from "../../server/protocol.js";
export const codeLanguageLabels: Record<CodeLanguage, string> = {
	typescript: "TypeScript / JavaScript",
	python: "Python",
	java: "Java · Maven",
	go: "Go",
	rust: "Rust",
	cpp: "C / C++",
};
export const codeServiceStatusKeys = {
	idle: "codeIdle",
	not_started: "codeLspNotStarted",
	disabled: "codeLspDisabled",
	preparing: "codePreparing",
	initializing: "codeInitializing",
	ready: "codeLspConnected",
	queued: "codeQueued",
	untrusted: "codeUntrusted",
	retrying: "codeRetrying",
	failed: "codeFailed",
	oom: "codeOom",
	missing: "codeMissing",
	installing: "codeInstalling",
	unsupported_gradle: "codeGradleUnsupported",
	unsupported_java: "codeMavenRequired",
} as const;
export function codeServiceRows(state: CodeState) {
	return (Object.keys(codeLanguageLabels) as CodeLanguage[]).map((language) => {
		const service = state.services.find((s) => s.language === language);
		return {
			language,
			service,
			status:
				!state.settings.enabled || !state.settings[language]
					? "disabled"
					: (service?.status ?? "not_started"),
		};
	});
}
export function codeServiceSummary(connected: boolean, state?: CodeState) {
	if (!connected) return { kind: "offline", ready: 0 } as const;
	if (!state) return { kind: "loading", ready: 0 } as const;
	if (!state.settings.enabled) return { kind: "disabled", ready: 0 } as const;
	const rows = codeServiceRows(state).filter((s) => s.status !== "disabled");
	const ready = rows.filter((s) => s.status === "ready").length;
	if (
		rows.some((s) =>
			[
				"untrusted",
				"failed",
				"oom",
				"missing",
				"unsupported_gradle",
				"unsupported_java",
			].includes(s.status),
		)
	)
		return { kind: "attention", ready } as const;
	if (
		rows.some((s) =>
			[
				"preparing",
				"initializing",
				"retrying",
				"queued",
				"installing",
			].includes(s.status),
		)
	)
		return { kind: "starting", ready } as const;
	return { kind: ready ? "ready" : "standby", ready } as const;
}
