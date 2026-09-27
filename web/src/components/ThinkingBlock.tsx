import { useState } from "react";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";
import { useT } from "../i18n";

interface ThinkingBlockProps {
	thinking: string;
	durationMs?: number;
	/** True while the assistant is still streaming this thinking block. */
	streaming?: boolean;
	/** 设置面板「完整显示思考」开关：true（开）→ 思考始终完整展开并自动换行
	 *  （流式推理过程也实时可见）；false（关）→ 折叠成一行摘要，流式中一行
	 *  实时显示最新文本。 */
	wrap?: boolean;
}

export function ThinkingBlock({ thinking, durationMs, streaming, wrap = true }: ThinkingBlockProps) {
	const t = useT();
	// null = 未手动点过 → 跟随开关：wrap=true（开）→ 完整展开；wrap=false（关）→ 折叠。
	// 流式与结束后行为一致——不再出现「流式折叠、结束后又自动展开」的跳动。
	const [open, setOpen] = useState<boolean | null>(null);
	const expanded = open ?? wrap;

	if (streaming) {
		if (!thinking.trim()) return null;
		return expanded ? <div className="thinking open live"><div className="thinking-body">{thinking}</div></div>
			: <div className="thinking live"><button type="button" className="thinking-toggle" onClick={() => setOpen(true)}><FiChevronRight /><span className="thinking-label">{t("thinking")}</span><span className="thinking-live-label">{thinking.trim().split("\n").at(-1)}</span></button></div>;
	}
	return <div className={`thinking ${expanded ? "open" : ""}`}>
		<button type="button" className="thinking-toggle" onClick={() => setOpen(!expanded)}>
			{expanded ? <FiChevronDown /> : <FiChevronRight />}
			<span className="thinking-label">{t("thinking")}</span>
			<span className="thinking-duration">· {durationMs !== undefined ? t("thinkingDuration", { n: Math.max(1, Math.round(durationMs / 1000)) }) : t("thinkingUnrecorded")}</span>
		</button>
		{expanded && <div className="thinking-body">{thinking}</div>}
	</div>;
}
