import type { CodeState } from "../types";
import { useT } from "../i18n";
import {
	codeLanguageLabels,
	codeServiceRows,
	codeServiceStatusKeys,
} from "../code-service-status";
export function CodeServiceStatus({ state }: { state: CodeState }) {
	const t = useT();
	return (
		<div className="code-service-list" aria-label={t("codeLspServers")}>
			{codeServiceRows(state).map(({ language, service, status }) => {
				const key =
					codeServiceStatusKeys[status as keyof typeof codeServiceStatusKeys] ??
					"codeUnavailable";
				const tone =
					status === "ready"
						? "ok"
						: [
									"missing",
									"failed",
									"oom",
									"untrusted",
									"unsupported_gradle",
									"unsupported_java",
							  ].includes(status)
							? "warn"
							: "muted";
				const hint =
					status === "missing"
						? "codeLspMissingHint"
						: status === "untrusted"
							? "codeTrustRequired"
							: status === "oom"
								? "codeLspOomHint"
								: status === "failed"
									? "codeLspFailedHint"
									: status === "not_started" || status === "idle"
										? "codeLspStandbyHint"
										: status === "disabled"
											? "codeLspDisabledHint"
											: [
														"initializing",
														"preparing",
														"retrying",
														"queued",
														"installing",
												  ].includes(status)
												? "codeLspStartingHint"
												: undefined;
				return (
					<div className={`code-service-card ${tone}`} key={language}>
						<div className="code-service-heading">
							<strong>{codeLanguageLabels[language]}</strong>
							<span>
								<i className="code-service-dot" aria-hidden="true" />
								{t(key)}
							</span>
						</div>
						{hint && <p>{t(hint)}</p>}
						{service && status !== "disabled" && (
							<small>
								{service.rssMiB > 0
									? `${service.rssMiB} MiB RSS`
									: t("codeLspMemoryPending")}{" "}
								·{" "}
								{t("codeLspChecked", {
									n: service.checkedFiles,
									pending: service.pendingFiles,
								})}
							</small>
						)}
						{service && status !== "disabled" && service.heapMiB > 0 && (
							<small>{t("codeLspMemoryTarget", { n: service.heapMiB })}</small>
						)}
						{service?.rssMiB && service.rssMiB >= 1024 ? (
							<p role="status">{t("codeHighMemory", { n: service.rssMiB })}</p>
						) : null}
						{service?.error && status !== "disabled" && (
							<details>
								<summary>{t("codeLspDetails")}</summary>
								<p className="code-service-error">{service.error}</p>
							</details>
						)}
					</div>
				);
			})}
			<p className="code-service-caption">{t("codeLspConnectedHint")}</p>
		</div>
	);
}
