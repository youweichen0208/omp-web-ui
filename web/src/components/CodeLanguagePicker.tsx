import { useState } from "react";
import { useT } from "../i18n";
export const WIKI_CODE_LANGUAGES = ["", "bash", "python", "ts", "json", "yaml", "sql", "mermaid"];
export function CodeLanguagePicker({ onInsert }: { onInsert: (language: string) => void }) {
	const t = useT();
	const [query, setQuery] = useState(""), [active, setActive] = useState(-1);
	const languages = WIKI_CODE_LANGUAGES.filter(l => (l || t("wikiCodeAutomatic")).toLowerCase().includes(query.toLowerCase()));
	const descriptions = ["wikiCodeAutomaticHint", "wikiCodeShell", "wikiCodePython", "wikiCodeTypescript", "wikiCodeData", "wikiCodeConfig", "wikiCodeQuery", "wikiCodeDiagram"] as const;
	return <div className="wiki-language-picker" onKeyDown={e => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive(i => languages.length ? (i + (e.key === "ArrowDown" ? 1 : -1) + languages.length) % languages.length : -1); }
		if (e.key === "Enter") { e.preventDefault(); onInsert(languages[active] ?? ""); }
	}}><input autoFocus placeholder={t("wikiSearchLanguage")} aria-label={t("wikiSearchLanguage")} value={query} onChange={e => { setQuery(e.target.value); setActive(-1); }} role="combobox" aria-expanded="true" aria-controls="wiki-code-languages" aria-activedescendant={active >= 0 ? `wiki-code-language-${active}` : undefined} />
		<div id="wiki-code-languages" role="listbox">{languages.map((language, index) => <button type="button" role="option" aria-selected={index === active} id={`wiki-code-language-${index}`} key={language} onMouseEnter={() => setActive(index)} onClick={() => onInsert(language)}><code>{language || t("wikiCodeAutomatic")}</code><small>{t(descriptions[WIKI_CODE_LANGUAGES.indexOf(language)])}</small></button>)}</div>
	</div>;
}
