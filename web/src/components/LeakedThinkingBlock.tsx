import { useState } from "react";
import { FiAlertTriangle, FiChevronDown, FiChevronRight } from "react-icons/fi";
import { useT } from "../i18n";

/**
 * Collapsed-by-default fallback for text blocks that contain a leaked
 * `</think>` marker (see web/src/leaked-thinking.ts for why this can
 * happen). Reuses the `.thinking` / `.thinking-toggle` / `.thinking-body`
 * styling so it reads as the same kind of "secondary, foldable" content as
 * a normal thinking block, just flagged as unexpected instead of expected.
 */
export function LeakedThinkingBlock({ text }: { text: string }) {
	const t = useT();
	const [open, setOpen] = useState(false);

	return (
		<div className={`thinking leaked ${open ? "open" : ""}`}>
			<button type="button" className="thinking-toggle" aria-expanded={open} title={t("leakedThinkingHint")} onClick={() => setOpen(!open)}>
				{open ? <FiChevronDown /> : <FiChevronRight />}
				<FiAlertTriangle className="thinking-icon" />
				<span className="thinking-label">{t("leakedThinking")}</span>
			</button>
			{open && <div className="thinking-body">{text}</div>}
		</div>
	);
}
