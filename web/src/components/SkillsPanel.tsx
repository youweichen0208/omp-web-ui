import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { withToken } from "../auth-token";
import { desktopAPI } from "../desktop";
import { getClientId } from "../use-chat";
import type { NativeSkillsState } from "../types";

export function SkillsPanel({ cwd, reload }: { cwd: string; reload: () => void }) {
	const t = useT();
	const [state, setState] = useState<NativeSkillsState>();
	const [query, setQuery] = useState("");
	const [source, setSource] = useState("all");
	const [busy, setBusy] = useState(false), [changed, setChanged] = useState(false), [error, setError] = useState("");
	const alive = useRef(true);
	async function request(action: string, args = {}) {
		setBusy(true); setError("");
		try {
			const response = await fetch(withToken("/api/extensions"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: getClientId(), cwd, action, ...args }) });
			const result = await response.json(); if (!response.ok) throw Error(result.error ?? response.statusText);
			if (alive.current) { setState(result); if (action === "skills-toggle") setChanged(true); }
		} catch (e) { if (alive.current) setError((e as Error).message); }
		finally { if (alive.current) setBusy(false); }
	}
	useEffect(() => { alive.current = true; void request("skills-list"); return () => { alive.current = false; }; }, [cwd]);
	const skills = state?.skills ?? [];
	const visible = skills.filter(skill => (source === "all" || skill.source === source) && `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()));
	const enabled = skills.filter(skill => skill.enabled);
	const tokens = Math.ceil(enabled.filter(skill => skill.promptVisible).reduce((n, skill) => n + skill.name.length + skill.description.length, 0) / 4);
	return <section className="settings-skills">
		<header className="settings-page-heading"><h2 className="settings-page-title">{t("settingsSkills")}</h2><span className="settings-count">{t("v2SkillCount", { n: skills.length, enabled: enabled.length, tokens })}</span><button disabled={!state} onClick={() => void (desktopAPI?.openExtensionPath ? desktopAPI.openExtensionPath({ clientId: getClientId(), cwd, id: "skills:user" }) : navigator.clipboard.writeText(state?.paths.join("\n") ?? "")).catch(e => setError(e.message))}>{t(desktopAPI?.openExtensionPath ? "v2OpenSkills" : "v2CopyPaths")}</button></header>
		<p className="settings-intro">{t("v2SkillsIntro")}</p>
		{error && <p className="settings-error" role="alert">{error} <button disabled={busy} onClick={() => void request("skills-list")}>{t("extRefresh")}</button></p>}
		{changed && <p className="ext-notice" role="status">{t("v2SkillsChanged")} <button disabled={busy} onClick={() => { reload(); setChanged(false); }}>{t("extReload")}</button></p>}
		<div className="skills-filters"><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t("v2SkillSearch")} aria-label={t("v2SkillSearch")} /><div className="settings-segment" role="group" aria-label={t("extScope")}>{(["all", "user", "project", "package"] as const).map(value => <button key={value} aria-pressed={source === value} onClick={() => setSource(value)}>{t(value === "all" ? "v2SkillAll" : value === "user" ? "extPersonal" : value === "project" ? "extProject" : "v2SkillPackage")}</button>)}</div></div>
		<div className="settings-group">{visible.map(skill => <label key={skill.id} className={`settings-skill-row${skill.enabled ? "" : " disabled"}`}><span className="settings-skill-info"><code>{skill.name}</code><small title={skill.description}>{skill.description}</small></span><span className="settings-readonly" title={skill.path}>{t(skill.source === "package" ? "v2SkillPackage" : skill.scope === "project" ? "extProject" : "extPersonal")}</span><input type="checkbox" role="switch" className="settings-switch" aria-label={`${t("extEnable")} ${skill.name}`} checked={skill.enabled} disabled={busy || !skill.canToggle} onChange={e => void request("skills-toggle", { id: skill.id, enabled: e.target.checked, version: state?.version })} /></label>)}{!visible.length && <p className="settings-empty">{t(!state ? "loading" : "extNoResults")}</p>}</div>
		<footer className="settings-paths">{t("v2SkillsPaths")}{state?.paths.map(path => <code key={path}>{path}</code>)}</footer>
	</section>;
}
