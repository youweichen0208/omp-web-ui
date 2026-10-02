import { useEffect, useRef, useState } from "react";
import type {
	ClientMessage,
	ServerMessage,
	CodeState,
	CodeSettings,
} from "../types";
import { randomUuid } from "../uuid";
import { useT } from "../i18n";
import { CodeServiceStatus } from "./CodeServiceStatus";
export function CodePanel({
	cwd,
	send,
	settings = false,
	onPreview,
}: {
	cwd: string;
	send: (message: ClientMessage) => boolean;
	settings?: boolean;
	onPreview?: (path: string, name: string) => void;
}) {
	const t = useT();
	const statuses: Record<string, string> = {
		unsupported_gradle: t("codeGradleUnsupported"),
		unsupported_java: t("codeMavenRequired"),
		idle: t("codeIdle"),
		preparing: t("codePreparing"),
		initializing: t("codeInitializing"),
		ready: t("codeReady"),
		queued: t("codeQueued"),
		untrusted: t("codeUntrusted"),
		retrying: t("codeRetrying"),
		failed: t("codeFailed"),
		oom: t("codeOom"),
		fresh: t("codeFresh"),
		partial: t("codePartialResult"),
		stale: t("codeStale"),
		pending: t("codePending"),
		unavailable: t("codeUnavailable"),
		missing: t("codeMissing"),
		installing: t("codeInstalling"),
	};
	const [state, setState] = useState<CodeState>();
	const [draft, setDraft] = useState<CodeSettings>();
	const [error, setError] = useState("");
	const [filter, setFilter] = useState("");
	const [installing, setInstalling] = useState<string>();
	const pending = useRef(new Map<string, { action: string; at: number }>());
	const request = (
		action: "state" | "settings" | "restart" | "install",
		value?: CodeSettings,
		language?: "java" | "go" | "rust" | "cpp",
	) => {
		if (action === "install") setInstalling(language);
		const requestId = randomUuid();
		pending.current.set(requestId, { action, at: Date.now() });
		if (
			!send({
				type: "code_request",
				cwd,
				requestId,
				action,
				settings: value,
				language,
			})
		) {
			pending.current.delete(requestId);
			setError(t("imageDisconnected"));
			if (action === "install") setInstalling(undefined);
		}
	};
	useEffect(() => {
		pending.current.clear();
		setInstalling(undefined);
		setState(undefined);
		setDraft(undefined);
		setError("");
		const receive = (event: Event) => {
			const msg = (
				event as CustomEvent<
					Extract<ServerMessage, { type: "code_result" | "code_state" }>
				>
			).detail;
			if (msg.cwd !== cwd) return;
			if (msg.type === "code_state") {
				setState(msg.state);
				setDraft((previous) => previous ?? msg.state.settings);
				return;
			}
			if (!pending.current.has(msg.requestId)) return;
			const action = pending.current.get(msg.requestId)?.action;
			pending.current.delete(msg.requestId);
			if (action === "install") setInstalling(undefined);
			setError(msg.error ?? "");
			if (msg.state) {
				setState(msg.state);
				setDraft((previous) =>
					action === "settings" || !previous ? msg.state!.settings : previous,
				);
			}
		};
		window.addEventListener("pi-code-event", receive);
		request("state");
		const timer = setInterval(() => {
			for (const [id, entry] of pending.current)
				if (
					Date.now() - entry.at >
					(entry.action === "install" ? 1900000 : 10000)
				)
					pending.current.delete(id);
			if (document.visibilityState !== "hidden" && pending.current.size < 2)
				request("state");
		}, 3000);
		return () => {
			clearInterval(timer);
			window.removeEventListener("pi-code-event", receive);
		};
	}, [cwd, send]);
	return (
		<div className="code-panel">
			{error && <p role="alert">{error}</p>}
			<div className="code-actions">
				<strong>{t("codeIntelligence")}</strong>
				<button type="button" onClick={() => request("state")}>
					{t("codeRefresh")}
				</button>
			</div>
			{state && (
				<>
					<p className="code-coverage">
						{t("codeCoverage", {
							n: state.services.reduce((n, s) => n + s.checkedFiles, 0),
						})}
					</p>
					<p className="code-coverage">
						{state.toolchainVersion}
						{state.projectTsVersion &&
							` · ${t("codeProjectTs")}: ${state.projectTsVersion}`}
					</p>
					{!state.trusted && <p>{t("codeTrustRequired")}</p>}
					{state.settings.rust && (
						<p className="code-coverage">{t("codeRustCoverage")}</p>
					)}
					<p className="code-coverage">{t("codeNativeResourceHint")}</p>
					<CodeServiceStatus state={state} />
					{state.watcherPartial && <p>{t("codePartial")}</p>}
					{settings && draft && (
						<div className="code-settings">
							{(["enabled", "typescript", "python", "feedback"] as const).map(
								(key) => (
									<label key={key}>
										<input
											type="checkbox"
											checked={draft[key]}
											onChange={(event) =>
												setDraft({ ...draft, [key]: event.target.checked })
											}
										/>
										{t(
											key === "enabled"
												? "codeEnabled"
												: key === "typescript"
													? "codeTs"
													: key === "python"
														? "codePython"
														: "codeFeedback",
										)}
									</label>
								),
							)}
							<label>
								{t("codePythonPath")}
								<input
									value={draft.pythonPath}
									onChange={(event) =>
										setDraft({ ...draft, pythonPath: event.target.value })
									}
								/>
							</label>
							{(["tsMemoryMiB", "pythonMemoryMiB"] as const).map((key) => (
								<label key={key}>
									{key === "tsMemoryMiB" ? "TypeScript" : "Python"}{" "}
									{t("codeHeap")}
									<input
										type="number"
										min={512}
										max={8192}
										value={draft[key]}
										onChange={(event) =>
											setDraft({ ...draft, [key]: Number(event.target.value) })
										}
									/>
								</label>
							))}
							<p>{t("codeNativeHint")}</p>
							{(["java", "go", "rust", "cpp"] as const).map((language) => (
								<div key={language} className="code-native-setting">
									<label>
										<input
											type="checkbox"
											checked={draft[language] ?? true}
											onChange={(event) =>
												setDraft({ ...draft, [language]: event.target.checked })
											}
										/>
										{
											{ java: "Java", go: "Go", rust: "Rust", cpp: "C / C++" }[
												language
											]
										}
									</label>
									<label>
										{language === "java"
											? t("codeJdtPath")
											: t("codeServerPath")}
										<input
											value={draft.nativePaths?.[language] ?? ""}
											placeholder={t("codeAutoDetect")}
											onChange={(event) =>
												setDraft({
													...draft,
													nativePaths: {
														...draft.nativePaths,
														[language]: event.target.value,
													},
												})
											}
										/>
									</label>
									<button
										type="button"
										disabled={!!installing}
										onClick={() => request("install", undefined, language)}
									>
										{installing === language
											? t("codeInstalling")
											: t("codeInstallTool", {
													language: {
														java: "Java",
														go: "Go",
														rust: "Rust",
														cpp: "C/C++",
													}[language],
												})}
									</button>
								</div>
							))}
							<label>
								{t("codeJavaHome")}
								<input
									value={draft.javaHome ?? ""}
									placeholder={t("codeAutoDetect")}
									onChange={(event) =>
										setDraft({ ...draft, javaHome: event.target.value })
									}
								/>
							</label>
							{(["8", "17"] as const).map((version) => (
								<label key={version}>
									{t("codeJavaProjectHome", { version })}
									<input
										value={draft.javaProjectHomes?.[version] ?? ""}
										placeholder={t("codeJavaProjectOptional")}
										onChange={(event) =>
											setDraft({
												...draft,
												javaProjectHomes: {
													...draft.javaProjectHomes,
													[version]: event.target.value,
												},
											})
										}
									/>
								</label>
							))}
							<p>{t("codeJavaRuntimeHint")}</p>
							{(["mavenUserSettings", "mavenGlobalSettings"] as const).map(
								(key) => (
									<label key={key}>
										{t(
											key === "mavenUserSettings"
												? "codeMavenUserSettings"
												: "codeMavenGlobalSettings",
										)}
										<input
											value={draft[key] ?? ""}
											placeholder={t("codeMavenSettingsOptional")}
											onChange={(event) =>
												setDraft({ ...draft, [key]: event.target.value })
											}
										/>
									</label>
								),
							)}
							<p>{t("codeMavenSettingsHint")}</p>
							<label>
								{t("codeNativeMemory")}
								<input
									type="number"
									min={512}
									max={8192}
									value={draft.nativeMemoryMiB ?? 1024}
									onChange={(event) =>
										setDraft({
											...draft,
											nativeMemoryMiB: Number(event.target.value),
										})
									}
								/>
							</label>

							<button type="button" onClick={() => request("settings", draft)}>
								{t("codeSave")}
							</button>
							<button type="button" onClick={() => request("restart")}>
								{t("codeRestart")}
							</button>
						</div>
					)}
					<input
						aria-label={t("codeFilter")}
						placeholder={t("codeFilter")}
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
					/>
					<div className="code-problems">
						{state.diagnostics
							.filter((d) =>
								`${d.path} ${d.message}`
									.toLowerCase()
									.includes(filter.toLowerCase()),
							)
							.map((d, index) => (
								<button
									type="button"
									className="code-problem"
									key={`${d.path}:${d.line}:${index}`}
									onClick={() =>
										window.dispatchEvent(
											new CustomEvent("pi-web-ui:open-tool-file", {
												detail: { cwd, path: d.path, line: d.line },
											}),
										)
									}
								>
									<strong>
										{d.path}:{d.line}:{d.column}
									</strong>
									<span>
										{d.analysisLimitation
											? t("codeAnalysisLimitation")
											: d.severity === 1
												? "●"
												: "▲"}{" "}
										{d.message}
									</span>
									<small>{statuses[d.freshness] ?? d.freshness}</small>
								</button>
							))}
					</div>
				</>
			)}
		</div>
	);
}
