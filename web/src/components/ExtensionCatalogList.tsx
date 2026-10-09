import { UiIcon } from "./UiIcon";
import { useEffect, useState } from "react";
import { useI18n, useT } from "../i18n";
import type { ExtensionCatalog, ExtensionCatalogItem, ExtensionPackage, ExtensionPackageDetails } from "../types";
import { catalogInstallation, extensionDate, extensionDownloads } from "../extensions-presentation";

export const extensionResourceKeys = { extensions: "extTypeExtension", skills: "extTypeSkill", prompts: "extTypePrompt", themes: "extTypeTheme" } as const;
export function ExtensionCatalogList({ catalog, packages, working, inspect, update, details }: {
	catalog?: ExtensionCatalog; packages: ExtensionPackage[]; working: boolean;
	inspect: (source: string) => void; update: (item: ExtensionPackage) => void;
	details: (source: string, signal: AbortSignal) => Promise<ExtensionPackageDetails>;
}) {
	const t = useT(), { locale } = useI18n();
	const [expanded, setExpanded] = useState<string>();
	const [info, setInfo] = useState<ExtensionPackageDetails>(), [error, setError] = useState("");
	const [retry, setRetry] = useState(0);
	useEffect(() => {
		setInfo(undefined); setError(""); if (!expanded) return;
		const abort = new AbortController();
		void details(`npm:${expanded}`, abort.signal).then(value => { if (!abort.signal.aborted) setInfo(value); }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
		return () => abort.abort();
	}, [expanded, retry, details]);
	const meta = (item: ExtensionCatalogItem) => [item.author, item.version && `v${item.version}`, extensionDownloads(item.downloads, locale), extensionDate(item.date, locale)].filter(Boolean).join(" · ");
	return <>
		<div className="ext-catalog-list">{catalog?.items.map(item => {
			const installed = catalogInstallation(packages, item.name), open = expanded === item.name;
			const updatable = !!installed?.update && installed.trusted && !installed.protected && !installed.pinned;
			const description = locale === "zh" && item.descriptionZh ? item.descriptionZh : item.description;
			return <article className={`ext-catalog-row ${open ? "expanded" : ""}`} key={item.name}>
				<div className="ext-catalog-line">
					<button className="ext-catalog-expand" aria-expanded={open} aria-label={`${t("extDetails")} ${item.name}`} onClick={() => setExpanded(open ? undefined : item.name)}>
						<span className="ext-catalog-identity"><strong title={item.name}>{item.name}</strong><small title={meta(item)}>{meta(item)}</small></span>
						<span className="ext-catalog-summary" title={description}>{description}</span>
					</button>
					<button className={`ext-catalog-action ${updatable ? "update" : installed ? "installed" : "install"}`} disabled={working || !!installed && !updatable} onClick={() => updatable ? update(installed!) : inspect(`npm:${item.name}`)}>{t(installed ? updatable ? "extUpdate" : "extInstalled" : "extInstall")}</button>
				</div>
				{open && <div className="ext-catalog-detail">
					<div><p>{info?.description || item.description}</p>{info ? <div className="ext-resource-counts">{Object.entries(extensionResourceKeys).filter(([key]) => info.resources[key]?.length).map(([key, label]) => <span key={key}>{t(label)} {info.resources[key].length}</span>)}{!Object.values(info.resources).some(values => values.length) && <span>{t("extResourcesUnknown")}</span>}</div> : error ? <p role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>{t("extRetry")}</button></p> : <small role="status">{t("loading")}</small>}</div>
					<aside><code>npm:{item.name}</code><span>{info?.license || (info ? t("extLicenseUnknown") : "")}</span>{(info?.repository || item.repository) && <a href={info?.repository || item.repository} target="_blank" rel="noreferrer">{t("extViewSource")} <UiIcon name="external" /></a>}<a href={item.url} target="_blank" rel="noreferrer">{t("extCatalogPage")} <UiIcon name="external" /></a></aside>
				</div>}
			</article>;
		})}</div>
		{catalog && <p className="ext-catalog-origin">{t(catalog.total === undefined ? "extCatalogOriginPage" : "extCatalogOrigin", { count: (catalog.total ?? catalog.items.length).toLocaleString(locale === "zh" ? "zh-CN" : "en-US") })}</p>}
	</>;
}
