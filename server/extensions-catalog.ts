import type { ExtensionCatalog, ExtensionCatalogItem } from "./protocol.js";
const cache = new Map<string, { until: number; value: Promise<any> }>();
export async function cachedFetch(url: string, json = true): Promise<any> {
	const old = cache.get(url); if (old && old.until > Date.now()) return old.value;
	const value = (async () => { const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { Accept: json ? "application/json" : "text/html" } }); if (!response.ok) throw Error(`Package catalog: HTTP ${response.status}`); const text = await response.text(); if (text.length > 8_000_000) throw Error("Catalog response too large"); return json ? JSON.parse(text) : text; })();
	cache.set(url, { until: Date.now() + 300000, value }); if (cache.size > 128) cache.delete(cache.keys().next().value!);
	try { return await value; } catch (error) { cache.delete(url); throw error; }
}
export function safeUrl(value: unknown): string | undefined { if (typeof value !== "string") return; try { const u = new URL(value.replace(/^git\+/, "")); if (["https:", "http:"].includes(u.protocol) && !u.username && !u.password) return u.href; } catch {} }
const decode = (text: string) => text.replace(/&(?:amp|quot|lt|gt|apos|#39|#x[0-9a-f]+|#\d+);/gi, entity => ({ "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&apos;": "'", "&#39;": "'" }[entity] ?? String.fromCodePoint(Number(entity.startsWith("&#x") ? `0x${entity.slice(3,-1)}` : entity.slice(2,-1)))));
const plain = (s: string) => decode(s.replace(/<[^>]*>/g, "")).trim();
/** Pi currently serves its catalog as HTML. Extract only data attributes/text, never render remote HTML. */
export function parseCatalog(html: string, page: number): ExtensionCatalog {
	const items: ExtensionCatalogItem[] = [];
	for (const match of html.matchAll(/<article\b[^>]*data-package-card="true"[\s\S]*?<\/article>/g)) {
		const text = match[0], attr = (name: string) => decode(new RegExp(`${name}="([^"]*)"`).exec(text)?.[1] ?? "");
		const name = attr("data-package-name"); if (!name) continue;
		const meta = /class="packages-meta">([\s\S]*?)<\/div>/.exec(text)?.[1] ?? "";
		items.push({ name, description: plain(/class="packages-desc">([\s\S]*?)<\/p>/.exec(text)?.[1] ?? ""), author: plain(/<span>(.*?)<\/span>/.exec(meta)?.[1] ?? ""), downloads: Number(attr("data-package-downloads")) || 0, date: Number(attr("data-package-date")) || undefined, types: attr("data-package-types").split(/[ ,]+/).filter(Boolean), url: `https://pi.dev/packages/${name}`, version: /package-version=([^"&]+)/.exec(text)?.[1], image: safeUrl(/<img[^>]*src="([^"]+)"/.exec(text)?.[1]), repository: safeUrl(/href="(https:\/\/github.com\/(?!earendil-works\/pi\/issues)[^"]+)"/.exec(text)?.[1]) });
	}
	if (!items.length && !/packages-grid|No packages|No results/i.test(html)) throw Error("Pi catalog format changed; open pi.dev/packages");
	const pages = Math.max(page, ...[...html.matchAll(/[?&](?:amp;)?page=(\d+)/g)].map(m => Number(m[1])));
	return { items, page, pages };
}
export async function browseCatalog(query: string, type: string, sort: string, page: number) {
	const params = new URLSearchParams({ name: query.slice(0,200), type: ["extension","skill","prompt","theme"].includes(type) ? type : "", sort: sort === "recent" ? "recent" : "downloads", page: String(Math.max(1,Math.min(1000,page))) });
	return parseCatalog(await cachedFetch(`https://pi.dev/packages?${params}`, false), page);
}

export async function packageReleaseNotes(name: string): Promise<{ title: string; notes: string[]; url?: string }> {
	const meta = await cachedFetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
	const repository = safeUrl(typeof meta.repository === "string" ? meta.repository : meta.repository?.url);
	const match = repository && /^https:\/\/github.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repository);
	if (!match) return { title: meta.version ?? "", notes: [] };
	try {
		const release = await cachedFetch(`https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest`);
		const notes = typeof release.body === "string" ? release.body.split("\n").map((line: string) => line.trim()).filter((line: string) => /^[-*] /.test(line)).slice(0,3).map((line: string) => line.slice(2,800)) : [];
		return { title: String(release.tag_name ?? meta.version), notes, url: safeUrl(release.html_url) };
	} catch { return { title: meta.version ?? "", notes: [], url: `${repository?.replace(/\.git$/,"")}/releases` }; }
}
