import { useT } from "../i18n";
import type { ModelInfo } from "../types";
export interface ToolRecoveryActions {
	messageId?: string;
	kind?: "text" | "stopped";
	disabled: boolean;
	models: ModelInfo[];
	onLoadModels: () => void;
	retry: (modelId?: string) => void;
}
export function ToolRecoveryCard({ raw, model, recovery, stopped = false }: { raw?: string; model: string; recovery?: ToolRecoveryActions; stopped?: boolean }) {
	const t = useT();
	return <div className="unexecuted-tool" role="status">
		<strong>✗ {t(stopped ? "toolStoppedTitle" : "unexecutedToolTitle")}</strong>
		<p>{t(stopped ? "toolStoppedHint" : "unexecutedToolHint", { model })}</p>
		{recovery && <div className="tool-recovery-actions">
			<button type="button" className="tool-recovery-primary" disabled={recovery.disabled} onClick={() => recovery.retry()}>{t("toolRecoveryResend")}</button>
			<select aria-label={t("toolRecoveryModel")} disabled={recovery.disabled} value="" onFocus={recovery.onLoadModels} onClick={recovery.onLoadModels} onChange={event => { if (event.target.value) recovery.retry(event.target.value); }}>
				<option value="">{t("toolRecoveryModel")}</option>
				{recovery.models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.provider}</option>)}
			</select>
		</div>}
		{raw && <details><summary>{t("unexecutedToolOriginal")}</summary><pre>{raw}</pre></details>}
	</div>;
}
