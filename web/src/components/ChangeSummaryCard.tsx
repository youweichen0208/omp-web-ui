import { useState } from "react";
import { FiFile, FiChevronRight } from "react-icons/fi";
import type { ChangedFile } from "../changes";
import { useChanges } from "../changes-context";
import { useT } from "../i18n";

export function ChangeCounts({ files }: { files: Pick<ChangedFile, "added" | "removed" | "counted">[] }) {
	if (!files.some(file => file.counted)) return null;
	const added = files.reduce((n, file) => n + file.added, 0), removed = files.reduce((n, file) => n + file.removed, 0);
	return <span className="change-counts"><span className="add">+{added}</span><span className="del">−{removed}</span></span>;
}
export function ChangeSummaryCard({ files }: { files: ChangedFile[] }) {
	const t = useT(), changes = useChanges();
	const [all, setAll] = useState(false);
	if (!files.length || !changes) return null;
	return <section className="change-summary">
		<header><strong>{t("changesSummary", { n: files.length })}</strong><ChangeCounts files={files} /><button onClick={() => changes.show(files)}>{t("changesViewAll")}</button></header>
		{(all ? files : files.slice(0, 6)).map(file => <button key={file.path} className={`change-summary-file ${changes.open && changes.selected === file.path ? "selected" : ""}`} onClick={() => changes.show(files, file.path)}>
			<FiFile /><code>{file.path.split("/").at(-1)}</code><span className="change-directory">{file.path.split("/").slice(0, -1).join("/")}</span><ChangeCounts files={[file]} /><FiChevronRight />
		</button>)}
		{!all && files.length > 6 && <button className="changes-more" onClick={() => setAll(true)}>{t("changesMore", { n: files.length - 6 })}</button>}
	</section>;
}
