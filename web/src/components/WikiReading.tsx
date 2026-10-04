import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";
import type { WikiIndexStatus } from "../types";
import { useI18n, useT } from "../i18n";

export function WikiReadingDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
	const t = useT(), dialog = useRef<HTMLElement>(null);
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		dialog.current?.querySelector<HTMLElement>("button")?.focus();
		return () => { if (previous?.isConnected) previous.focus(); };
	}, []);
	return createPortal(<div className="wiki-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
		<section ref={dialog} className="wiki-reading-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={e => {
			if (e.key === "Escape") { e.stopPropagation(); onClose(); }
			if (e.key !== "Tab") return;
			const items = [...(dialog.current?.querySelectorAll<HTMLElement>("button, input, [tabindex='0']") ?? [])];
			if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)?.focus(); }
			else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0]?.focus(); }
		}}>
			<header><h2>{title}</h2><button aria-label={t("close")} onClick={onClose}><FiX /></button></header>
			{children}
		</section>
	</div>, document.body);
}

export function WikiIndexIndicator({ status }: { status: WikiIndexStatus }) {
	const t = useT(), { locale } = useI18n(), [open, setOpen] = useState(false);
	const reasons = { "file-size": "wikiIndexFileSize", "byte-budget": "wikiIndexBudget", "entry-limit": "wikiIndexEntries", "depth-limit": "wikiIndexDepth", unreadable: "wikiIndexUnreadable" } as const;
	const count = (n: number) => n.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
	const issueCount = status.issues.length;
	const summary = t("wikiIndexStatus", { indexed: count(status.indexed), total: count(status.total) + (status.totalIsLowerBound ? "+" : "") });
	return <>
		<button className={`wiki-index-status ${issueCount ? "limited" : ""}`} onClick={() => setOpen(true)} title={summary}>
			{issueCount > 0 && <i />}<span>{summary}</span>
			{issueCount > 0 && <span className="wiki-index-reason"> · {t("wikiIndexIssueCount", { count: issueCount, reason: t(reasons[status.issues[0].reason]) })}</span>}
		</button>
		{open && <WikiReadingDialog title={summary} onClose={() => setOpen(false)}>
			<p>{t(status.totalIsLowerBound ? "wikiIndexPartial" : issueCount ? "wikiIndexHint" : "wikiIndexComplete")}</p>
			<div className="wiki-index-issues">{status.issues.map((issue, i) => <div key={`${issue.path}:${i}`}>
				<code>{issue.path}</code><span>{issue.size === undefined ? "—" : `${(issue.size / 1024 / 1024).toFixed(2)} MB`}</span>
				<small>{t(reasons[issue.reason])}{issue.subtree ? ` · ${t("wikiIndexSubtree")}` : ""}</small>
			</div>)}</div>
		</WikiReadingDialog>}
	</>;
}

export function WikiTableOfContents({ scroll, contentKey }: { scroll: RefObject<HTMLDivElement>; contentKey: string }) {
	const t = useT();
	const [items, setItems] = useState<{ id: string; text: string }[]>([]), [current, setCurrent] = useState("");
	useEffect(() => {
		const root = scroll.current;
		if (!root) return;
		const headings = [...root.querySelectorAll<HTMLElement>(".wiki-prose h2")];
		headings.forEach((heading, index) => { if (!heading.id) heading.id = `wiki-heading-new-${index}`; });
		setItems(headings.map(h => ({ id: h.id, text: h.textContent ?? "" })));
		const update = () => {
			const top = root.getBoundingClientRect().top + 90;
			let active = headings[0]?.id ?? "";
			for (const heading of root.querySelectorAll<HTMLElement>(".wiki-prose h2[id]")) { if (heading.getBoundingClientRect().top > top) break; active = heading.id; }
			setCurrent(active);
		};
		update(); root.addEventListener("scroll", update, { passive: true });
		const observer = new ResizeObserver(update); observer.observe(root);
		return () => { root.removeEventListener("scroll", update); observer.disconnect(); };
	}, [scroll, contentKey]);
	return items.length ? <nav className="wiki-toc" aria-label={t("wikiOnThisPage")}>
		<h2>{t("wikiOnThisPage")}</h2>
		{items.map(item => <button key={item.id} aria-current={current === item.id ? "location" : undefined} onClick={() => { setCurrent(item.id); [...(scroll.current?.querySelectorAll<HTMLElement>(".wiki-prose h2[id]") ?? [])].find(h => h.id === item.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{item.text}</button>)}
	</nav> : null;
}
