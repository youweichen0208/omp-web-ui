import type { ExtensionPackage } from "../../server/protocol.js";
export function extensionDownloads(value: number | undefined, locale: "zh" | "en") {
	if (value === undefined || !Number.isFinite(value)) return "—";
	if (locale === "zh") return value >= 10000 ? `${Number((value / 10000).toFixed(value >= 100000 ? 0 : 1))} 万 / 月` : `${value.toLocaleString("zh-CN")} / 月`;
	return `${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value)} / mo`;
}
export function extensionDate(value: number | undefined, locale: "zh" | "en", now = Date.now()) {
	if (!value || !Number.isFinite(value)) return "";
	const date = new Date(value), today = new Date(now);
	const days = Math.max(0, Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000));
	if (days <= 1) return locale === "zh" ? days ? "昨天" : "今天" : days ? "Yesterday" : "Today";
	if (days < 7) return locale === "zh" ? `${days} 天前` : `${days} days ago`;
	if (days <= 30) { const weeks = Math.floor(days / 7); return locale === "zh" ? `${weeks} 周前` : `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`; }
	return date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US");
}
/** Match native declarations, never infer update eligibility from registry/latest. */
export function catalogInstallation(packages: ExtensionPackage[], name: string) {
	const matches = packages.filter(p => p.kind === "npm" && p.name === name);
	return matches.find(p => p.update && p.trusted && !p.protected && !p.pinned) ?? matches[0];
}
