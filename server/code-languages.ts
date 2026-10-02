import type { CodeLanguage, CodeSettings } from "./protocol.js";
export const codeLanguages: CodeLanguage[] = [
	"typescript",
	"python",
	"java",
	"go",
	"rust",
	"cpp",
];
export const nativeLanguages = ["java", "go", "rust", "cpp"] as const;
export type NativeCodeLanguage = (typeof nativeLanguages)[number];
export const isNativeLanguage = (
	language: CodeLanguage,
): language is NativeCodeLanguage =>
	nativeLanguages.includes(language as NativeCodeLanguage);
export function languageOf(path: string): CodeLanguage | undefined {
	const extension = path.split(".").at(-1)?.toLowerCase();
	if (/^(?:[cm]?[jt]s|[jt]sx)$/.test(extension ?? "")) return "typescript";
	return (
		{
			py: "python",
			java: "java",
			go: "go",
			rs: "rust",
			c: "cpp",
			h: "cpp",
			cc: "cpp",
			cpp: "cpp",
			cxx: "cpp",
			hpp: "cpp",
			hh: "cpp",
			hxx: "cpp",
			m: "cpp",
			mm: "cpp",
		} as Record<string, CodeLanguage>
	)[extension ?? ""];
}
export function documentLanguage(path: string): string {
	const language = languageOf(path);
	if (language === "typescript")
		return /tsx$/i.test(path)
			? "typescriptreact"
			: /jsx$/i.test(path)
				? "javascriptreact"
				: /\.[cm]?ts$/i.test(path)
					? "typescript"
					: "javascript";
	if (language === "cpp")
		return /\.m$/i.test(path)
			? "objective-c"
			: /\.mm$/i.test(path)
				? "objective-cpp"
				: /\.[ch]$/i.test(path)
					? "c"
					: "cpp";
	return language ?? "plaintext";
}
export const serverSettings = (
	language: CodeLanguage,
	settings: CodeSettings,
): Record<string, unknown> => {
	if (language === "python")
		return {
			python: {
				pythonPath: settings.pythonPath || undefined,
				analysis: { diagnosticMode: "openFilesOnly" },
			},
		};
	if (language === "java")
		return {
			java: {
				autobuild: { enabled: true },
				configuration: {
					updateBuildConfiguration: "automatic",
					maven: {
						userSettings: settings.mavenUserSettings || null,
						globalSettings: settings.mavenGlobalSettings || null,
					},
					runtimes: (["8", "17"] as const).flatMap((version) => {
						const path = settings.javaProjectHomes?.[version];
						return path
							? [{ name: version === "8" ? "JavaSE-1.8" : "JavaSE-17", path }]
							: [];
					}),
				},
				import: {
					gradle: { enabled: false },
					maven: { enabled: true },
				},
			},
		};

	if (language === "rust")
		return {
			"rust-analyzer": {
				cargo: { buildScripts: { enable: false } },
				procMacro: { enable: false },
				checkOnSave: false,
				files: { watcher: "server" },
			},
		};
	if (language === "go")
		return {
			gopls: {
				buildFlags: ["-mod=readonly"],
				env: { GOTOOLCHAIN: "local" },
				staticcheck: false,
			},
		};
	return {};
};

export function rustAnalysisLimitation(
	code: string | number | undefined,
	message: string,
): boolean {
	return (
		code === "unresolved-proc-macro" ||
		code === "proc-macro-disabled" ||
		((code === "macro-error" || code === "unimplemented-builtin-macro") &&
			/proc.?macro|not expanded|disabled|OUT_DIR/i.test(message))
	);
}
